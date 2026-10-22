import { createMap, glyph } from "./map.js";

const STATES = ["blocked", "running", "waiting", "failed", "unknown", "completed", "cancelled", "idle"];
const STATE_LABEL = {
  blocked: "Needs you",
  running: "Running",
  waiting: "Waiting",
  failed: "Failed",
  unknown: "Unknown",
  completed: "Completed",
  cancelled: "Stopped",
  idle: "Idle",
};
const ACTIVE = new Set(["running", "waiting", "blocked"]);
const WINDOW_MS = { "1h": 3600e3, "24h": 86400e3, "7d": 7 * 86400e3 };
const RANK = Object.fromEntries(STATES.map((state, index) => [state, index]));

const servers = new Map();
const agents = new Map();
let history = [];
let usage = [];
let selectedKey = null;
let drawerTimer = null;

const saved = JSON.parse(localStorage.getItem("t3fleet.filters") ?? "{}");
const filters = {
  q: "",
  window: saved.window ?? "24h",
  server: saved.server ?? "",
  provider: saved.provider ?? "",
  project: saved.project ?? "",
  states: new Set(saved.states ?? []),
};
let view = saved.view ?? "map";
/** Map cards unfolded past their tile limit. */
const expanded = new Set();

const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ---- live data ----------------------------------------------------------------------------------

function applyState(state) {
  servers.clear();
  agents.clear();
  for (const server of state.servers) servers.set(server.id, server);
  for (const agent of state.agents) agents.set(agent.key, agent);
  history = state.history;
  usage = state.usage ?? [];
  setConn(true);
  scheduleRender();
}

/** ?poll fetches full state instead of streaming, for proxies (and headless tools) that break SSE. */
async function poll() {
  try {
    const response = await fetch("/api/state");
    applyState(await response.json());
  } catch {
    setConn(false);
  }
  setTimeout(poll, 3000);
}

function connect() {
  if (new URLSearchParams(location.search).has("poll")) return poll();
  const source = new EventSource("/api/events");
  source.addEventListener("state", (event) => applyState(JSON.parse(event.data)));
  source.addEventListener("patch", (event) => {
    const patch = JSON.parse(event.data);
    if (patch.servers) for (const server of patch.servers) servers.set(server.id, server);
    for (const agent of patch.upserts) agents.set(agent.key, agent);
    for (const key of patch.removals) agents.delete(key);
    if (patch.usage) usage = patch.usage;
    if (patch.history.length) history = history.concat(patch.history).slice(-500);
    scheduleRender();
  });
  source.onerror = () => setConn(false);
}

function setConn(ok) {
  const el = $("conn");
  el.textContent = ok ? "live" : "reconnecting…";
  el.className = `conn ${ok ? "ok" : "bad"}`;
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

// ---- filtering ----------------------------------------------------------------------------------

function inWindow(agent, now) {
  if (ACTIVE.has(agent.state)) return true;
  if (filters.window === "active") return false;
  if (filters.window === "all") return true;
  return now - Date.parse(agent.updatedAt) <= WINDOW_MS[filters.window];
}

function matches(agent, now) {
  if (!inWindow(agent, now)) return false;
  if (filters.server && agent.serverId !== filters.server) return false;
  if (filters.provider && agent.provider !== filters.provider) return false;
  if (filters.project && (agent.projectTitle ?? "No project") !== filters.project) return false;
  if (filters.states.size && !filters.states.has(agent.state)) return false;
  if (filters.q) {
    const hay = [agent.title, agent.projectTitle, agent.branch, agent.cwd, agent.provider, agent.model, agent.activity?.label, agent.activity?.detail, agent.threadId]
      .join(" ")
      .toLowerCase();
    if (!filters.q.split(/\s+/).every((word) => hay.includes(word))) return false;
  }
  return true;
}

function sortAgents(list) {
  return list.sort((a, b) => RANK[a.state] - RANK[b.state] || b.updatedAt.localeCompare(a.updatedAt));
}

// ---- rendering ----------------------------------------------------------------------------------

function render() {
  const now = Date.now();
  renderStats();
  renderUsage();
  renderFilterOptions();

  const matched = new Set();
  for (const agent of agents.values()) if (matches(agent, now)) matched.add(agent.key);
  // Keep ancestors of matches so every agent is shown in its tree.
  const shown = new Set(matched);
  for (const key of matched) {
    let parent = agents.get(key)?.parentKey;
    for (let depth = 0; parent && agents.has(parent) && depth < 20; depth++) {
      shown.add(parent);
      parent = agents.get(parent).parentKey;
    }
  }
  const children = new Map();
  const roots = [];
  for (const key of shown) {
    const agent = agents.get(key);
    if (agent.parentKey && shown.has(agent.parentKey)) {
      if (!children.has(agent.parentKey)) children.set(agent.parentKey, []);
      children.get(agent.parentKey).push(agent);
    } else roots.push(agent);
  }

  for (const button of document.querySelectorAll("[data-view]")) button.classList.toggle("on", button.dataset.view === view);
  $("map").hidden = view !== "map";
  $("fleet").hidden = view !== "list";
  if (view === "map") {
    const visibleServers = [...servers.values()].filter((server) => !filters.server || server.id === filters.server);
    map.render({ agents, servers: visibleServers, shown, matched, children, selectedKey, now, expanded });
    renderHistory();
    return;
  }

  const html = [];
  const serverList = [...servers.values()].filter((server) => !filters.server || server.id === filters.server);
  for (const server of serverList) {
    const serverRoots = roots.filter((agent) => agent.serverId === server.id);
    const projects = new Map();
    for (const agent of serverRoots) {
      const name = agent.projectTitle ?? "No project";
      if (!projects.has(name)) projects.set(name, { name, path: agent.cwd, agents: [] });
      projects.get(name).agents.push(agent);
    }
    const projectList = [...projects.values()]
      .map((project) => ({ ...project, agents: sortAgents(project.agents) }))
      .sort((a, b) => RANK[a.agents[0].state] - RANK[b.agents[0].state] || b.agents[0].updatedAt.localeCompare(a.agents[0].updatedAt));

    html.push(`<section class="server">${serverHead(server)}`);
    if (!projectList.length) html.push(`<div class="empty">${server.status === "connected" ? "No agents match these filters." : "Not connected."}</div>`);
    for (const project of projectList) {
      html.push(`<div class="project"><div class="project-head"><span class="name">${esc(project.name)}</span><span class="path">${esc(projectRoot(project))}</span></div>`);
      const walk = (agent, depth, last, prefix) => {
        html.push(agentRow(agent, depth, matched.has(agent.key), prefix, last, now));
        const kids = sortAgents(children.get(agent.key) ?? []);
        kids.forEach((kid, index) => walk(kid, depth + 1, index === kids.length - 1, prefix));
      };
      for (const agent of project.agents) walk(agent, 0, true, "");
      html.push(`</div>`);
    }
    html.push(`</section>`);
  }
  if (!serverList.length) html.push(`<div class="empty">No servers configured.</div>`);
  $("fleet").innerHTML = html.join("");
  renderHistory();
}

function projectRoot(project) {
  if (project.name === "No project") return "";
  const root = project.agents.find((agent) => !agent.worktree)?.cwd ?? project.path;
  return root ? root.replace(/^\/Users\/[^/]+/, "~") : "";
}

function serverHead(server) {
  const meta = [
    server.platform,
    server.serverVersion && `t3code ${server.serverVersion}`,
    server.protocolVersion && `protocol v${server.protocolVersion}`,
    server.url,
    `${server.threadCount} threads`,
    `${server.liveDetailCount} live streams`,
    server.lastSeenAt && `seen ${rel(server.lastSeenAt)}`,
  ].filter(Boolean);
  return `<div class="server-head"><span class="dot ${server.status}" title="${esc(server.status)}"></span><h3>${esc(server.label)}</h3>
    <span class="badge">${esc(server.status)}</span>
    <div class="server-meta">${meta.map((m) => `<span>${esc(m)}</span>`).join("")}</div>
    ${server.statusDetail ? `<div class="server-detail">${esc(server.statusDetail)}</div>` : ""}</div>`;
}

function agentRow(agent, depth, isMatch, _prefix, _last, now) {
  const badges = [];
  if (agent.relationship === "native-subagent") badges.push(`<span class="badge">subagent</span>`);
  else if (agent.relationship === "subagent") badges.push(`<span class="badge">delegated</span>`);
  else if (agent.relationship === "fork") badges.push(`<span class="badge">fork</span>`);
  if (agent.pending) badges.push(`<span class="badge needs">needs you: ${esc(agent.pending.kind.replaceAll(/[_-]/g, " "))}</span>`);
  if (agent.state === "failed" && agent.lastError) badges.push(`<span class="badge err" title="${esc(agent.lastError)}">error</span>`);
  if (agent.stale) badges.push(`<span class="badge">stale</span>`);

  const sub = [agent.provider, agent.model].filter(Boolean).join(" · ");
  const branch = agent.branch ? ` · <span class="branch">${esc(agent.branch)}</span>` : "";
  const worktree = agent.worktree ? ` · worktree` : "";

  let act = `<span class="l note">—</span>`;
  if (agent.activity) {
    const a = agent.activity;
    const tag = a.live ? `<span class="badge live">live</span>` : `<span class="badge" title="Last observed activity">last · ${rel(a.at)}</span>`;
    act = `<span class="l">${esc(a.label)}${tag}</span>${a.detail ? `<span class="d" title="${esc(a.detail)}">${esc(a.detail)}</span>` : ""}`;
  } else if (ACTIVE.has(agent.state)) {
    act = `<span class="l note">No activity reported${agent.fidelity === "summary" ? " (summary only)" : ""}</span>`;
  }

  const when = ACTIVE.has(agent.state) && agent.startedAt ? `${dur(now - Date.parse(agent.startedAt))}` : rel(agent.updatedAt);
  const classes = ["agent", agent.stale && "stale", !isMatch && "dim", agent.key === selectedKey && "selected"].filter(Boolean).join(" ");
  return `<div class="${classes}" style="--depth:${depth}" data-key="${esc(agent.key)}">
    <span class="dot ${agent.state}" title="${esc(STATE_LABEL[agent.state] ?? agent.state)} (${esc(agent.rawStatus)})"></span>
    <div class="title"><span class="t">${depth ? `<span class="tree">└</span>` : ""}${esc(agent.title)}${badges.join("")}</span><span class="sub">${esc(sub)}${branch}${worktree}</span></div>
    <div class="act">${act}</div>
    <div class="when" title="${esc(agent.updatedAt)}">${esc(when)}</div>
  </div>`;
}

function renderUsage() {
  const el = $("usage");
  el.hidden = usage.length === 0;
  el.innerHTML = usage
    .map((account) => {
      const who = [account.plan, account.account].filter(Boolean).join(" · ");
      const where = account.servers.length > 1 ? `${account.servers.length} machines` : account.servers[0];
      const body = account.windows.length
        ? account.windows
            .map((w) => {
              const left = Math.round(100 - w.usedPercent);
              const tone = left <= 10 ? "low" : left <= 30 ? "mid" : "ok";
              return `<div class="u-window ${tone}" title="${esc(w.label)}: ${Math.round(w.usedPercent)}% used${w.resetsAt ? `, resets ${new Date(w.resetsAt).toLocaleString()}` : ""}">
                <div class="u-row"><span class="u-label">${esc(w.label)}</span><b>${left}%</b></div>
                <div class="u-bar"><i style="width:${left}%"></i></div>
                <div class="u-reset">${w.resetsAt ? `resets ${until(w.resetsAt)}` : "&nbsp;"}</div>
              </div>`;
            })
            .join("")
        : `<div class="u-none">${account.unsupported?.link ? `<a href="${esc(account.unsupported.link.url)}" target="_blank" rel="noreferrer">${esc(account.unsupported.link.label)} ↗</a>` : "Usage not reported"}</div>`;
      return `<article class="u-card ${account.windows.length ? "" : "quiet"}" title="${esc(account.servers.join(", "))}">
        <header><span class="u-icon">${glyph(account.driver)}</span><span class="u-name">${esc(account.label)}</span><span class="u-where">${esc(who || where)}</span></header>
        <div class="u-windows">${body}</div>
      </article>`;
    })
    .join("");
}

function until(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return "now";
  const m = Math.round(ms / 60000);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h}h ${m % 60}m`;
  return new Date(iso).toLocaleDateString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}

function renderStats() {
  const counts = Object.fromEntries(STATES.map((state) => [state, 0]));
  const now = Date.now();
  let failedRecent = 0;
  for (const agent of agents.values()) {
    counts[agent.state]++;
    if (agent.state === "failed" && now - Date.parse(agent.updatedAt) < WINDOW_MS["24h"]) failedRecent++;
  }
  const list = [...servers.values()];
  const up = list.filter((server) => server.status === "connected").length;
  $("stats").innerHTML = [
    `<span class="stat" data-stat=""><span class="dot ${up === list.length ? "connected" : "offline"}"></span>Servers <b>${up}/${list.length}</b></span>`,
    `<span class="stat" data-stat="running"><span class="dot running"></span>Running <b>${counts.running}</b></span>`,
    `<span class="stat" data-stat="waiting"><span class="dot waiting"></span>Waiting <b>${counts.waiting}</b></span>`,
    `<span class="stat ${counts.blocked ? "attention" : ""}" data-stat="blocked"><span class="dot blocked"></span>Needs you <b>${counts.blocked}</b></span>`,
    `<span class="stat" data-stat="failed"><span class="dot failed"></span>Failed 24h <b>${failedRecent}</b></span>`,
  ].join("");
  document.title = `${counts.blocked ? `(${counts.blocked}!) ` : ""}${counts.running} running · T3 Fleet`;
}

let lastOptionsSignature = "";
function renderFilterOptions() {
  const providers = [...new Set([...agents.values()].map((agent) => agent.provider))].sort();
  const projects = [...new Set([...agents.values()].map((agent) => agent.projectTitle ?? "No project"))].sort((a, b) => a.localeCompare(b));
  const serverOptions = [...servers.values()].map((server) => [server.id, server.label]);
  const signature = JSON.stringify([providers, projects, serverOptions]);
  if (signature !== lastOptionsSignature) {
    lastOptionsSignature = signature;
    fillSelect($("server"), "All servers", serverOptions, filters.server);
    fillSelect($("provider"), "All providers", providers.map((p) => [p, p]), filters.provider);
    fillSelect($("project"), "All projects", projects.map((p) => [p, p]), filters.project);
  }
  $("states").innerHTML = STATES.map(
    (state) => `<button class="chip ${filters.states.has(state) ? "on" : ""}" data-state="${state}"><span class="dot ${state}"></span>${STATE_LABEL[state]}</button>`,
  ).join("");
}

function fillSelect(select, allLabel, options, value) {
  select.innerHTML = `<option value="">${esc(allLabel)}</option>${options.map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join("")}`;
  select.value = options.some(([v]) => v === value) ? value : "";
}

function renderHistory() {
  const q = filters.q;
  const items = history
    .filter((entry) => !filters.server || entry.serverId === filters.server)
    .filter((entry) => !q || `${entry.title ?? ""} ${entry.text}`.toLowerCase().includes(q))
    .slice(-200)
    .reverse();
  $("history").innerHTML = items
    .map((entry) => {
      const server = servers.get(entry.serverId);
      return `<li class="k-${entry.kind}" data-key="${esc(entry.agentKey ?? "")}">
        <div class="h-top"><span class="h-title">${esc(entry.title ?? server?.label ?? entry.serverId)}</span><span title="${esc(entry.at)}">${rel(entry.at)}</span></div>
        <div class="h-text">${esc(entry.text)}</div></li>`;
    })
    .join("") || `<li class="note">Nothing yet. Activity appears here as agents work.</li>`;
}

// ---- detail drawer ------------------------------------------------------------------------------

async function openDrawer(key) {
  if (!key) return;
  selectedKey = key;
  $("drawer").hidden = false;
  scheduleRender();
  await refreshDrawer();
  clearInterval(drawerTimer);
  drawerTimer = setInterval(refreshDrawer, 2000);
}

function closeDrawer() {
  selectedKey = null;
  $("drawer").hidden = true;
  clearInterval(drawerTimer);
  scheduleRender();
}

async function refreshDrawer() {
  if (!selectedKey) return;
  const key = selectedKey;
  const response = await fetch(`/api/agent?key=${encodeURIComponent(key)}`).catch(() => null);
  if (key !== selectedKey) return;
  if (!response?.ok) {
    $("drawer-body").innerHTML = `<p class="note">This agent is no longer known to the monitor.</p>`;
    return;
  }
  const detail = await response.json();
  const panel = $("drawer").querySelector(".drawer-panel");
  const scroll = panel.scrollTop;
  $("drawer-body").innerHTML = drawerHtml(detail);
  panel.scrollTop = scroll;
}

function drawerHtml({ agent, server, prompt, result, lastMessage, timeline }) {
  const parent = agent.parentKey ? agents.get(agent.parentKey) : null;
  const kids = [...agents.values()].filter((other) => other.parentKey === agent.key);
  const row = (label, value, mono) => (value ? `<dt>${label}</dt><dd class="${mono ? "mono" : ""}">${value}</dd>` : "");
  const fidelity = {
    live: "Live: detail stream attached, activity is what the provider reports now.",
    last: "Last observed: the detail stream has ended; values are from when it was attached.",
    summary: "Summary only: thread status from the server shell; open activity streams on demand.",
  }[agent.fidelity];
  return `
    <h2><span class="dot ${agent.state}"></span>${esc(agent.title)}</h2>
    <div class="note">${esc(STATE_LABEL[agent.state] ?? agent.state)} · raw status <span class="mono">${esc(agent.rawStatus)}</span>${agent.stale ? " · server unreachable, values are stale" : ""}</div>
    <h4>Where</h4>
    <dl class="kv">
      ${row("Server", esc(`${server?.label ?? agent.serverId}${server?.platform ? ` (${server.platform})` : ""}`))}
      ${row("Project", esc(agent.projectTitle ?? "No project"))}
      ${row("Directory", esc(agent.cwd), true)}
      ${row("Branch", agent.branch ? `<span class="branch">${esc(agent.branch)}</span>${agent.worktree ? " (worktree)" : ""}` : "")}
    </dl>
    <h4>Who</h4>
    <dl class="kv">
      ${row("Kind", esc(agent.kind === "subagent" ? "Provider-native subagent" : agent.relationship === "subagent" ? "Delegated thread" : agent.relationship === "fork" ? "Forked thread" : "Thread"))}
      ${row("Provider", esc(agent.provider))}
      ${row("Model", esc(agent.model), true)}
      ${row("Parent", parent ? `<a href="#" data-open="${esc(parent.key)}">${esc(parent.title)}</a>` : "")}
      ${row("Children", kids.length ? `<span class="children">${kids.map((kid) => `<div><span class="dot ${kid.state}"></span> <a href="#" data-open="${esc(kid.key)}">${esc(kid.title)}</a></div>`).join("")}</span>` : "")}
      ${row("Thread id", esc(agent.threadId), true)}
    </dl>
    <h4>State</h4>
    <dl class="kv">
      ${row("Activity", agent.activity ? `${esc(agent.activity.label)} ${agent.activity.live ? `<span class="badge live">live</span>` : `<span class="badge">last · ${rel(agent.activity.at)}</span>`}${agent.activity.detail ? `<div class="mono">${esc(agent.activity.detail)}</div>` : ""}` : "")}
      ${row("Needs you", agent.pending ? esc(agent.pending.kind) : "")}
      ${row("Error", agent.lastError ? `<span style="color:var(--failed)">${esc(agent.lastError)}</span>` : "")}
      ${row("Started", agent.startedAt ? `${esc(new Date(agent.startedAt).toLocaleString())} (${rel(agent.startedAt)})` : "")}
      ${row("Completed", agent.completedAt ? `${esc(new Date(agent.completedAt).toLocaleString())} (${rel(agent.completedAt)})` : "")}
      ${row("Updated", `${esc(new Date(agent.updatedAt).toLocaleString())} (${rel(agent.updatedAt)})`)}
      ${row("Fidelity", esc(fidelity))}
    </dl>
    ${prompt ? `<h4>Prompt</h4><div class="prose">${esc(prompt)}</div>` : ""}
    ${result ? `<h4>Result</h4><div class="prose">${esc(result)}</div>` : ""}
    ${lastMessage ? `<h4>${agent.kind === "subagent" ? "Progress" : "Latest message"}</h4><div class="prose">${esc(lastMessage)}</div>` : ""}
    <h4>Timeline</h4>
    ${
      timeline.length
        ? `<ol class="timeline">${timeline
            .map(
              (item) => `<li><span class="dot ${itemState(item.status)}"></span><div>${esc(item.label)}${item.detail ? `<div class="d">${esc(item.detail)}</div>` : ""}</div><span class="when" title="${esc(item.at)}">${rel(item.at)}</span></li>`,
            )
            .join("")}</ol>`
        : `<p class="note">${agent.fidelity === "summary" ? "Loading activity stream…" : "No items reported."}</p>`
    }`;
}

function itemState(status) {
  if (status === "running" || status === "pending") return "running";
  if (status === "failed") return "failed";
  if (status === "cancelled" || status === "interrupted") return "cancelled";
  return "completed";
}

// ---- time ---------------------------------------------------------------------------------------

function rel(iso) {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  if (ms < 10_000) return "just now";
  return `${dur(ms)} ago`;
}

function dur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

// ---- wiring -------------------------------------------------------------------------------------

function persist() {
  localStorage.setItem(
    "t3fleet.filters",
    JSON.stringify({ view, window: filters.window, server: filters.server, provider: filters.provider, project: filters.project, states: [...filters.states] }),
  );
  scheduleRender();
}

const map = createMap($("map"), {
  onOpen: (key) => openDrawer(key),
  onExpand: (id) => {
    expanded.has(id) ? expanded.delete(id) : expanded.add(id);
    scheduleRender();
  },
});
document.querySelector(".views").addEventListener("click", (event) => {
  const next = event.target.closest("[data-view]")?.dataset.view;
  if (!next || next === view) return;
  view = next;
  persist();
});

$("window").value = filters.window;
$("search").addEventListener("input", (event) => {
  filters.q = event.target.value.trim().toLowerCase();
  scheduleRender();
});
for (const id of ["window", "server", "provider", "project"]) {
  $(id).addEventListener("change", (event) => {
    filters[id] = event.target.value;
    persist();
  });
}
$("states").addEventListener("click", (event) => {
  const state = event.target.closest("[data-state]")?.dataset.state;
  if (!state) return;
  filters.states.has(state) ? filters.states.delete(state) : filters.states.add(state);
  persist();
});
$("stats").addEventListener("click", (event) => {
  const stat = event.target.closest("[data-stat]");
  if (!stat) return;
  filters.states = new Set(stat.dataset.stat ? [stat.dataset.stat] : []);
  if (stat.dataset.stat === "failed" && filters.window === "active") filters.window = "24h";
  $("window").value = filters.window;
  persist();
});
$("fleet").addEventListener("click", (event) => openDrawer(event.target.closest("[data-key]")?.dataset.key));
$("history").addEventListener("click", (event) => {
  const key = event.target.closest("[data-key]")?.dataset.key;
  if (key && agents.has(key)) openDrawer(key);
});
$("drawer").addEventListener("click", (event) => {
  if (event.target.closest("[data-close]")) return closeDrawer();
  const open = event.target.closest("[data-open]");
  if (open) {
    event.preventDefault();
    openDrawer(open.dataset.open);
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && selectedKey) closeDrawer();
  if (event.key === "/" && document.activeElement !== $("search")) {
    event.preventDefault();
    $("search").focus();
  }
});
setInterval(scheduleRender, 5000);
connect();
