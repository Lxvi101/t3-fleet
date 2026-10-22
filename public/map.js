// Agent map as a tree of cards, grouped by machine.
//   a thread is a card; its subagents hang below it in a row, and theirs stack beneath them
//   trees with something running or waiting on you are expanded and sorted first
// Cards keep their DOM node between renders, so moving, appearing and finishing all animate.
// The view auto-fits until the user pans or zooms.

const ACTIVE = new Set(["running", "waiting", "blocked"]);
const RANK = { blocked: 0, running: 1, waiting: 2, failed: 3, unknown: 4, completed: 5, cancelled: 6, idle: 7 };
const PILL = { running: "Running", waiting: "Waiting", blocked: "Needs you", idle: "Idle", completed: "Done", failed: "Failed", cancelled: "Stopped", unknown: "Unknown" };

const CARD_W = 272;
const CARD_H = 136;
const SIB_GAP = 22; // between subagents in a row
const DROP = 48; // root card to its row of subagents
const INDENT = 40; // stacked grandchildren
const STACK_GAP = 14;
const MORE_W = 96;
const MORE_H = 34;
const TREE_GAP_X = 48;
const TREE_GAP_Y = 44;
const HEAD_H = 44; // machine heading
const MACHINE_GAP = 64;
const MAX_ROW = 4; // subagents shown per row before "+N"
const MAX_STACK = 3;
const PAD = 28;
const TOP = 48; // room for the summary chips
const MIN_SCALE = 0.32;

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function createMap(root, { onOpen, onFilter = () => {}, bottomInset = () => 0 }) {
  root.innerHTML = `<div class="tv"><div class="tv-world"><svg class="tv-lines" xmlns="http://www.w3.org/2000/svg"></svg><div class="tv-cards"></div></div></div>
    <div class="tv-sum"></div><div class="tv-empty" hidden></div><button class="tv-fit" hidden>Fit</button>`;
  const stage = root.querySelector(".tv");
  const world = root.querySelector(".tv-world");
  const svg = root.querySelector(".tv-lines");
  const layer = root.querySelector(".tv-cards");
  const sum = root.querySelector(".tv-sum");
  const empty = root.querySelector(".tv-empty");
  const fitButton = root.querySelector(".tv-fit");
  const view = { x: 0, y: 0, scale: 1 };
  const toggled = new Map(); // key -> expanded, set by the user
  const nodes = new Map(); // key -> { el, html, timer }
  const paths = new Map();
  let scene = null;
  let data = null;
  let autoFit = true;

  const size = () => {
    const r = root.getBoundingClientRect();
    return { w: r.width || 1200, h: (r.height || 800) - bottomInset() };
  };

  function fit() {
    if (!scene) return;
    const { w, h } = size();
    const b = scene.bounds;
    const scale = Math.min((w - PAD * 2) / b.w, (h - TOP - PAD) / b.h, 1);
    view.scale = Math.max(MIN_SCALE, scale);
    view.x = Math.max(PAD, (w - b.w * view.scale) / 2);
    view.y = scale < MIN_SCALE ? TOP : TOP + Math.max(0, (h - TOP - PAD - b.h * view.scale) / 2);
  }

  function place() {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    stage.classList.toggle("far", view.scale < 0.62);
  }

  function manual() {
    stage.classList.add("instant");
    if (!autoFit) return;
    autoFit = false;
    fitButton.hidden = false;
  }

  function relayout() {
    if (!data) return;
    scene = layout(data, toggled, size());
    if (autoFit) fit();
    paint();
    place();
  }

  // ---- DOM reconciliation ----

  function upsert(map, parent, key, create, html, apply) {
    let entry = map.get(key);
    if (!entry) {
      const el = create();
      apply(el);
      el.classList.add("enter");
      parent.appendChild(el);
      entry = { el, html: null, timer: null };
      map.set(key, entry);
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove("enter")));
    } else {
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
        entry.el.classList.remove("leave");
      }
      apply(entry.el);
    }
    if (html !== null && entry.html !== html) {
      entry.el.innerHTML = html;
      entry.html = html;
    }
    entry.seen = true;
  }

  function sweep(map) {
    for (const [key, entry] of map) {
      if (entry.seen) {
        entry.seen = false;
        continue;
      }
      if (entry.timer) continue;
      entry.el.classList.add("leave");
      entry.timer = setTimeout(() => {
        entry.el.remove();
        map.delete(key);
      }, 320);
    }
  }

  function paint() {
    const { matched, selectedKey, now } = data;
    for (const item of scene.items) {
      if (item.type === "card") {
        const { agent, x, y } = item;
        const cls = `card s-${agent.state}${agent.stale ? " stale" : ""}${agent.key === selectedKey ? " sel" : ""}${matched.has(agent.key) ? "" : " dim"}${item.root ? " root" : ""}`;
        upsert(nodes, layer, agent.key, () => Object.assign(document.createElement("div"), { className: "card" }), cardHtml(item, now), (el) => {
          el.className = cls + (el.classList.contains("enter") ? " enter" : "");
          el.dataset.key = agent.key;
          el.style.translate = `${x}px ${y}px`;
        });
      } else if (item.type === "more") {
        upsert(nodes, layer, `more:${item.parentKey}`, () => Object.assign(document.createElement("button"), { className: "more" }), `+${item.count} more`, (el) => {
          el.dataset.open = item.parentKey;
          el.style.translate = `${item.x}px ${item.y}px`;
        });
      } else if (item.type === "head") {
        upsert(nodes, layer, `head:${item.server.id}`, () => Object.assign(document.createElement("div"), { className: "mhead" }), headHtml(item), (el) => {
          el.style.translate = `${item.x}px ${item.y}px`;
        });
      }
    }
    for (const line of scene.lines) {
      upsert(paths, svg, line.id, () => document.createElementNS("http://www.w3.org/2000/svg", line.dot ? "circle" : "path"), null, (el) => {
        el.setAttribute("class", `${line.dot ? "tv-joint" : "tv-link"}${line.hot ? " hot" : ""}`);
        if (line.dot) {
          el.setAttribute("r", "3.5");
          el.style.translate = `${line.x}px ${line.y}px`;
        } else {
          el.setAttribute("pathLength", "1");
          el.setAttribute("d", line.d);
          el.style.d = `path("${line.d}")`;
        }
      });
    }
    sweep(nodes);
    sweep(paths);
    // Hot lines draw over quiet ones where trunks overlap.
    for (const line of scene.lines) if (line.hot) svg.appendChild(paths.get(line.id).el);

    const counts = scene.counts;
    const chip = (state, text, cls) => `<button class="chip ${cls}${data.stateFilter === state ? " on" : ""}" data-filter="${state}">${text}</button>`;
    sum.innerHTML = `<span class="total">${counts.total} agent${counts.total === 1 ? "" : "s"}</span>${counts.running ? chip("running", `${counts.running} running`, "run") : ""}${
      counts.failed ? chip("failed", `${counts.failed} failed`, "bad") : ""
    }${data.stateFilter && !counts[data.stateFilter] ? chip(data.stateFilter, `${data.stateFilter} ✕`, "") : ""}`;
    empty.hidden = scene.roots > 0;
    empty.textContent = data.window === "active" ? "Nothing running right now." : "No agents in this window.";
  }

  // ---- interaction ----

  let drag = null;
  root.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest(".tv-sum, .tv-fit")) return;
    drag = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y, moved: false, target: event.target };
  });
  window.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
    if (!drag.moved) manual();
    drag.moved = true;
    stage.classList.add("dragging");
    view.x = drag.vx + dx;
    view.y = drag.vy + dy;
    place();
  });
  window.addEventListener("pointerup", () => {
    if (!drag) return;
    const { moved, target } = drag;
    drag = null;
    stage.classList.remove("dragging");
    if (moved) return;
    const toggle = target.closest?.("[data-toggle]");
    if (toggle) {
      const key = toggle.closest("[data-key]").dataset.key;
      const item = scene.items.find((i) => i.type === "card" && i.agent.key === key);
      toggled.set(key, !item?.expanded);
      return relayout();
    }
    const key = target.closest?.("[data-open]")?.dataset.open ?? target.closest?.("[data-key]")?.dataset.key;
    if (key) onOpen(key);
  });
  root.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      manual();
      const rect = root.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        const cx = event.clientX - rect.left;
        const cy = event.clientY - rect.top;
        const next = Math.min(2, Math.max(0.15, view.scale * Math.exp(-event.deltaY * 0.01)));
        const k = next / view.scale;
        view.x = cx - (cx - view.x) * k;
        view.y = cy - (cy - view.y) * k;
        view.scale = next;
      } else {
        view.x -= event.deltaX;
        view.y -= event.deltaY;
      }
      place();
    },
    { passive: false },
  );
  sum.addEventListener("click", (event) => {
    const state = event.target.closest("[data-filter]")?.dataset.filter;
    if (state) onFilter(state);
  });
  fitButton.addEventListener("click", () => {
    autoFit = true;
    fitButton.hidden = true;
    stage.classList.remove("instant");
    relayout();
  });
  new ResizeObserver(() => {
    stage.classList.add("instant");
    relayout();
    requestAnimationFrame(() => autoFit && stage.classList.remove("instant"));
  }).observe(root);

  return {
    refit: relayout,
    render(next) {
      data = next;
      relayout();
    },
  };
}

// ---- layout (world pixels) -----------------------------------------------------------------------

function layout({ agents, servers, shown, children, now }, toggled, viewport) {
  const kidsOf = (agent) => (children.get(agent.key) ?? []).filter((kid) => shown.has(kid.key)).sort(byRank);
  const hot = new Map();
  const isHot = (agent) => {
    if (!hot.has(agent.key)) hot.set(agent.key, ACTIVE.has(agent.state) || kidsOf(agent).some(isHot));
    return hot.get(agent.key);
  };
  const best = (agent) => Math.min(RANK[agent.state] ?? 9, ...kidsOf(agent).map(best));

  // Measure every tree before placing anything.
  function measure(agent, depth) {
    const kids = kidsOf(agent);
    const expanded = kids.length > 0 && (toggled.get(agent.key) ?? isHot(agent));
    const node = { agent, depth, kids: [], more: 0, expanded, total: kids.length, w: CARD_W, h: CARD_H };
    if (!expanded) return node;
    const cap = depth === 0 ? MAX_ROW : MAX_STACK;
    node.kids = kids.slice(0, cap).map((kid) => measure(kid, depth + 1));
    node.more = kids.length - node.kids.length;
    if (depth === 0) {
      const row = node.kids.reduce((s, k) => s + k.w, 0) + SIB_GAP * (node.kids.length - 1) + (node.more ? SIB_GAP + MORE_W : 0);
      node.rowW = row;
      node.w = Math.max(CARD_W, row);
      node.h = CARD_H + DROP + Math.max(...node.kids.map((k) => k.h), node.more ? MORE_H : 0);
    } else {
      for (const kid of node.kids) {
        node.h += STACK_GAP + kid.h;
        node.w = Math.max(node.w, INDENT + kid.w);
      }
      if (node.more) node.h += STACK_GAP + MORE_H;
    }
    return node;
  }

  const items = [];
  const lines = [];
  function put(node, x, y) {
    const { agent } = node;
    if (node.depth === 0) {
      const cx = x + (node.w - CARD_W) / 2;
      items.push({ type: "card", agent, x: cx, y, root: true, expanded: node.expanded, total: node.total });
      if (!node.kids.length) return;
      const px = cx + CARD_W / 2;
      const py = y + CARD_H;
      const busY = py + DROP / 2;
      const ky = y + CARD_H + DROP;
      lines.push({ id: `j:${agent.key}`, dot: true, x: px, y: py, hot: isHot(agent) });
      let kx = x + (node.w - node.rowW) / 2;
      for (const kid of node.kids) {
        const mid = kx + CARD_W / 2;
        const dir = Math.sign(mid - px);
        const r = Math.min(10, Math.abs(mid - px));
        const d = dir === 0 ? `M ${px} ${py} V ${ky}` : `M ${px} ${py} V ${busY} H ${mid - dir * r} Q ${mid} ${busY} ${mid} ${busY + r} V ${ky}`;
        lines.push({ id: `l:${kid.agent.key}`, d, hot: isHot(kid.agent) });
        put(kid, kx, ky);
        kx += kid.w + SIB_GAP;
      }
      if (node.more) items.push({ type: "more", parentKey: agent.key, count: node.more, x: kx, y: ky + (CARD_H - MORE_H) / 2 });
      return;
    }
    items.push({ type: "card", agent, x, y, root: false, expanded: node.expanded, total: node.total });
    if (!node.kids.length) return;
    const sx = x + 26;
    const sy = y + CARD_H;
    lines.push({ id: `j:${agent.key}`, dot: true, x: sx, y: sy, hot: isHot(agent) });
    let ky = y + CARD_H;
    for (const kid of node.kids) {
      ky += STACK_GAP;
      const ty = ky + 30;
      lines.push({ id: `l:${kid.agent.key}`, d: `M ${sx} ${sy} V ${ty - 10} Q ${sx} ${ty} ${sx + 10} ${ty} H ${x + INDENT}`, hot: isHot(kid.agent) });
      put(kid, x + INDENT, ky);
      ky += kid.h;
    }
    if (node.more) items.push({ type: "more", parentKey: agent.key, count: node.more, x: x + INDENT, y: ky + STACK_GAP });
  }

  const machines = servers.map((server) => {
    const roots = [...shown]
      .map((key) => agents.get(key))
      .filter((a) => a.serverId === server.id && !(a.parentKey && shown.has(a.parentKey)))
      .sort((a, b) => best(a) - best(b) || b.updatedAt.localeCompare(a.updatedAt));
    return { server, trees: roots.map((agent) => measure(agent, 0)) };
  });
  const trees = machines.flatMap((m) => m.trees);

  // Try a range of row widths and keep the packing that fits the viewport at the largest scale.
  const aspectW = viewport.w - PAD * 2;
  const aspectH = Math.max(200, viewport.h - TOP - PAD);
  const widest = Math.max(CARD_W, ...trees.map((t) => t.w));
  // Each machine packs its trees into rows no wider than target; machine blocks then flow the same way.
  const pack = (target, emit) => {
    let bx = 0;
    let by = 0;
    let rowBottom = 0;
    let width = 0;
    for (const { server, trees: list } of machines) {
      const placed = [];
      let x = 0;
      let y = HEAD_H;
      let rowH = 0;
      let blockW = 240;
      for (const tree of list) {
        if (x > 0 && x + tree.w > target) {
          y += rowH + TREE_GAP_Y;
          x = 0;
          rowH = 0;
        }
        placed.push([tree, x, y]);
        x += tree.w + TREE_GAP_X;
        blockW = Math.max(blockW, x - TREE_GAP_X);
        rowH = Math.max(rowH, tree.h);
      }
      const blockH = y + rowH;
      if (bx > 0 && bx + blockW > target) {
        bx = 0;
        by = rowBottom + MACHINE_GAP;
      }
      if (emit) {
        items.push({ type: "head", server, x: bx, y: by, active: list.filter((t) => isHot(t.agent)).length, count: list.length });
        for (const [tree, x, y] of placed) put(tree, bx + x, by + y);
      }
      width = Math.max(width, bx + blockW);
      rowBottom = Math.max(rowBottom, by + blockH);
      bx += blockW + MACHINE_GAP * 1.5;
    }
    return { w: Math.max(width, 360), h: Math.max(120, rowBottom) };
  };
  let bestTarget = widest;
  let bestScale = 0;
  for (let target = widest; target <= widest + 12 * (CARD_W + TREE_GAP_X) * 4; target += (CARD_W + TREE_GAP_X) / 2) {
    const b = pack(target, false);
    const scale = Math.min(aspectW / b.w, aspectH / b.h);
    if (scale > bestScale + 1e-6) {
      bestScale = scale;
      bestTarget = target;
    }
    if (b.w < target - CARD_W) break; // wider targets no longer change anything
  }
  const bounds = pack(bestTarget, true);

  const cards = items.filter((i) => i.type === "card").map((i) => i.agent);
  const counts = {
    total: cards.length,
    running: cards.filter((a) => ACTIVE.has(a.state)).length,
    failed: cards.filter((a) => a.state === "failed").length,
  };
  return { items, lines, counts, roots: trees.length, bounds };
}

function byRank(a, b) {
  return (RANK[a.state] ?? 9) - (RANK[b.state] ?? 9) || b.updatedAt.localeCompare(a.updatedAt);
}

// ---- card content --------------------------------------------------------------------------------

function cardHtml({ agent, root, expanded, total }, now) {
  const { text, tone, live } = task(agent);
  const model = prettyModel(agent.model) ?? agent.provider;
  const active = ACTIVE.has(agent.state);
  const time = agent.stale ? `last seen ${ago(agent.updatedAt, now)}` : active && agent.startedAt ? elapsed(now - Date.parse(agent.startedAt)) : ago(agent.updatedAt, now);
  const extra = !root && agent.work ? `${agent.work} step${agent.work === 1 ? "" : "s"}` : agent.relationship === "fork" ? "fork" : "";
  return `<div class="c-head"><span class="c-ico">${glyph(agent.provider)}</span><span class="c-name"><b>${esc(agent.title)}</b><small>${esc(model)}</small></span><span class="pill s-${agent.state}"><i></i>${PILL[agent.state] ?? agent.state}</span></div>
    <div class="c-task ${tone}">${live ? `<i class="live"></i>` : ""}${esc(text)}</div>
    <div class="c-foot"><span class="when"><b>${esc(time)}</b>${extra ? ` · ${esc(extra)}` : ""}</span>${
      total ? `<button class="c-kids${expanded ? " open" : ""}" data-toggle title="${expanded ? "Collapse" : "Show"} subagents">${total}<svg viewBox="0 0 10 10"><path d="M2.5 4l2.5 2.5L7.5 4"/></svg></button>` : ""
    }</div>`;
}

/** The line under the title: what the agent is doing, why it matters, or else where it works. */
function task(agent) {
  if (agent.state === "blocked") return { text: `Needs your ${(agent.pending?.kind ?? "input").replaceAll(/[_-]/g, " ")}`, tone: "needs" };
  if (agent.state === "failed" && agent.lastError) return { text: agent.lastError, tone: "bad" };
  const a = agent.activity;
  if (a && ACTIVE.has(agent.state)) return { text: a.detail ? `${a.label}: ${a.detail}` : a.label, tone: "doing", live: a.live };
  if (a?.detail) return { text: a.detail, tone: "doing" };
  const project = agent.projectTitle && agent.projectTitle !== "No project" ? agent.projectTitle : null;
  return { text: [project, agent.branch].filter(Boolean).join(" · "), tone: "where" };
}

function headHtml({ server, active, count }) {
  const status = server.status === "connected" ? "on" : server.status === "connecting" ? "pending" : "off";
  const note =
    server.status === "connected"
      ? [active ? `${active} working` : null, `${count} thread${count === 1 ? "" : "s"}`].filter(Boolean).join(" · ")
      : `${server.status}${server.statusDetail ? ` · ${server.statusDetail}` : ""}`;
  return `<i class="${status}"></i><b>${esc(server.label)}</b><span>${esc(note)}</span>`;
}

export function prettyModel(model) {
  if (!model) return null;
  let id = model.split("/").pop().replace(/^claude-/, "");
  const gpt = id.startsWith("gpt-");
  if (gpt) id = id.slice(4);
  const out = [];
  let nums = [];
  for (const part of id.split("-")) {
    if (/^\d+(\.\d+)?$/.test(part)) {
      nums.push(part);
      continue;
    }
    if (nums.length) out.push(nums.splice(0).join("."));
    out.push(part.length <= 2 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1));
  }
  if (nums.length) out.push(nums.join("."));
  if (!gpt) return out.join(" ");
  return `GPT-${out.join(" ")}`;
}

function elapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

function ago(iso, now = Date.now()) {
  const m = Math.floor((now - Date.parse(iso)) / 60e3);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

// ---- provider glyphs -----------------------------------------------------------------------------

function glyphInner(provider) {
  const id = String(provider).toLowerCase();
  if (id.includes("claude")) {
    let rays = "";
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + (i % 2 ? 0.12 : 0);
      const r2 = i % 2 ? 8 : 10;
      rays += `<line x1="${12 + Math.cos(a) * 2.4}" y1="${12 + Math.sin(a) * 2.4}" x2="${12 + Math.cos(a) * r2}" y2="${12 + Math.sin(a) * r2}"/>`;
    }
    return `<g class="claude" stroke-width="2.6" stroke-linecap="round">${rays}</g>`;
  }
  if (id.includes("codex") || id.includes("openai")) {
    let petals = "";
    for (let i = 0; i < 6; i++) petals += `<rect x="9.4" y="2.2" width="5.2" height="9.8" rx="2.6" transform="rotate(${i * 60} 12 12)"/>`;
    return `<g class="codex" fill="none" stroke-width="2">${petals}</g>`;
  }
  if (id.includes("cursor")) {
    return `<path class="cursor" d="M12 2.5 20.5 7.3v9.4L12 21.5 3.5 16.7V7.3Z M12 12 20.5 7.3 M12 12v9.5 M12 12 3.5 7.3" fill="none" stroke-width="2" stroke-linejoin="round"/>`;
  }
  if (id.includes("gemini") || id.includes("antigravity")) {
    return `<path class="gemini" d="M12 2Q13.5 10.5 22 12 13.5 13.5 12 22 10.5 13.5 2 12 10.5 10.5 12 2Z"/>`;
  }
  return `<circle class="other" cx="12" cy="12" r="5"/>`;
}

export function glyph(provider) {
  return `<svg viewBox="0 0 24 24" class="g">${glyphInner(provider)}</svg>`;
}
