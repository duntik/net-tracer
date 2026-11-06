// Schematic Net Tracer — export: CSV and text netlist serialisation.
// Pure module: no DOM, no global state. Imported by the UI, the analysis worker and the Node tests.
export const csvCell=v=>{ v=String(v??''); if(/^[=+\-@]/.test(v)) v='="'+v.replace(/"/g,'""')+'"'; else if(/[",\n;]/.test(v)) v='"'+v.replace(/"/g,'""')+'"'; return v; };
const pinRef=l=>(l.comp?l.comp.split(/\s+/)[0]+'.':'')+l.text.str;
export function nodesCsv(nodes, nameOf){ const rows=[['name','type','labels','pages','wires','pins'].join(',')];
  for(const n of nodes) rows.push([nameOf(n),n.type,n.labelCount,[...n.pages].sort((a,b)=>a-b).join(' '),n.segs,n.labels.map(pinRef).join(' ')].map(csvCell).join(','));
  return rows.join('\r\n'); }
export function partsCsv(parts){ const rows=[['reference','value','units','page'].join(',')]; for(const p of parts) rows.push([p.ref,p.value,[...p.units].sort().join(''),p.page].map(csvCell).join(',')); return rows.join('\r\n'); }
export function netlistText(nodes, nameOf){ return nodes.map(n=>`${nameOf(n)}\t${n.type}\t${n.segs} seg\t${n.labels.map(pinRef).join(', ')}${n.dangling?'\tDANGLING:'+n.dangling:''}`).join('\n'); }
