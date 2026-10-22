// Agent map: each machine is a hub, each agent a card, and edges show who spawned whom.
// Laid out as left-to-right trees (hub → threads → subagents) on a pannable, zoomable canvas.

const HUB_W = 200;
const ROOT_X = 300;
const ROOT_W = 320;
const CHILD_W = 280;
const COL_GAP = 84;
const ROOT_H = 92;
const CHILD_H = 70;
const MORE_H = 34;
const ROW_GAP = 16;
const SERVER_GAP = 140;
/** Root agents shown per machine and children per agent before the rest fold into "+N more". */
const ROOT_LIMIT = 6;
const CHILD_LIMIT = 4;
const ACTIVE = new Set(["running", "waiting", "blocked"]);
const RANK = { blocked: 0, running: 1, waiting: 2, failed: 3, unknown: 4, completed: 5, cancelled: 6, idle: 7 };
const STATE_LABEL = { blocked: "Needs you", running: "Running", waiting: "Waiting", failed: "Failed", unknown: "Unknown", completed: "Done", cancelled: "Stopped", idle: "Idle" };

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const colX = (depth) => (depth === 0 ? ROOT_X : ROOT_X + ROOT_W + COL_GAP + (depth - 1) * (CHILD_W + COL_GAP));

export function createMap(root, { onOpen, onExpand }) {
  root.innerHTML = `
    <div class="am-viewport">
      <div class="am-world">
        <svg class="am-edges" xmlns="http://www.w3.org/2000/svg"></svg>
        <div class="am-nodes"></div>
      </div>
    </div>
    <div class="map-controls">
      <button data-zoom="in" title="Zoom in">+</button>
      <button data-zoom="out" title="Zoom out">−</button>
      <button data-zoom="fit" title="Fit everything">Fit</button>
    </div>`;
  const viewport = root.querySelector(".am-viewport");
  const world = root.querySelector(".am-world");
  const edges = root.querySelector(".am-edges");
  const nodes = root.querySelector(".am-nodes");
  const view = { x: 40, y: 40, scale: 1 };
  let bounds = null;
  let fitted = false;
  let lastData = null;

  const apply = () => (world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`);

  function fit() {
    if (!bounds) return;
    const { width, height } = viewport.getBoundingClientRect();
    if (!width) return;
    view.scale = Math.max(Math.min((width - 80) / bounds.w, (height - 80) / bounds.h, 1), 0.5);
    view.x = Math.max(40, (width - bounds.w * view.scale) / 2);
    view.y = bounds.h * view.scale < height - 80 ? (height - bounds.h * view.scale) / 2 : 40;
    apply();
  }

  function zoomAt(factor, cx, cy) {
    const next = Math.min(2, Math.max(0.2, view.scale * factor));
    const k = next / view.scale;
    view.x = cx - (cx - view.x) * k;
    view.y = cy - (cy - view.y) * k;
    view.scale = next;
    apply();
  }

  let drag = null;
  viewport.addEventListener("pointerdown", (event) => {
    drag = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y, moved: false, target: event.target };
  });
  window.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
    drag.moved = true;
    viewport.classList.add("dragging");
    view.x = drag.vx + dx;
    view.y = drag.vy + dy;
    apply();
  });
  window.addEventListener("pointerup", () => {
    if (!drag) return;
    const { moved, target } = drag;
    drag = null;
    viewport.classList.remove("dragging");
    if (moved || !target?.closest) return;
    const expand = target.closest("[data-expand]")?.dataset.expand;
    if (expand) return onExpand(expand);
    const key = target.closest("[data-key]")?.dataset.key;
    if (key) onOpen(key);
  });
  viewport.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) zoomAt(Math.exp(-event.deltaY * 0.01), event.clientX - rect.left, event.clientY - rect.top);
      else {
        view.x -= event.deltaX;
        view.y -= event.deltaY;
        apply();
      }
    },
    { passive: false },
  );
  root.querySelector(".map-controls").addEventListener("click", (event) => {
    const action = event.target.closest("[data-zoom]")?.dataset.zoom;
    const { width, height } = viewport.getBoundingClientRect();
    if (action === "fit") fit();
    if (action === "in") zoomAt(1.2, width / 2, height / 2);
    if (action === "out") zoomAt(1 / 1.2, width / 2, height / 2);
  });
  new ResizeObserver(() => {
    if (!fitted && lastData) render(lastData);
  }).observe(viewport);

  function render(data) {
    lastData = data;
    const scene = layout(data);
    bounds = scene.bounds;
    edges.setAttribute("width", String(bounds.w));
    edges.setAttribute("height", String(bounds.h));
    edges.innerHTML = scene.edges.join("");
    nodes.innerHTML = scene.nodes.join("");
    if (!fitted && viewport.getBoundingClientRect().width) {
      fitted = true;
      fit();
    } else apply();
  }

  return { render, fit };
}

// ---- layout ---------------------------------------------------------------------------------------

function layout({ agents, servers, shown, matched, children, selectedKey, now, expanded }) {
  const nodes = [];
  const edges = [];
  let offsetX = 0;
  let maxY = 200;

  // Machines sit side by side; each is a left-to-right tree starting at its hub.
  for (const server of servers) {
    const y = 0;
    let maxX = ROOT_X + ROOT_W;
    const roots = [...shown]
      .map((key) => agents.get(key))
      .filter((agent) => agent.serverId === server.id && !(agent.parentKey && shown.has(agent.parentKey)))
      .sort(byImportance);
    const rootsOpen = expanded.has(`roots:${server.id}`);
    const visibleRoots = rootsOpen ? roots : roots.slice(0, ROOT_LIMIT);
    const hiddenRoots = roots.length - visibleRoots.length;
    const top = y;
    const placed = [];

    // Places a subtree with its top edge at `cursor`; returns the height it used.
    const place = (agent, depth, cursor) => {
      const height = depth === 0 ? ROOT_H : CHILD_H;
      const kids = (children.get(agent.key) ?? []).filter((kid) => shown.has(kid.key)).sort(byImportance);
      const open = expanded.has(`kids:${agent.key}`);
      // A finished tree is history: its subagents fold away until asked for.
      const working = kids.some((kid) => countActive(kid, children) > 0);
      const visibleKids = open ? kids : working ? pickChildren(kids) : [];
      const hiddenKids = kids.length - visibleKids.length;
      let span = 0;
      const kidKeys = [];
      for (const kid of visibleKids) {
        span += place(kid, depth + 1, cursor + span) + ROW_GAP;
        kidKeys.push(kid.key);
      }
      let more = null;
      // Fully folded children become a badge on the card instead of a column of their own.
      const folded = visibleKids.length === 0 && hiddenKids > 0 ? hiddenKids : 0;
      if (!folded && (hiddenKids > 0 || (open && kids.length > CHILD_LIMIT))) {
        more = { id: `kids:${agent.key}`, count: open ? 0 : hiddenKids, x: colX(depth + 1), y: cursor + span };
        span += MORE_H + ROW_GAP;
      }
      span = Math.max(0, span - ROW_GAP);
      const width = depth === 0 ? ROOT_W : CHILD_W;
      placed.push({ agent, depth, x: colX(depth), y: cursor + Math.max(0, (span - height) / 2), w: width, h: height, kidKeys, more, folded });
      maxX = Math.max(maxX, colX(depth) + width + (folded ? 70 : 0), kidKeys.length || more ? colX(depth + 1) + CHILD_W : 0);
      return Math.max(height, span);
    };

    let cursor = top;
    for (const agent of visibleRoots) cursor += place(agent, 0, cursor) + ROW_GAP;
    let rootsMore = null;
    if (hiddenRoots > 0 || (rootsOpen && roots.length > ROOT_LIMIT)) {
      rootsMore = { id: `roots:${server.id}`, count: rootsOpen ? 0 : hiddenRoots, x: ROOT_X, y: cursor, label: "agents" };
      cursor += MORE_H + ROW_GAP;
    }
    const blockBottom = Math.max(cursor - ROW_GAP, top + 200);
    const hubY = top + (blockBottom - top) / 2;
    const positions = new Map(placed.map((entry) => [entry.agent.key, entry]));

    const active = roots.reduce((n, agent) => n + countActive(agent, children), 0);
    const ox = offsetX;
    const at = (n) => ({ ...n, x: n.x + ox });
    nodes.push(hubNode(server, ox, hubY, active, roots.length));
    const hubRight = ox + 190;
    for (const entry of placed) {
      if (entry.depth === 0) edges.push(edge(hubRight, hubY, ox + entry.x, entry.y + entry.h / 2, entry.agent.state, matched.has(entry.agent.key)));
    }
    if (rootsMore) {
      edges.push(edge(hubRight, hubY, ox + rootsMore.x, rootsMore.y + MORE_H / 2, "idle", true));
      nodes.push(moreNode(at(rootsMore)));
    }
    for (const entry of placed) {
      nodes.push(agentNode(at(entry), matched.has(entry.agent.key), entry.agent.key === selectedKey, now));
      for (const kidKey of entry.kidKeys) {
        const kid = positions.get(kidKey);
        if (kid) edges.push(edge(ox + entry.x + entry.w, entry.y + entry.h / 2, ox + kid.x, kid.y + kid.h / 2, kid.agent.state, matched.has(kidKey)));
      }
      if (entry.more) {
        edges.push(edge(ox + entry.x + entry.w, entry.y + entry.h / 2, ox + entry.more.x, entry.more.y + MORE_H / 2, "idle", true));
        nodes.push(moreNode(at(entry.more)));
      }
    }
    offsetX += maxX + SERVER_GAP;
    maxY = Math.max(maxY, blockBottom);
  }

  return { nodes, edges, bounds: { w: Math.max(offsetX - SERVER_GAP, 400) + 40, h: maxY + 40 } };
}

function byImportance(a, b) {
  return RANK[a.state] - RANK[b.state] || b.updatedAt.localeCompare(a.updatedAt);
}

/** Children worth showing on a folded parent: everything working or failed, then the most recent. */
function pickChildren(kids) {
  if (kids.length <= CHILD_LIMIT) return kids;
  const urgent = kids.filter((kid) => ACTIVE.has(kid.state) || kid.state === "failed");
  const rest = kids.filter((kid) => !urgent.includes(kid));
  return [...urgent, ...rest.slice(0, Math.max(0, CHILD_LIMIT - urgent.length))];
}

function countActive(agent, children) {
  let n = ACTIVE.has(agent.state) ? 1 : 0;
  for (const kid of children.get(agent.key) ?? []) n += countActive(kid, children);
  return n;
}

// ---- drawing --------------------------------------------------------------------------------------

function edge(x1, y1, x2, y2, state, isMatch) {
  const dx = Math.max(30, (x2 - x1) / 2);
  const tone = state === "blocked" ? "needs" : ACTIVE.has(state) ? "hot" : state === "failed" ? "failed" : "quiet";
  return `<g class="am-edge ${tone} ${isMatch ? "" : "dim"}">
    <path d="M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}"/>
    <circle cx="${x2}" cy="${y2}" r="3.5"/>
  </g>`;
}

function hubNode(server, x, centerY, active, roots) {
  const tone = server.status === "connected" ? "on" : server.status === "connecting" ? "pending" : "off";
  const meta =
    server.status === "connected"
      ? `${active} active · ${roots} agent${roots === 1 ? "" : "s"} in view`
      : `${server.status}${server.statusDetail ? ` · ${server.statusDetail}` : ""}`;
  return `<div class="am-hub ${tone}" style="left:${x}px; top:${centerY - 64}px">
    <svg viewBox="0 0 120 120" width="128" height="128" class="am-hub-disc">
      <circle cx="60" cy="60" r="58" class="disc"/>
      <circle cx="60" cy="60" r="44" class="ring" stroke-width="11" stroke-dasharray="58 11.1"/>
      <circle cx="60" cy="60" r="27" class="ring" stroke-width="10" stroke-dasharray="47 9.5"/>
      <circle cx="60" cy="60" r="10" class="core"/>
    </svg>
    <div class="am-hub-name">${esc(server.label)}</div>
    <div class="am-hub-meta">${esc(meta)}</div>
    <div class="am-hub-meta faint">${esc([server.platform, server.serverVersion && `t3code ${server.serverVersion}`].filter(Boolean).join(" · "))}</div>
  </div>`;
}

function agentNode({ agent, depth, x, y, w, h, folded }, isMatch, selected, now) {
  const state = agent.state;
  const root = depth === 0;
  const classes = ["am-card", `s-${state}`, root ? "root" : "child", !isMatch && "dim", selected && "selected", agent.stale && "stale"].filter(Boolean).join(" ");
  const where = [agent.projectTitle, agent.branch && `⎇ ${agent.branch}`].filter(Boolean).join("  ·  ");
  const kind = agent.relationship === "native-subagent" ? "subagent" : agent.relationship === "subagent" ? "delegated" : agent.relationship === "fork" ? "fork" : null;
  const when = ACTIVE.has(state) && agent.startedAt ? duration(now - Date.parse(agent.startedAt)) : ago(now, agent.updatedAt);

  let line;
  if (state === "blocked") line = `<div class="am-line needs"><b>Needs you</b> <span class="am-detail">${esc((agent.pending?.kind ?? "input").replaceAll(/[_-]/g, " "))}</span></div>`;
  else if (state === "failed") line = `<div class="am-line failed"><b>Failed</b> <span class="am-detail">${esc(agent.lastError ?? "")}</span></div>`;
  else if (agent.activity) {
    const a = agent.activity;
    line = `<div class="am-line ${a.live ? "live" : ""}">${a.live ? `<i class="am-live"></i>` : ""}<b>${esc(a.label)}</b> <span class="am-detail">${esc(a.detail ?? "")}</span></div>`;
  } else line = `<div class="am-line"><b>${esc(STATE_LABEL[state] ?? state)}</b></div>`;

  return `<div class="${classes}" data-key="${esc(agent.key)}" style="left:${x}px; top:${y}px; width:${w}px; height:${h}px">
    <div class="am-avatar">${glyph(agent.provider)}<i class="am-status"></i></div>
    <div class="am-body">
      <div class="am-top"><span class="am-title">${esc(agent.title)}</span><span class="am-when">${esc(when)}</span></div>
      ${root && where ? `<div class="am-where">${esc(where)}</div>` : ""}
      ${line}
    </div>
    ${kind ? `<span class="am-kind">${kind}</span>` : ""}
    ${folded ? `<button class="am-fold" data-expand="${esc(`kids:${agent.key}`)}" title="Show ${folded} subagent${folded === 1 ? "" : "s"}"><svg viewBox="0 0 16 16"><path d="M3 3v4.5a3 3 0 0 0 3 3h7M10 7.5l3 3-3 3"/></svg>${folded}</button>` : ""}
  </div>`;
}

function moreNode(more) {
  const text = more.count === 0 ? "Show less" : `+${more.count} more${more.label ? ` ${more.label}` : ""}`;
  return `<button class="am-more" data-expand="${esc(more.id)}" style="left:${more.x}px; top:${more.y}px">${esc(text)}</button>`;
}

export function glyph(provider) {
  const id = String(provider).toLowerCase();
  if (id.includes("claude")) {
    let rays = "";
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + (i % 2 ? 0.12 : 0);
      const r2 = i % 2 ? 8 : 10;
      rays += `<line x1="${12 + Math.cos(a) * 2.4}" y1="${12 + Math.sin(a) * 2.4}" x2="${12 + Math.cos(a) * r2}" y2="${12 + Math.sin(a) * r2}"/>`;
    }
    return `<svg viewBox="0 0 24 24" class="g claude"><g stroke-width="2.4" stroke-linecap="round">${rays}</g></svg>`;
  }
  if (id.includes("codex") || id.includes("openai")) {
    let petals = "";
    for (let i = 0; i < 6; i++) petals += `<rect x="9.4" y="2.2" width="5.2" height="9.8" rx="2.6" transform="rotate(${i * 60} 12 12)"/>`;
    return `<svg viewBox="0 0 24 24" class="g codex"><g fill="none" stroke-width="1.6">${petals}</g></svg>`;
  }
  if (id.includes("cursor")) {
    return `<svg viewBox="0 0 24 24" class="g cursor"><path d="M12 2.5 20.5 7.3v9.4L12 21.5 3.5 16.7V7.3Z M12 12 20.5 7.3 M12 12v9.5 M12 12 3.5 7.3" fill="none" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
  }
  if (id.includes("gemini") || id.includes("antigravity")) {
    return `<svg viewBox="0 0 24 24" class="g gemini"><path d="M12 2Q13.5 10.5 22 12 13.5 13.5 12 22 10.5 13.5 2 12 10.5 10.5 12 2Z"/></svg>`;
  }
  return `<span class="g text">${esc(id.slice(0, 2).toUpperCase())}</span>`;
}

function duration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d`;
}

function ago(now, iso) {
  const ms = now - Date.parse(iso);
  return ms < 10_000 ? "now" : `${duration(ms)} ago`;
}
