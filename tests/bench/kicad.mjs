// Ground truth from a KiCad netlist (.net, S-expression, versions D and E).
// Pin names come from (pinfunction ...) when present, otherwise from the (libparts ...) section.
function parseSexpr(src) {
  let i = 0; const n = src.length;
  const skip = () => { while (i < n && /\s/.test(src[i])) i++; };
  function read() {
    skip();
    if (src[i] === '(') { i++; const list = []; for (;;) { skip(); if (src[i] === ')') { i++; return list; } if (i >= n) return list; list.push(read()); } }
    if (src[i] === '"') { i++; let s = ''; while (i < n && src[i] !== '"') { if (src[i] === '\\') i++; s += src[i++]; } i++; return s; }
    let s = ''; while (i < n && !/[\s()]/.test(src[i])) s += src[i++]; return s;
  }
  return read();
}
const kids = (node, tag) => (Array.isArray(node) ? node.filter(x => Array.isArray(x) && x[0] === tag) : []);
const val = (node, tag) => { const k = kids(node, tag)[0]; return k ? k[1] : null; };

export function kicadTruth(src) {
  const root = parseSexpr(src);
  const libpins = new Map();       // "lib:part" -> Map(num -> name)
  for (const lps of kids(root, 'libparts')) for (const lp of kids(lps, 'libpart')) {
    const key = `${val(lp, 'lib')}:${val(lp, 'part')}`, m = new Map();
    for (const ps of kids(lp, 'pins')) for (const p of kids(ps, 'pin')) m.set(String(val(p, 'num')), String(val(p, 'name')));
    libpins.set(key, m);
  }
  const libOf = new Map();         // ref -> "lib:part"
  for (const cs of kids(root, 'components')) for (const c of kids(cs, 'comp')) { const ls = kids(c, 'libsource')[0]; if (ls) libOf.set(String(val(c, 'ref')), `${val(ls, 'lib')}:${val(ls, 'part')}`); }
  const truth = new Map(); let refs = new Set();
  for (const ns of kids(root, 'nets')) for (const net of kids(ns, 'net')) {
    const name = String(val(net, 'name'));
    for (const node of kids(net, 'node')) {
      const ref = String(val(node, 'ref')), num = String(val(node, 'pin')); refs.add(ref);
      let fn = val(node, 'pinfunction'); if (fn == null) fn = libpins.get(libOf.get(ref))?.get(num) ?? null;
      const id = `${ref}.${num}`; truth.set(id, { net: name, id });
      if (fn && fn !== '~' && fn !== num) { const k = `${ref}.${String(fn).replace(/^~\{?|\}$/g, '')}`; if (!truth.has(k)) truth.set(k, { net: name, id }); }
    }
  }
  return { truth, refs };
}
