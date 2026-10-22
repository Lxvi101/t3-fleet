// Agent map as a radar, one per machine.
//   distance from the centre = time since the agent last worked (rings are labelled 1h, 6h, …)
//   sector                   = project
//   dot size                 = how much work the thread has done
//   colour                   = state; only working or blocked agents get a line to the centre
// Subagents orbit their parent. Positions are world units; everything is painted in screen
// space so dots and text keep their size while zooming. The view auto-fits until the user
// pans or zooms.

const ACTIVE = new Set(["running", "waiting", "blocked"]);
const R0 = 46;
const R_NOW = 92;
const R1 = 400;
const CHILD_R = 22;
const CHILD_CAP = 20;
const LABEL_ROOM = 120;
const BLOCK_GAP = 60;
const PAD = 28;

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const clip = (text, max) => {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

export function createMap(root, { onOpen, bottomInset = () => 0 }) {
  root.innerHTML = `<svg class="sb" xmlns="http://www.w3.org/2000/svg"></svg><button class="sb-fit" hidden>Fit</button>`;
  const svg = root.querySelector("svg");
  const fitButton = root.querySelector(".sb-fit");
  const view = { x: 0, y: 0, scale: 1 };
  let scene = null;
  let data = null;
  let autoFit = true;
  let hoverKey = null;

  const size = () => {
    const r = svg.getBoundingClientRect();
    return { w: r.width || 1200, h: r.height || 800 };
  };

  function fit() {
    if (!scene) return;
    const { w, h } = size();
    const b = scene.bounds;
    // The chat composer floats over the bottom of the map.
    const usableH = h - bottomInset();
    view.scale = Math.min((w - PAD * 2) / b.w, (usableH - PAD * 2) / b.h, 1.8);
    view.x = w / 2 - (b.x + b.w / 2) * view.scale;
    view.y = usableH / 2 - (b.y + b.h / 2) * view.scale;
  }

  const draw = () => {
    if (scene) svg.innerHTML = paint(scene, view, data, hoverKey, size());
  };

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
    scene = layout(data, { ...size(), h: size().h - bottomInset() });
    fit();
    draw();
  });

  // Called when the space the map may use changes (e.g. the chat grows).
  function refit() {
    if (!autoFit || !data) return;
    scene = layout(data, { ...size(), h: size().h - bottomInset() });
    fit();
    draw();
  }
  new ResizeObserver(() => {
    if (autoFit && data) {
      scene = layout(data, { ...size(), h: size().h - bottomInset() });
      fit();
    }
    draw();
  }).observe(svg);

  return {
    refit,
    render(next) {
      data = next;
      scene = layout(next, { ...size(), h: size().h - bottomInset() });
      if (autoFit) fit();
      draw();
    },
  };
}

// ---- layout (world units) ------------------------------------------------------------------------

const WINDOW_MIN = { active: 60, "24h": 1440, "7d": 10080 };
const TICKS = { active: [], "24h": [60, 360, 1440], "7d": [60, 1440, 4320, 10080] };

function layout({ agents, servers, shown, children, now, window }, viewport) {
  const span = WINDOW_MIN[window] ?? 1440;
  const radiusFor = (agent) => {
    if (ACTIVE.has(agent.state)) return R_NOW - 22 + (hash(agent.key) % 26);
    const minutes = Math.max(0, (now - Date.parse(agent.updatedAt)) / 60e3);
    const t = Math.min(1, Math.log1p(minutes / 4) / Math.log1p(span / 4));
    return R_NOW + 14 + t * (R1 - R_NOW - 14);
  };
  const ringRadius = (minutes) => R_NOW + 14 + (Math.log1p(minutes / 4) / Math.log1p(span / 4)) * (R1 - R_NOW - 14);

  const blocks = servers.map((server) => {
    const roots = [...shown].map((key) => agents.get(key)).filter((a) => a.serverId === server.id && !(a.parentKey && shown.has(a.parentKey)));
    const groups = new Map();
    for (const agent of roots) {
      const name = agent.projectTitle ?? "No project";
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(agent);
    }
    // Sectors in a stable (alphabetical) order, sized by agent count with a floor.
    const projects = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const weights = projects.map(([, list]) => Math.max(1.4, list.length ** 0.75));
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    const gap = projects.length > 1 ? 0.035 : 0;
    const usable = Math.PI * 2 - gap * projects.length;
    let angle = -Math.PI / 2;
    const sectors = [];
    const nodes = [];
    projects.forEach(([name, list], i) => {
      const a0 = angle + gap / 2;
      const a1 = a0 + (usable * weights[i]) / total;
      angle = a1 + gap / 2;
      const ordered = [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      ordered.forEach((agent, j) => {
        const a = a0 + ((j + 0.5) / ordered.length) * (a1 - a0);
        const r = radiusFor(agent);
        const x = Math.cos(a) * r;
        const y = Math.sin(a) * r;
        nodes.push({ agent, x, y, px: 0, py: 0, angle: a, depth: 0 });
        orbit(agent, x, y, a, 1, nodes, shown, children);
      });
      sectors.push({
        name,
        a0,
        a1,
        count: list.length,
        active: list.filter((agent) => subtreeActive(agent, children)).length,
        needs: list.filter((agent) => subtreeState(agent, children, "blocked")).length,
      });
    });
    return { server, nodes, sectors };
  });

  // The outer edge is the window itself, so only inner rings are labelled.
  const ticks = (TICKS[window] ?? []).filter((m) => m < span).map((m) => ({ minutes: m, r: ringRadius(m) }));
  const D = (R1 + LABEL_ROOM) * 2;
  let best = { cols: 1, rows: 1, scale: 0 };
  for (let cols = 1; cols <= Math.max(1, blocks.length); cols++) {
    const rows = Math.ceil(blocks.length / cols);
    const scale = Math.min(viewport.w / (cols * D + (cols - 1) * BLOCK_GAP), viewport.h / (rows * D + (rows - 1) * BLOCK_GAP));
    if (scale > best.scale) best = { cols, rows, scale };
  }
  const placed = blocks.map((block, i) => ({
    ...block,
    cx: (i % best.cols) * (D + BLOCK_GAP) + D / 2,
    cy: Math.floor(i / best.cols) * (D + BLOCK_GAP) + D / 2,
  }));
  const cols = Math.min(best.cols, blocks.length) || 1;
  const rows = Math.ceil(blocks.length / best.cols) || 1;
  return { blocks: placed, ticks, bounds: { x: 0, y: 0, w: cols * D + (cols - 1) * BLOCK_GAP, h: rows * D + (rows - 1) * BLOCK_GAP } };
}

function orbit(parent, px, py, angle, depth, nodes, shown, children) {
  const kids = (children.get(parent.key) ?? []).filter((kid) => shown.has(kid.key)).slice(0, CHILD_CAP);
  const fan = Math.min(Math.PI * 1.3, 0.6 + kids.length * 0.2);
  kids.forEach((kid, i) => {
    const a = angle + (kids.length === 1 ? 0 : -fan / 2 + (fan * i) / (kids.length - 1));
    const r = CHILD_R + (ACTIVE.has(kid.state) ? 8 : 0) + (i % 2) * 6;
    const x = px + Math.cos(a) * r;
    const y = py + Math.sin(a) * r;
    nodes.push({ agent: kid, x, y, px, py, angle: a, depth });
    if (depth < 3) orbit(kid, x, y, a, depth + 1, nodes, shown, children);
  });
}

const subtreeActive = (agent, children) => ACTIVE.has(agent.state) || (children.get(agent.key) ?? []).some((kid) => subtreeActive(kid, children));
const subtreeState = (agent, children, state) => agent.state === state || (children.get(agent.key) ?? []).some((kid) => subtreeState(kid, children, state));

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

// ---- painting (screen space) ---------------------------------------------------------------------

function paint(scene, view, data, hoverKey, viewport) {
  const { matched, selectedKey, now } = data;
  const k = view.scale;
  const back = [];
  const lines = [];
  const dots = [];
  const front = [];
  const candidates = [];
  const taken = [];

  for (const block of scene.blocks) {
    const cx = view.x + block.cx * k;
    const cy = view.y + block.cy * k;
    const S = (x, y) => [cx + x * k, cy + y * k];
    const titleY = cy - (R1 + 34) * k;
    const discR = Math.max(R0 * k - 6, 16);
    taken.push({ x: cx - discR, y: cy - discR, w: discR * 2, h: discR * 2 }, { x: cx - 120, y: titleY - 14, w: 240, h: 34 });

    // Sectors and time rings.
    block.sectors.forEach((sector, i) => {
      back.push(`<path class="sb-sector ${i % 2 ? "alt" : ""} ${sector.active ? "hot" : ""}" d="${wedge(cx, cy, R0 * k, (R1 + 8) * k, sector.a0, sector.a1)}"/>`);
      const mid = (sector.a0 + sector.a1) / 2;
      const lx = cx + Math.cos(mid) * (R1 + 18) * k;
      const ly = cy + Math.sin(mid) * (R1 + 18) * k;
      const anchor = Math.abs(Math.cos(mid)) < 0.25 ? "middle" : Math.cos(mid) > 0 ? "start" : "end";
      const text = `${clip(sector.name, 22)}`;
      const width = text.length * 6.4 + 26;
      const box = { x: anchor === "start" ? lx : anchor === "end" ? lx - width : lx - width / 2, y: ly - 9, w: width, h: 18 };
      if (!collides(box, taken)) {
        taken.push(box);
        front.push(`<text class="sb-sector-label ${sector.needs ? "needs" : sector.active ? "hot" : ""}" x="${lx}" y="${ly + 4}" text-anchor="${anchor}">${esc(text)}<tspan class="n"> ${sector.count}</tspan></text>`);
      }
    });
    for (const tick of scene.ticks) {
      back.push(`<circle class="sb-ring" cx="${cx}" cy="${cy}" r="${tick.r * k}"/>`);
      front.push(`<text class="sb-ring-label" x="${cx + 4}" y="${cy - tick.r * k - 3}">${tick.minutes >= 1440 ? `${tick.minutes / 1440}d` : `${tick.minutes / 60}h`}</text>`);
    }
    back.push(`<circle class="sb-now" cx="${cx}" cy="${cy}" r="${R_NOW * k}"/>`);

    for (const node of block.nodes) {
      const { agent } = node;
      const [x, y] = S(node.x, node.y);
      const state = agent.state;
      const isMatch = matched.has(agent.key);
      const working = ACTIVE.has(state);
      if (node.depth > 0) {
        const [px, py] = S(node.px, node.py);
        lines.push(`<line class="sb-tie ${working ? "hot" : ""} ${isMatch ? "" : "dim"}" x1="${px}" y1="${py}" x2="${x}" y2="${y}"/>`);
      } else if (working) {
        // A gently curved spoke from the machine to each agent that is working right now.
        const bend = 0.35;
        const qx = cx + (x - cx) / 2 - (y - cy) * bend * 0.3;
        const qy = cy + (y - cy) / 2 + (x - cx) * bend * 0.3;
        lines.push(`<path class="sb-spoke ${state === "blocked" ? "needs" : ""}" d="M ${cx} ${cy} Q ${qx} ${qy} ${x} ${y}"/>`);
      }
      dots.push({ order: working ? 2 : state === "failed" ? 1 : 0, svg: dot(agent, x, y, node.depth, isMatch, agent.key === selectedKey || agent.key === hoverKey) });
      const focus = agent.key === hoverKey || agent.key === selectedKey;
      const recentFailure = state === "failed" && now - Date.parse(agent.updatedAt) < 6 * 3600e3;
      const priority = focus ? 0 : state === "blocked" ? 1 : working && node.depth === 0 ? 2 : recentFailure && node.depth === 0 ? 3 : working ? 4 : null;
      if (priority !== null && (isMatch || focus)) candidates.push({ agent, x, y, angle: node.angle, priority, depth: node.depth });
    }

    const active = block.nodes.filter((n) => ACTIVE.has(n.agent.state)).length;
    const tone = block.server.status === "connected" ? "on" : block.server.status === "connecting" ? "pending" : "off";
    front.push(`<g class="sb-hub ${tone}">
      <circle cx="${cx}" cy="${cy}" r="${discR}" class="disc"/>
      <text x="${cx}" y="${cy + 5}" class="count">${block.server.status !== "connected" ? "!" : active}</text>
      <text x="${cx}" y="${titleY}" class="name">${esc(block.server.label)}</text>
      <text x="${cx}" y="${titleY + 15}" class="sub">${esc(block.server.status !== "connected" ? `${block.server.status}${block.server.statusDetail ? ` · ${clip(block.server.statusDetail, 40)}` : ""}` : `${active} working · ${block.sectors.reduce((n, s) => n + s.count, 0)} agents`)}</text>
    </g>`);
  }

  const labels = [];
  for (const c of candidates.sort((a, b) => a.priority - b.priority)) {
    const label = placeLabel(c, taken, viewport);
    if (label) labels.push(label);
  }
  return `<g>${back.join("")}</g><g>${lines.join("")}</g><g>${dots.sort((a, b) => a.order - b.order).map((d) => d.svg).join("")}</g><g>${front.join("")}</g><g>${labels.join("")}</g>`;
}

function wedge(cx, cy, r0, r1, a0, a1) {
  const p = (r, a) => `${cx + Math.cos(a) * r} ${cy + Math.sin(a) * r}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${p(r0, a0)} L ${p(r1, a0)} A ${r1} ${r1} 0 ${large} 1 ${p(r1, a1)} L ${p(r0, a1)} A ${r0} ${r0} 0 ${large} 0 ${p(r0, a0)} Z`;
}

function dot(agent, x, y, depth, isMatch, focused) {
  const state = agent.state;
  const cls = `sb-dot s-${state} ${isMatch ? "" : "dim"} ${focused ? "focus" : ""} ${agent.stale ? "stale" : ""}`;
  if (ACTIVE.has(state)) {
    const r = depth ? 6 : 10;
    return `<g class="${cls}" data-key="${esc(agent.key)}">
      <circle cx="${x}" cy="${y}" r="${r + 8}" class="halo"/>
      <circle cx="${x}" cy="${y}" r="${r}" class="core"/>
      ${depth ? "" : `<g transform="translate(${x - 6.5} ${y - 6.5}) scale(${13 / 24})" class="sb-glyph">${glyphInner(agent.provider)}</g>`}
      <circle cx="${x}" cy="${y}" r="${r + 10}" class="hit"/>
    </g>`;
  }
  const size = depth ? 1.6 + Math.min(2, Math.sqrt(agent.work || 0) / 5) : 2.2 + Math.min(3.8, Math.sqrt(agent.work || 0) / 3.2);
  const r = state === "failed" ? Math.max(size, 4.2) : size;
  return `<g class="${cls}" data-key="${esc(agent.key)}"><circle cx="${x}" cy="${y}" r="${r}" class="core"/><circle cx="${x}" cy="${y}" r="${Math.max(r + 4, 7)}" class="hit"/></g>`;
}

function collides(r, taken) {
  return taken.some((t) => r.x < t.x + t.w + 4 && r.x + r.w + 4 > t.x && r.y < t.y + t.h + 4 && r.y + r.h + 4 > t.y);
}

function placeLabel({ agent, x, y, angle, depth }, taken, viewport) {
  const state = agent.state;
  const title = clip(agent.title, 34);
  const line =
    state === "blocked"
      ? `needs you · ${(agent.pending?.kind ?? "input").replaceAll(/[_-]/g, " ")}`
      : state === "failed"
        ? (agent.lastError ?? "failed")
        : agent.activity && ACTIVE.has(state)
          ? `${agent.activity.label}${agent.activity.detail ? ` · ${agent.activity.detail}` : ""}`
          : [agent.projectTitle, ago(agent.updatedAt)].filter(Boolean).join(" · ");
  const second = clip(line, 40);
  const w = Math.max(title.length * 6.3, second.length * 5.7) + 18;
  const h = 34;
  const right = Math.cos(angle) >= 0;
  const gap = ACTIVE.has(state) ? (depth ? 12 : 16) : 9;
  const options = right ? [[gap, -h / 2], [gap, -h - 4], [gap, 4], [-gap - w, -h / 2]] : [[-gap - w, -h / 2], [-gap - w, -h - 4], [-gap - w, 4], [gap, -h / 2]];
  for (const [dx, dy] of options) {
    const r = { x: x + dx, y: y + dy, w, h };
    if (r.x < 4 || r.y < 4 || r.x + w > viewport.w - 4 || r.y + h > viewport.h - 4) continue;
    if (collides(r, taken)) continue;
    taken.push(r);
    const tone = state === "blocked" ? "needs" : state === "failed" ? "bad" : agent.activity?.live ? "live" : "";
    return `<g class="sb-label" data-key="${esc(agent.key)}">
      <rect x="${r.x}" y="${r.y}" width="${w}" height="${h}" rx="7"/>
      <text x="${r.x + 9}" y="${r.y + 14}" class="t">${esc(title)}</text>
      <text x="${r.x + 9}" y="${r.y + 27}" class="d ${tone}">${esc(second)}</text>
    </g>`;
  }
  return null;
}

function ago(iso) {
  const m = Math.floor((Date.now() - Date.parse(iso)) / 60e3);
  if (m < 1) return "now";
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
