// Agent map as a starburst network. Each machine is a centre; its agents radiate out as dots.
// Distance from the centre is how long ago an agent last worked, so live work sits close in and
// history drifts outward. Subagents burst from their parent. Only agents that are working,
// blocked or failed get a label; everything else shows one on hover.
// Positions are in world units; everything is drawn in screen space so dots and labels keep
// their size while zooming. The view auto-fits until the user pans or zooms.

const ACTIVE = new Set(["running", "waiting", "blocked"]);
const INNER = 90;
const SPREAD = 24;
const CHILD_R = 30;
const CHILD_CAP = 24;
const BLOCK_GAP = 140;
const PAD = 36;

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const clip = (text, max) => {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

export function createMap(root, { onOpen }) {
  root.innerHTML = `<svg class="sb" xmlns="http://www.w3.org/2000/svg"></svg><button class="sb-fit" hidden>Fit</button>`;
  const svg = root.querySelector("svg");
  const fitButton = root.querySelector(".sb-fit");
  const view = { x: 0, y: 0, scale: 1 };
  let scene = null;
  let data = null;
  let autoFit = true;
  let hoverKey = null;

  function size() {
    const r = svg.getBoundingClientRect();
    return { w: r.width || 1200, h: r.height || 800 };
  }

  function fit() {
    if (!scene) return;
    const { w, h } = size();
    const b = scene.bounds;
    // Labels sit outside the dots; leave them room.
    view.scale = Math.min((w - PAD * 2 - 180) / b.w, (h - PAD * 2 - 50) / b.h, 2);
    view.x = w / 2 - (b.x + b.w / 2) * view.scale;
    view.y = h / 2 - (b.y + b.h / 2) * view.scale;
  }

  function draw() {
    if (!scene) return;
    svg.innerHTML = paint(scene, view, data, hoverKey, size());
  }

  function manual() {
    if (!autoFit) return;
    autoFit = false;
    fitButton.hidden = false;
  }

  let drag = null;
  svg.addEventListener("pointerdown", (event) => {
    drag = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y, moved: false, target: event.target };
  });
  window.addEventListener("pointermove", (event) => {
    if (drag) {
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
      if (!drag.moved) manual();
      drag.moved = true;
      svg.classList.add("dragging");
      view.x = drag.vx + dx;
      view.y = drag.vy + dy;
      draw();
      return;
    }
    const key = event.target.closest?.(".sb [data-key]")?.dataset.key ?? null;
    if (key !== hoverKey) {
      hoverKey = key;
      draw();
    }
  });
  window.addEventListener("pointerup", () => {
    if (!drag) return;
    const { moved, target } = drag;
    drag = null;
    svg.classList.remove("dragging");
    if (moved) return;
    const key = target.closest?.("[data-key]")?.dataset.key;
    if (key) onOpen(key);
  });
  svg.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      manual();
      const rect = svg.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        const cx = event.clientX - rect.left;
        const cy = event.clientY - rect.top;
        const next = Math.min(6, Math.max(0.1, view.scale * Math.exp(-event.deltaY * 0.01)));
        const k = next / view.scale;
        view.x = cx - (cx - view.x) * k;
        view.y = cy - (cy - view.y) * k;
        view.scale = next;
      } else {
        view.x -= event.deltaX;
        view.y -= event.deltaY;
      }
      draw();
    },
    { passive: false },
  );
  fitButton.addEventListener("click", () => {
    autoFit = true;
    fitButton.hidden = true;
    fit();
    draw();
  });
  new ResizeObserver(() => {
    if (autoFit && data) {
      scene = layout(data, size());
      fit();
    }
    draw();
  }).observe(svg);

  return {
    render(next) {
      data = next;
      scene = layout(next, size());
      if (autoFit) fit();
      draw();
    },
  };
}

// ---- layout (world units) ------------------------------------------------------------------------

function layout({ agents, servers, shown, children, now }, viewport) {
  const blocks = servers.map((server) => {
    const roots = [...shown]
      .map((key) => agents.get(key))
      .filter((agent) => agent.serverId === server.id && !(agent.parentKey && shown.has(agent.parentKey)));
    const nodes = [];
    let reach = INNER + 40;
    for (const agent of roots) {
      const angle = hashAngle(agent.key);
      const r = radius(agent, now);
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r;
      nodes.push({ agent, x, y, px: 0, py: 0, angle, depth: 0 });
      reach = Math.max(reach, r);
      burst(agent, x, y, angle, 1, nodes, shown, children);
    }
    for (const node of nodes) reach = Math.max(reach, Math.hypot(node.x, node.y));
    return { server, nodes, reach };
  });

  // Grid of machines that lets the map fit largest; each burst is stretched into an ellipse
  // matching its cell so the whole screen is used.
  const D = Math.max(...blocks.map((b) => b.reach * 2), 200) + BLOCK_GAP;
  let best = { cols: 1, scale: 0 };
  for (let cols = 1; cols <= Math.max(1, blocks.length); cols++) {
    const rows = Math.ceil(blocks.length / cols);
    const scale = Math.min(viewport.w / (cols * D), viewport.h / (rows * D));
    if (scale > best.scale) best = { cols, rows, scale };
  }
  const cellAspect = viewport.w / best.cols / (viewport.h / best.rows);
  const k = Math.min(1.45, Math.max(0.7, Math.sqrt(cellAspect)));
  const cellW = D * k;
  const cellH = D / k;
  const placed = blocks.map((block, i) => {
    for (const node of block.nodes) {
      node.x *= k;
      node.y /= k;
      node.px *= k;
      node.py /= k;
    }
    return { ...block, cx: (i % best.cols) * cellW + cellW / 2, cy: Math.floor(i / best.cols) * cellH + cellH / 2 };
  });
  const usedRows = Math.ceil(blocks.length / best.cols) || 1;
  const usedCols = Math.min(best.cols, blocks.length) || 1;
  return { blocks: placed, bounds: { x: BLOCK_GAP / 2, y: BLOCK_GAP / 2, w: usedCols * cellW - BLOCK_GAP, h: usedRows * cellH - BLOCK_GAP } };
}

function burst(parent, px, py, angle, depth, nodes, shown, children) {
  const kids = (children.get(parent.key) ?? []).filter((kid) => shown.has(kid.key)).slice(0, CHILD_CAP);
  const fan = Math.min(Math.PI * 1.2, 0.5 + kids.length * 0.18);
  kids.forEach((kid, i) => {
    const a = angle + (kids.length === 1 ? 0 : -fan / 2 + (fan * i) / (kids.length - 1));
    const r = CHILD_R * (ACTIVE.has(kid.state) ? 1.25 : 1) + (i % 3) * 7;
    const x = px + Math.cos(a) * r;
    const y = py + Math.sin(a) * r;
    nodes.push({ agent: kid, x, y, px, py, angle: a, depth });
    if (depth < 3) burst(kid, x, y, a, depth + 1, nodes, shown, children);
  });
}

/** Live work sits close in; finished agents drift out with time since they last worked. */
function radius(agent, now) {
  if (ACTIVE.has(agent.state)) return INNER + (hash(agent.key) % 30);
  const minutes = Math.max(0, (now - Date.parse(agent.updatedAt)) / 60e3);
  return INNER + 56 + SPREAD * Math.log2(1 + minutes / 10);
}

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function hashAngle(key) {
  return ((hash(key) % 3600) / 3600) * Math.PI * 2;
}

// ---- painting (screen space) ---------------------------------------------------------------------

function paint(scene, view, data, hoverKey, viewport) {
  const { matched, selectedKey, now } = data;
  const S = (wx, wy) => [view.x + wx * view.scale, view.y + wy * view.scale];
  const lines = [];
  const dots = [];
  const hubs = [];
  const labelCandidates = [];

  for (const block of scene.blocks) {
    const [hx, hy] = S(block.cx, block.cy);
    for (const node of block.nodes) {
      const { agent } = node;
      const [x, y] = S(block.cx + node.x, block.cy + node.y);
      const [fx, fy] = S(block.cx + node.px, block.cy + node.py);
      const state = agent.state;
      const isMatch = matched.has(agent.key);
      const tone = state === "blocked" ? "needs" : ACTIVE.has(state) ? "hot" : state === "failed" ? "bad" : "";
      lines.push(`<line class="sb-line ${tone} ${isMatch ? "" : "dim"} ${node.depth ? "sub" : ""}" x1="${fx}" y1="${fy}" x2="${x}" y2="${y}"/>`);
      dots.push({ depth: ACTIVE.has(state) ? 2 : state === "failed" ? 1 : 0, svg: dot(agent, x, y, node.depth, isMatch, agent.key === selectedKey || agent.key === hoverKey) });
      const recentFailure = state === "failed" && now - Date.parse(agent.updatedAt) < 6 * 3600e3;
      const wants = agent.key === hoverKey || agent.key === selectedKey ? 0 : state === "blocked" ? 1 : ACTIVE.has(state) && node.depth === 0 ? 2 : recentFailure && node.depth === 0 ? 3 : ACTIVE.has(state) ? 4 : null;
      if (wants !== null && (isMatch || wants === 0)) labelCandidates.push({ agent, x, y, angle: node.angle, priority: wants, depth: node.depth });
    }
    hubs.push(hub(block.server, hx, hy, block.nodes));
  }

  // Labels: highest priority first, skipped when they would collide.
  const taken = scene.blocks.map((block) => {
    const [hx, hy] = S(block.cx, block.cy);
    return { x: hx - 80, y: hy + 14, w: 160, h: 40 };
  });
  const labels = [];
  for (const c of labelCandidates.sort((a, b) => a.priority - b.priority)) {
    const label = placeLabel(c, taken, viewport);
    if (label) labels.push(label);
  }

  return `<g>${lines.join("")}</g><g>${dots.sort((a, b) => a.depth - b.depth).map((d) => d.svg).join("")}</g><g>${hubs.join("")}</g><g>${labels.join("")}</g>`;
}

function dot(agent, x, y, depth, isMatch, focused) {
  const state = agent.state;
  const cls = `sb-dot s-${state} ${isMatch ? "" : "dim"} ${focused ? "focus" : ""} ${agent.stale ? "stale" : ""}`;
  if (state === "running" || state === "waiting" || state === "blocked") {
    const r = depth ? 7 : 10;
    return `<g class="${cls}" data-key="${esc(agent.key)}">
      <circle cx="${x}" cy="${y}" r="${r + 7}" class="halo"/>
      <circle cx="${x}" cy="${y}" r="${r}" class="core"/>
      ${depth ? "" : `<g transform="translate(${x - 6.5} ${y - 6.5}) scale(${13 / 24})" class="sb-glyph">${glyphInner(agent.provider)}</g>`}
      <circle cx="${x}" cy="${y}" r="${r + 10}" class="hit"/>
    </g>`;
  }
  const r = state === "failed" ? 4.5 : depth ? 2.2 : state === "completed" ? 3.6 : 3;
  return `<g class="${cls}" data-key="${esc(agent.key)}"><circle cx="${x}" cy="${y}" r="${r}" class="core"/><circle cx="${x}" cy="${y}" r="${Math.max(r + 5, 8)}" class="hit"/></g>`;
}

function hub(server, x, y, nodes) {
  const active = nodes.filter((n) => ACTIVE.has(n.agent.state)).length;
  const needs = nodes.filter((n) => n.agent.state === "blocked").length;
  const tone = server.status === "connected" ? "on" : server.status === "connecting" ? "pending" : "off";
  const sub = server.status !== "connected" ? server.status : needs ? `${needs} need${needs === 1 ? "s" : ""} you` : active ? `${active} working` : "";
  return `<g class="sb-hub ${tone}">
    <circle cx="${x}" cy="${y}" r="15" class="ring"/>
    <circle cx="${x}" cy="${y}" r="8" class="core"/>
    <text x="${x}" y="${y + 32}" class="name">${esc(server.label)}</text>
    ${sub ? `<text x="${x}" y="${y + 46}" class="sub ${needs ? "needs" : ""}">${esc(sub)}</text>` : ""}
  </g>`;
}

function placeLabel({ agent, x, y, angle, depth }, taken, viewport) {
  const title = clip(agent.title, 34);
  const state = agent.state;
  const line =
    state === "blocked"
      ? `needs you · ${(agent.pending?.kind ?? "input").replaceAll(/[_-]/g, " ")}`
      : state === "failed"
        ? agent.lastError ?? "failed"
        : agent.activity
          ? `${agent.activity.label}${agent.activity.detail ? ` · ${agent.activity.detail}` : ""}`
          : (agent.projectTitle ?? "");
  const second = clip(line, 40);
  const w = Math.max(title.length * 6.3, second.length * 5.7) + 18;
  const h = second ? 34 : 20;
  const right = Math.cos(angle) >= 0;
  const gap = ACTIVE.has(state) ? (depth ? 14 : 18) : 9;
  const options = right ? [[gap, -h / 2], [gap, -h - 4], [gap, 4], [-gap - w, -h / 2]] : [[-gap - w, -h / 2], [-gap - w, -h - 4], [-gap - w, 4], [gap, -h / 2]];
  for (const [dx, dy] of options) {
    const r = { x: x + dx, y: y + dy, w, h };
    if (r.x < 4 || r.y < 4 || r.x + w > viewport.w - 4 || r.y + h > viewport.h - 4) continue;
    if (taken.some((t) => r.x < t.x + t.w + 4 && r.x + r.w + 4 > t.x && r.y < t.y + t.h + 4 && r.y + r.h + 4 > t.y)) continue;
    taken.push(r);
    const tone = state === "blocked" ? "needs" : state === "failed" ? "bad" : agent.activity?.live ? "live" : "";
    return `<g class="sb-label" data-key="${esc(agent.key)}">
      <rect x="${r.x}" y="${r.y}" width="${w}" height="${h}" rx="6"/>
      <text x="${r.x + 9}" y="${r.y + 14}" class="t">${esc(title)}</text>
      ${second ? `<text x="${r.x + 9}" y="${r.y + 27}" class="d ${tone}">${esc(second)}</text>` : ""}
    </g>`;
  }
  return null;
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
