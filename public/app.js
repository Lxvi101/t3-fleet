import { createMap, glyph } from "./map.js";

const ACTIVE = new Set(["running", "waiting", "blocked"]);
const RANK = { blocked: 0, running: 1, waiting: 2, failed: 3, unknown: 4, completed: 5, cancelled: 6, idle: 7 };
const WINDOW_MS = { "24h": 86400e3, "7d": 7 * 86400e3 };
const ACCENT = { claudeAgent: "#d97757", codex: "#10a37f", cursor: "#121826" };

const servers = new Map();
const agents = new Map();
let history = [];
let usage = [];
let sentinel = null;
let selectedKey = null;
let drawerTimer = null;

const saved = JSON.parse(localStorage.getItem("t3fleet") ?? "{}");
const prefs = { view: saved.view ?? "map", window: saved.window ?? "24h", usage: saved.usage ?? true, q: "", needsOnly: false, stateFilter: null };
const save = () => localStorage.setItem("t3fleet", JSON.stringify({ view: prefs.view, window: prefs.window, usage: prefs.usage }));

const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// The map fits into the space above the chat dock, whatever its current height.
const map = createMap($("map"), {
  onOpen: (key) => openDrawer(key),
  onFilter: (state) => {
    prefs.stateFilter = prefs.stateFilter === state ? null : state;
    schedule();
  },
  bottomInset: () => ($("chat").hidden ? 0 : $("chat").offsetHeight + 20) });
new ResizeObserver(() => map.refit()).observe($("chat"));
const chat = JSON.parse(localStorage.getItem("t3fleet.chat") ?? "[]");
let chatBusy = false;
let threadHidden = false;

// ---- data ---------------------------------------------------------------------------------------

function applyState(state) {
  servers.clear();
  agents.clear();
  for (const server of state.servers) servers.set(server.id, server);
  for (const agent of state.agents) agents.set(agent.key, agent);
  history = state.history;
  usage = state.usage ?? [];
  sentinel = state.sentinel ?? null;
  setConn(true);
  schedule();
}

function connect() {
  // ?poll suits proxies and headless browsers that break Server-Sent Events.
  if (new URLSearchParams(location.search).has("poll")) {
    const poll = () =>
      fetch("/api/state")
        .then((r) => r.json())
        .then(applyState, () => setConn(false))
        .finally(() => setTimeout(poll, 3000));
    return poll();
  }
  const source = new EventSource("/api/events");
  source.addEventListener("state", (event) => applyState(JSON.parse(event.data)));
  source.addEventListener("patch", (event) => {
    const patch = JSON.parse(event.data);
    if (patch.servers) for (const server of patch.servers) servers.set(server.id, server);
    for (const agent of patch.upserts) agents.set(agent.key, agent);
    for (const key of patch.removals) agents.delete(key);
    if (patch.usage) usage = patch.usage;
    if (patch.sentinel) sentinel = patch.sentinel;
    if (patch.history.length) history = history.concat(patch.history).slice(-400);
    schedule();
  });
  source.onerror = () => setConn(false);
}

function setConn(ok) {
  $("conn").className = ok ? "ok" : "bad";
  $("conn").title = ok ? "live" : "reconnecting";
}

let queued = false;
function schedule() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    render();
  });
}

// ---- filtering ----------------------------------------------------------------------------------

function matches(agent, now) {
  if (prefs.needsOnly && agent.state !== "blocked") return false;
  if (prefs.stateFilter === "failed" && agent.state !== "failed") return false;
  if (prefs.stateFilter === "running" && !ACTIVE.has(agent.state)) return false;
  if (!ACTIVE.has(agent.state)) {
    if (prefs.window === "active") return false;
    if (now - Date.parse(agent.updatedAt) > WINDOW_MS[prefs.window]) return false;
  }
  if (prefs.q) {
    const hay = [agent.title, agent.projectTitle, agent.branch, agent.cwd, agent.provider, agent.model, agent.activity?.label, agent.activity?.detail, servers.get(agent.serverId)?.label]
      .join(" ")
      .toLowerCase();
    if (!prefs.q.split(/\s+/).every((word) => hay.includes(word))) return false;
  }
  return true;
}

function visible(now) {
  const matched = new Set();
  for (const agent of agents.values()) if (matches(agent, now)) matched.add(agent.key);
  const shown = new Set(matched);
  for (const key of matched) {
    let parent = agents.get(key)?.parentKey;
    for (let i = 0; parent && agents.has(parent) && i < 20; i++) {
      shown.add(parent);
      parent = agents.get(parent).parentKey;
    }
  }
  const children = new Map();
  for (const key of shown) {
    const agent = agents.get(key);
    if (agent.parentKey && shown.has(agent.parentKey)) {
      if (!children.has(agent.parentKey)) children.set(agent.parentKey, []);
      children.get(agent.parentKey).push(agent);
    }
  }
  return { matched, shown, children };
}

// ---- render -------------------------------------------------------------------------------------

function render() {
  const now = Date.now();
  for (const b of document.querySelectorAll("#views button")) b.classList.toggle("on", b.dataset.view === prefs.view);
  for (const b of document.querySelectorAll("#windows button")) b.classList.toggle("on", b.dataset.window === prefs.window);
  renderBar();
  renderSentinel();
  renderHistory();
  const { matched, shown, children } = visible(now);
  $("map").hidden = prefs.view !== "map";
  $("list").hidden = prefs.view !== "list";
  const serverList = [...servers.values()];
  if (prefs.view === "map") map.render({ agents, servers: serverList, shown, matched, children, selectedKey, now, window: prefs.window, stateFilter: prefs.stateFilter });
  else renderList(serverList, shown, matched, children, now);
}

function renderBar() {
  const blocked = [...agents.values()].filter((a) => a.state === "blocked").length;
  const needs = $("needs");
  needs.hidden = blocked === 0 && !prefs.needsOnly;
  needs.textContent = `${blocked} need${blocked === 1 ? "s" : ""} you`;
  needs.classList.toggle("on", prefs.needsOnly);
  const down = [...servers.values()].filter((s) => s.status !== "connected" && s.status !== "connecting");
  $("down").textContent = down.map((s) => `${s.label} ${s.status}`).join(" · ");
  document.title = blocked ? `(${blocked}) T3 Fleet` : "T3 Fleet";

  renderUsage();
}

/** Rings show each account's tightest limit; hovering expands them into every window. */
function renderUsage() {
  const island = $("usage");
  island.hidden = usage.length === 0 || !prefs.usage;
  const measured = usage.filter((account) => account.windows.length);
  const leftOf = (w) => Math.round(100 - w.usedPercent);
  const color = (left) => (left <= 10 ? "#ff6b70" : left <= 30 ? "#f5b544" : null);
  island.querySelector(".island-pill").innerHTML = measured
    .map((account) => {
      const tightest = account.windows.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
      return ring(account, leftOf(tightest));
    })
    .join("") || `<span class="ring">usage</span>`;
  // The panel grows out of the pill, so it needs the pill's width.
  island.style.setProperty("--pill-w", `${island.querySelector(".island-pill").offsetWidth || 120}px`);
  island.querySelector(".island-panel").innerHTML = usage
    .map((account) => {
      const who = [account.plan, account.servers.length > 1 ? `${account.servers.length} machines` : account.servers[0]].filter(Boolean).join(" · ");
      const head = `<div class="acct-head">${account.windows.length ? ring(account, leftOf(account.windows.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a))), true) : `<span class="ring">${ringSvg(account, 0)}</span>`}<b>${esc(account.label)}</b><span>${esc(who)}</span></div>`;
      const rows = account.windows
        .map((w) => {
          const left = leftOf(w);
          const tint = color(left) ?? ACCENT[account.driver] ?? "#8fb0ff";
          return `<div class="win"><span class="lbl">${esc(w.label)}</span><span class="meter"><i style="width:${left}%;background:${tint}"></i></span><b>${left}%</b>${w.resetsAt ? `<span class="reset">resets ${until(w.resetsAt)}</span>` : ""}</div>`;
        })
        .join("");
      const note = account.windows.length
        ? ""
        : `<div class="acct-note">${account.unsupported?.link ? `Not reported to T3 Code · <a href="${esc(account.unsupported.link.url)}" target="_blank" rel="noreferrer">${esc(account.unsupported.link.label)} ↗</a>` : "Not reported to T3 Code"}</div>`;
      return `<div class="acct">${head}${rows}${note}</div>`;
    })
    .join("");
}

function ringSvg(account, left) {
  const circumference = 2 * Math.PI * 9;
  const stroke = left <= 10 ? "#ff6b70" : left <= 30 ? "#f5b544" : (ACCENT[account.driver] === "#121826" ? "#ffffff" : (ACCENT[account.driver] ?? "#8fb0ff"));
  return `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" class="track"/>${left ? `<circle cx="12" cy="12" r="9" class="arc" stroke="${stroke}" stroke-dasharray="${(circumference * left) / 100} ${circumference}"/>` : ""}
    <g transform="translate(7 7) scale(${10 / 24})" class="ring-glyph">${glyph(account.driver).replace(/^<svg[^>]*>|<\/svg>$/g, "")}</g></svg>`;
}

function ring(account, left, bare = false) {
  return `<span class="ring ${left <= 10 ? "low" : ""}">${ringSvg(account, left)}${bare ? "" : `<span>${left}%</span>`}</span>`;
}

function renderList(serverList, shown, matched, children, now) {
  const rows = [];
  for (const server of serverList) {
    const roots = [...shown].map((k) => agents.get(k)).filter((a) => a.serverId === server.id && !(a.parentKey && shown.has(a.parentKey)));
    if (!roots.length) continue;
    rows.push(`<h3>${esc(server.label)}</h3>`);
    const walk = (agent, depth) => {
      rows.push(listRow(agent, depth, matched.has(agent.key), now));
      for (const kid of (children.get(agent.key) ?? []).sort(byRank)) walk(kid, depth + 1);
    };
    for (const agent of roots.sort(byRank)) walk(agent, 0);
  }
  $("list").innerHTML = rows.join("") || `<div class="empty">Nothing in this window.</div>`;
}

function listRow(agent, depth, isMatch, now) {
  const { text, tone } = describe(agent);
  const when = ACTIVE.has(agent.state) && agent.startedAt ? dur(now - Date.parse(agent.startedAt)) : dur(now - Date.parse(agent.updatedAt));
  return `<div class="row ${isMatch ? "" : "dim"} ${agent.key === selectedKey ? "sel" : ""}" style="--d:${depth}" data-key="${esc(agent.key)}">
    <i class="dot ${agent.state}"></i><span>${esc(agent.title)}</span><span class="act ${tone}">${esc(text)}</span>
    <span class="where">${esc([agent.projectTitle, agent.branch].filter(Boolean).join(" · "))}</span><time>${when}</time></div>`;
}

/** The one line that says what an agent is doing or why it matters. */
function describe(agent) {
  if (agent.state === "blocked") return { text: `needs you · ${(agent.pending?.kind ?? "input").replaceAll(/[_-]/g, " ")}`, tone: "needs" };
  if (agent.state === "failed") return { text: agent.lastError ?? "failed", tone: "bad" };
  if (agent.activity && ACTIVE.has(agent.state)) return { text: `${agent.activity.label}${agent.activity.detail ? ` · ${agent.activity.detail}` : ""}`, tone: agent.activity.live ? "live" : "" };
  return { text: agent.state === "completed" ? "done" : agent.state, tone: "" };
}

function byRank(a, b) {
  return RANK[a.state] - RANK[b.state] || b.updatedAt.localeCompare(a.updatedAt);
}

function renderSentinel() {
  $("chat").hidden = !sentinel?.agent || !sentinel.enabled;
  for (const box of document.querySelectorAll("[data-setting]")) {
    const key = box.dataset.setting;
    box.checked = key === "luna" ? !!sentinel?.enabled : key === "notify" ? !!sentinel?.notify : prefs.usage;
    if (key === "luna") box.disabled = !sentinel?.agent;
  }
  $("chat-agent").textContent = sentinel?.agent ?? "";
  $("alerts").innerHTML = (sentinel?.alerts ?? [])
    .map(
      (alert) => `<div class="alert">
        <b ${alert.agentKey ? `data-open="${esc(alert.agentKey)}"` : ""}>${esc(alert.headline)}</b><button class="x" data-dismiss="${esc(alert.id)}" title="Dismiss">✕</button>
        <p>${esc(alert.why)}${alert.action ? ` <span class="go">${esc(alert.action)}</span>` : ""}</p>
      </div>`,
    )
    .join("");
  renderChat();
}

// ---- chat ---------------------------------------------------------------------------------------

function renderChat() {
  const thread = $("chat").querySelector(".thread");
  const messages = [...chat];
  // An empty conversation opens with the latest briefing.
  if (!messages.length && sentinel?.briefing) messages.push({ role: "bot", text: sentinel.briefing.text, tag: `Briefing · ${rel(sentinel.briefing.at)}` });
  thread.hidden = threadHidden || (!messages.length && !chatBusy);
  $("chat").querySelector('[data-chat="show"]').hidden = !(threadHidden && messages.length);
  const box = thread.querySelector(".messages");
  const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
  const html =
    messages
      .map((m) =>
        m.role === "user"
          ? `<div class="msg user">${esc(m.text)}</div>`
          : `<div class="msg bot ${m.error ? "err" : ""}">${m.tag ? `<div class="tag">${esc(m.tag)}</div>` : ""}${formatText(m.text)}</div>`,
      )
      .join("") + (chatBusy ? `<div class="msg bot"><span class="typing"><i></i><i></i><i></i></span></div>` : "");
  if (box.dataset.html !== html) {
    box.innerHTML = html;
    box.dataset.html = html;
    if (stick) box.scrollTop = box.scrollHeight;
  }
  $("chat").querySelector(".send").disabled = chatBusy;
}

async function send(text) {
  const question = text.trim();
  if (!question || chatBusy) return;
  threadHidden = false;
  const brief = question === "brief";
  chat.push({ role: "user", text: brief ? "Brief me" : question });
  chatBusy = true;
  renderChat();
  const conversation = chat.slice(0, -1).map((m) => ({ role: m.role === "user" ? "user" : "assistant", text: m.text }));
  const response = await fetch(brief ? "/api/brief" : "/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: brief ? undefined : JSON.stringify({ question, conversation }),
  }).catch(() => null);
  const body = response ? await response.json().catch(() => ({})) : { error: "The dashboard is unreachable." };
  chatBusy = false;
  const answer = brief ? body.text : body.answer;
  chat.push(answer ? { role: "bot", text: answer } : { role: "bot", text: body.error ?? "No answer.", error: true });
  localStorage.setItem("t3fleet.chat", JSON.stringify(chat.slice(-40)));
  renderChat();
}

function renderHistory() {
  // Individual commands and edits are noise here; they live in each agent's timeline.
  const items = history
    .filter((e) => worthShowing(e))
    .filter((e) => !prefs.q || `${e.title ?? ""} ${e.text}`.toLowerCase().includes(prefs.q))
    .slice(-150)
    .reverse();
  $("history").innerHTML = items
    .map((e) => `<li class="k-${e.kind}" data-key="${esc(e.agentKey ?? "")}" title="${esc(`${e.title ?? ""}\n${e.text}`)}"><time>${short(e.at)}</time><span>${e.title ? `<b>${esc(e.title)}</b> ` : ""}${esc(e.text)}</span></li>`)
    .join("");
}

/** The feed keeps outcomes and problems; routine commands, edits and state churn stay out. */
function worthShowing(e) {
  if (e.kind === "error" || e.kind === "blocked") return true;
  if (e.kind === "server") return !e.text.startsWith("Connected");
  if (e.kind === "tool") return false;
  if (e.kind === "lifecycle") return e.text === "Completed" || e.text === "Stopped";
  return false;
}

function formatText(text) {
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .split("\n")
    .map((line) => (line.startsWith("- ") ? `<li>${line.slice(2)}</li>` : line ? `<p>${line}</p>` : ""))
    .join("")
    .replace(/(<li>.*?<\/li>)+/gs, (list) => `<ul>${list}</ul>`);
}

// ---- drawer -------------------------------------------------------------------------------------

async function openDrawer(key) {
  if (!key || !agents.has(key)) return;
  selectedKey = key;
  $("drawer").hidden = false;
  schedule();
  await refreshDrawer();
  clearInterval(drawerTimer);
  drawerTimer = setInterval(refreshDrawer, 2000);
}

function closeDrawer() {
  selectedKey = null;
  $("drawer").hidden = true;
  clearInterval(drawerTimer);
  schedule();
}

async function refreshDrawer() {
  const key = selectedKey;
  if (!key) return;
  const response = await fetch(`/api/agent?key=${encodeURIComponent(key)}`).catch(() => null);
  if (key !== selectedKey || !response?.ok) return;
  const detail = await response.json();
  const panel = $("drawer").querySelector(".panel");
  const scroll = panel.scrollTop;
  $("drawer-body").innerHTML = drawerHtml(detail);
  panel.scrollTop = scroll;
}

function drawerHtml({ agent, server, prompt, result, lastMessage, timeline }) {
  const now = Date.now();
  const parent = agent.parentKey ? agents.get(agent.parentKey) : null;
  const kids = [...agents.values()].filter((a) => a.parentKey === agent.key).sort(byRank);
  const { text, tone } = describe(agent);
  const meta = [server?.label, agent.projectTitle, agent.branch, [agent.provider, agent.model].filter(Boolean).join(" ")].filter(Boolean);
  const since = ACTIVE.has(agent.state) && agent.startedAt ? `for ${dur(now - Date.parse(agent.startedAt))}` : rel(agent.updatedAt);
  return `<button class="x close" data-close title="Close">✕</button>
    <h2><i class="dot ${agent.state}"></i>${esc(agent.title)}</h2>
    <div class="meta">${meta.map(esc).join(" · ")}${parent ? ` · from <a href="#" data-open="${esc(parent.key)}">${esc(parent.title)}</a>` : ""}</div>
    <div class="state-line ${tone}">${esc(text)} <span class="meta">${since}${agent.stale ? " · machine unreachable" : agent.fidelity === "summary" && ACTIVE.has(agent.state) ? " · loading activity" : ""}</span></div>
    ${agent.cwd ? `<div class="meta"><code>${esc(agent.cwd)}</code></div>` : ""}
    ${prompt ? `<h4>Prompt</h4><div class="prose">${esc(prompt)}</div>` : ""}
    ${result ? `<h4>Result</h4><div class="prose">${esc(result)}</div>` : ""}
    ${lastMessage ? `<h4>${agent.kind === "subagent" ? "Progress" : "Last message"}</h4><div class="prose">${esc(lastMessage)}</div>` : ""}
    ${kids.length ? `<h4>Subagents</h4><div class="kids">${kids.map((k) => `<a href="#" data-open="${esc(k.key)}"><i class="dot ${k.state}"></i>${esc(k.title)}</a>`).join("")}</div>` : ""}
    ${
      timeline.length
        ? `<h4>Timeline</h4><ol class="tl">${timeline
            .map(
              (item) =>
                `<li><i class="dot ${item.status === "running" ? "running" : item.status === "failed" ? "failed" : "completed"}"></i><div>${esc(item.label)}${item.detail ? `<code>${esc(item.detail)}</code>` : ""}</div><time>${short(item.at)}</time></li>`,
            )
            .join("")}</ol>`
        : ""
    }`;
}

// ---- time ---------------------------------------------------------------------------------------

function dur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
const short = (iso) => dur(Date.now() - Date.parse(iso));
const rel = (iso) => {
  const d = short(iso);
  return d === "now" ? "now" : `${d} ago`;
};
function until(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return "now";
  const m = Math.round(ms / 60000);
  if (m < 60) return `in ${m}m`;
  if (m < 1440) return `in ${Math.floor(m / 60)}h ${m % 60}m`;
  return new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}

// ---- wiring -------------------------------------------------------------------------------------

$("views").addEventListener("click", (e) => {
  const view = e.target.closest("[data-view]")?.dataset.view;
  if (view) {
    prefs.view = view;
    save();
    schedule();
  }
});
$("windows").addEventListener("click", (e) => {
  const w = e.target.closest("[data-window]")?.dataset.window;
  if (w) {
    prefs.window = w;
    save();
    schedule();
  }
});
$("search").addEventListener("input", (e) => {
  prefs.q = e.target.value.trim().toLowerCase();
  schedule();
});
$("needs").addEventListener("click", () => {
  prefs.needsOnly = !prefs.needsOnly;
  schedule();
});
$("list").addEventListener("click", (e) => openDrawer(e.target.closest("[data-key]")?.dataset.key));
$("history").addEventListener("click", (e) => openDrawer(e.target.closest("[data-key]")?.dataset.key));
$("drawer").addEventListener("click", (e) => {
  if (e.target.closest("[data-close]")) return closeDrawer();
  const open = e.target.closest("[data-open]");
  if (open) {
    e.preventDefault();
    openDrawer(open.dataset.open);
  }
});
$("alerts").addEventListener("click", async (e) => {
  const dismiss = e.target.closest("[data-dismiss]")?.dataset.dismiss;
  if (dismiss) await fetch(`/api/alerts/dismiss?id=${encodeURIComponent(dismiss)}`, { method: "POST" });
  const open = e.target.closest("[data-open]")?.dataset.open;
  if (open) openDrawer(open);
});
const composer = $("chat").querySelector(".composer");
const input = composer.querySelector("textarea");
const grow = () => {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
};
input.addEventListener("input", grow);
// Coming back to the composer brings a minimised conversation back.
input.addEventListener("focus", () => {
  if (!threadHidden) return;
  threadHidden = false;
  renderChat();
});
$("gear").addEventListener("click", (e) => {
  e.stopPropagation();
  $("menu").hidden = !$("menu").hidden;
  $("gear").classList.toggle("on", !$("menu").hidden);
});
document.addEventListener("click", (e) => {
  if (!$("menu").hidden && !e.target.closest(".settings")) {
    $("menu").hidden = true;
    $("gear").classList.remove("on");
  }
});
$("menu").addEventListener("change", async (e) => {
  const key = e.target.dataset.setting;
  if (key === "usage") {
    prefs.usage = e.target.checked;
    save();
    return schedule();
  }
  const response = await fetch("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ [key]: e.target.checked }) }).catch(() => null);
  if (response?.ok) {
    const settings = await response.json();
    sentinel = { ...sentinel, enabled: settings.luna, notify: settings.notify };
  }
  schedule();
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    composer.requestSubmit();
  }
});
composer.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value;
  input.value = "";
  grow();
  send(text);
});
$("chat").addEventListener("click", (e) => {
  const ask = e.target.closest("[data-ask]")?.dataset.ask;
  if (ask) send(ask);
  const action = e.target.closest("[data-chat]")?.dataset.chat;
  if (action === "hide") threadHidden = true;
  if (action === "show") threadHidden = false;
  if (action === "clear") {
    chat.length = 0;
    localStorage.removeItem("t3fleet.chat");
  }
  if (action) renderChat();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && selectedKey) closeDrawer();
  if (e.key === "/" && document.activeElement?.tagName !== "INPUT") {
    e.preventDefault();
    $("search").focus();
  }
});
// Alert notifications link here with #agent=<key>.
function openFromHash() {
  const match = location.hash.match(/^#agent=(.+)$/);
  if (!match) return;
  const key = decodeURIComponent(match[1]);
  window.history.replaceState(null, "", location.pathname + location.search);
  const tryOpen = (n) => (agents.has(key) ? openDrawer(key) : n > 0 && setTimeout(() => tryOpen(n - 1), 500));
  tryOpen(20);
}
window.addEventListener("hashchange", openFromHash);
setInterval(schedule, 10_000);
openFromHash();
connect();
