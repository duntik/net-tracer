// Schematic Net Tracer — pipeline: the defaults and the whole analysis in one call.
// Pure module: no DOM, no global state. The UI, the tests and the benchmark all go through these functions,
// so they compute exactly the same thing.
import { dist, wkey, segPointDist } from './geom.js';
import { buildNets } from './nets.js';
import { buildNodes, buildParts } from './model.js';

export const DEFAULT_OPTIONS = Object.freeze({ tol: 1, labelDist: 8, needDot: 'auto', mergeLabels: true, insideRect: true });

// Default "what counts as a wire". Every line belongs to a class (colour + width). Junction dots sit on wires,
// so the class that carries the most dots is the wire class (true for Eagle, KiCad, Altium, OrCAD, EasyEDA exports
// in colour and in black and white). Without dots: the class with the most length in long, axis-aligned lines,
// ignoring frame-like lines. Returns the colour and width sets the connectivity step filters on.
export function wireClassStats(raws) {
  const cls = new Map();
  for (const raw of raws) { if (!raw) continue;
    const grid = new Map(), C = 8, key = (x, y) => Math.floor(x / C) + ',' + Math.floor(y / C);
    for (const d of raw.dots) { const k = key(d.x, d.y); (grid.get(k) || grid.set(k, []).get(k)).push(d); }
    for (const s of raw.segments) { if (s.closed || s.curve) continue;
      const k = s.color + '|' + wkey(s.lw); let c = cls.get(k); if (!c) cls.set(k, c = { color: s.color, width: wkey(s.lw), n: 0, len: 0, axisLongLen: 0, dotHits: 0 });
      const L = dist(s.x1, s.y1, s.x2, s.y2), axis = Math.abs(s.x1 - s.x2) < 0.1 || Math.abs(s.y1 - s.y2) < 0.1;
      c.n++; c.len += L; if (axis && L > 5 && L < 250) c.axisLongLen += L;
      let hit = false;
      for (const [x, y] of [[s.x1, s.y1], [s.x2, s.y2], [(s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2]]) {
        if (hit) break;
        for (let gx = -1; gx <= 1 && !hit; gx++) for (let gy = -1; gy <= 1 && !hit; gy++)
          for (const d of grid.get((Math.floor(x / C) + gx) + ',' + (Math.floor(y / C) + gy)) || []) { if (segPointDist(s, d.x, d.y).d <= d.r + 1) { hit = true; break; } }
      }
      if (hit) c.dotHits++; } }
  return [...cls.values()];
}
function pickWireClass(stats) {
  if (!stats.length) return null;
  const byDots = [...stats].sort((a, b) => b.dotHits - a.dotHits)[0];
  const byLen = [...stats].sort((a, b) => b.axisLongLen - a.axisLongLen)[0];
  return byDots.dotHits >= 5 && byDots.axisLongLen > 0 ? byDots : byLen;
}
// The pick is made per page (a document can mix sheets from different tools or styles) and the picks are combined.
export function defaultFilters(raws) {
  const colors = new Set(), widths = new Set(), picks = [];
  for (const raw of raws) { if (!raw) continue; const p = pickWireClass(wireClassStats([raw])); if (p && !picks.some(q => q.color === p.color && q.width === p.width)) picks.push(p); }
  for (const p of picks) { colors.add(p.color); widths.add(p.width); }
  if (!picks.length) for (const raw of raws) if (raw) for (const s of raw.segments) colors.add(s.color);
  return { colors, widths, picks };
}

// raws: [raw page 1, raw page 2, ...] as returned by extractPage. Returns the same shape the UI keeps in S.
export function analyze(raws, outlineNets = null, options = {}) {
  const f = (options.colors && options.widths) ? { colors: options.colors, widths: options.widths } : defaultFilters(raws);
  const opt = { ...DEFAULT_OPTIONS, ...options, ...f };
  const pages = [null, ...raws.map(raw => ({ raw, model: buildNets(raw, opt) }))];
  const { nodes, nodeByKey } = buildNodes(pages, outlineNets);
  const parts = buildParts(pages);
  return { pages, nodes, nodeByKey, parts, options: opt };
}
