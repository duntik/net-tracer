// Schematic Net Tracer — what names look like: power rails, reference designators, voltage families.
// Pure module, shared by the connectivity, the document model and the benchmark.
export const POWER_RE=/^([+-]?\d+([.,]\d+)?V\d*([_\-/.]\w*)?|V(CC|DD|SS|EE|BAT|IN|OUT|BUS|REF|SYS|PP|AA|IO|USB|CORE|DDR|LED|MOT|ANA|DIG)\w*|[ADPSC]?GND\w*|EARTH|PE|PP\d\w*|[1-9]V\d|VBB\w*|V[+-]|[+-]\d+V\w*|\w+_\d+V\d*|\w+_\d+P\d+V?)$/i; // ...SYS_5V, VDD_3P3V
export const REFDES_RE=/^[A-Z]{1,3}\d{1,4}[A-Z]?$/;
export const isPower=n=>POWER_RE.test(n.replace(/\s+/g,''));
export const goodName=s=>/[A-Za-zА-Яа-я]/.test(s)&&s.length>=2;
// Voltage family of a power name: 'GND', 'V3.3', 'V5.0'... Generic names (VCC, VDD, VIN) have none (null):
// they are aliases of whatever rail they sit on. One wire cannot carry two different families.
export const powerFamily=n=>{ const s=n.toUpperCase().replace(/\s+/g,''); if(/GND|VSS|EARTH|^PE$/.test(s)) return 'GND';
  let v=s.match(/(\d+)[V.,P](\d+)/); if(v) return `V${+v[1]}.${+v[2]}`; v=s.match(/(\d+)V/); return v?`V${+v[1]}.0`:null; };
// Net labels of a wire (or of a node) that name a different voltage family than the rest: the wire is the family of
// `prefer` (the name it is merged by) when that has one, otherwise of its most reliable label (smallest d, then most labels).
export function conflictingPowerLabels(labels, prefer){
  const fam=new Map(), famOf=l=>l.isNetLabel&&isPower(l.text.str)?powerFamily(l.text.str):null;
  for(const l of labels){ const f=famOf(l); if(!f) continue; const e=fam.get(f)||{d:Infinity,n:0}; e.d=Math.min(e.d,l.d??Infinity); e.n++; fam.set(f,e); }
  if(fam.size<2) return [];
  const pf=prefer&&isPower(prefer)?powerFamily(prefer):null;
  const keep=pf&&fam.has(pf)?pf:[...fam].sort((a,b)=>(a[1].d-b[1].d)||(b[1].n-a[1].n))[0][0];
  return labels.filter(l=>{ const f=famOf(l); return f&&f!==keep; });
}
