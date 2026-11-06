// Ground truth from Eagle .sch (XML): net name -> set of "PART.PIN" (pin names with @n suffixes stripped,
// because the drawing shows "GND" for GND@1 and GND@2), plus the parts list with values.
const attr = (tag, name) => { const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`)); return m ? m[1] : null; };
const unescape = s => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export function parseEagleSch(xml) {
  const nets = new Map(), parts = new Map(), partInfo = new Map(), padsOf = new Map(); // "lib|deviceset|device" -> Map(gate.pin -> [pads])
  for (const lib of xml.matchAll(/<library\s[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/library>/g)) {
    for (const ds of lib[2].matchAll(/<deviceset\s[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/deviceset>/g))
      for (const dv of ds[2].matchAll(/<device\s[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/device>/g)) {
        const m = new Map();
        for (const c of dv[2].matchAll(/<connect\s[^>]*\/?>/g)) { const g = attr(c[0], 'gate'), pin = attr(c[0], 'pin'), pad = attr(c[0], 'pad');
          if (pin && pad) m.set(`${g}|${unescape(pin)}`, unescape(pad).split(/\s+/)); }
        padsOf.set(`${unescape(lib[1])}|${unescape(ds[1])}|${unescape(dv[1])}`, m);
      } }
  for (const m of xml.matchAll(/<part\s[^>]*>/g)) { const name = attr(m[0], 'name'); if (!name) continue;
    parts.set(unescape(name), unescape(attr(m[0], 'value') || ''));
    partInfo.set(unescape(name), `${unescape(attr(m[0], 'library') || '')}|${unescape(attr(m[0], 'deviceset') || '')}|${unescape(attr(m[0], 'device') || '')}`); }
  for (const m of xml.matchAll(/<net\s[^>]*>([\s\S]*?)<\/net>/g)) {
    const head = m[0].slice(0, m[0].indexOf('>') + 1); const name = unescape(attr(head, 'name') || '');
    const pins = nets.get(name) || new Map(); // visible key -> physical id
    for (const p of m[1].matchAll(/<pinref\s[^>]*\/?>/g)) {
      const part = unescape(attr(p[0], 'part') || ''), gate = unescape(attr(p[0], 'gate') || ''), pin = unescape(attr(p[0], 'pin') || '');
      if (!part || !pin) continue;
      const id = `${part}.${gate}.${pin}`;
      pins.set(`${part}.${pin.replace(/@\d+$/, '')}`, id);          // the pin name as drawn (GND@2 -> GND)
      for (const pad of padsOf.get(partInfo.get(part))?.get(`${gate}|${pin}`) || []) pins.set(`${part}.${pad}`, id); // the pad number
    }
    nets.set(name, pins);
  }
  return { nets, parts };
}

// Truth as a lookup: visible pin key ("U1.GND", "U1.5") -> {net, id}, where id identifies the physical pin
// (so a pin labelled with both its number and its name on the drawing counts once).
export function eagleTruth(sch) {
  const t = new Map();
  for (const [net, pins] of sch.nets) for (const [key, id] of pins) if (!t.has(key)) t.set(key, { net, id });
  return t;
}

// Pair-counting precision / recall over the physical pins both sides know about.
// pred: Map nodeKey -> [visible pin key...]. Keys that map to two different nets are ambiguous and skipped.
export function pairScores(pred, truth) {
  const ambiguous = new Set(), netOfKey = new Map();
  for (const [k, v] of truth) netOfKey.set(k, v.net);
  const cell = new Map(), rowSum = new Map(), colSum = new Map(); const seen = new Set();
  for (const [node, pins] of pred) for (const key of new Set(pins)) {
    const t = truth.get(key); if (!t || ambiguous.has(key) || seen.has(t.id)) continue; seen.add(t.id);
    const k = node + '\u0000' + t.net;
    cell.set(k, (cell.get(k) || 0) + 1); rowSum.set(node, (rowSum.get(node) || 0) + 1); colSum.set(t.net, (colSum.get(t.net) || 0) + 1);
  }
  const c2 = n => n * (n - 1) / 2, sum = m => [...m.values()].reduce((a, n) => a + c2(n), 0);
  const tp = sum(cell), predPairs = sum(rowSum), truePairs = sum(colSum);
  const precision = predPairs ? tp / predPairs : 1, recall = truePairs ? tp / truePairs : 1;
  const ids = new Set([...truth.values()].map(v => v.id));
  return { precision, recall, f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0, matchedPins: seen.size, truthPins: ids.size, coverage: ids.size ? seen.size / ids.size : 0 };
}
