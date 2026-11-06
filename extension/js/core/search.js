// Schematic Net Tracer — search: text search across pages, ranked.
// Pure module: no DOM, no global state. Imported by the UI, the analysis worker and the Node tests.
import { REFDES_RE } from './model.js';

const PRIO={net:0,part:1,pin:2,text:3};
// Finds q (case-insensitive substring) in every text of every page. Exact matches first, then nets, parts, pins, other text.
export function search(q, pages, nodes, parts){ q=(q||'').trim().toLowerCase(); const results=[]; if(!q) return results;
  const labelOf=new Map(); for(const n of nodes) for(const l of n.labels) labelOf.set(l.text,{node:n,l});
  for(let p=1;p<pages.length;p++){ const pg=pages[p]; if(!pg||!pg.raw) continue;
    for(const t of pg.raw.texts){ const s=t.str.toLowerCase(); if(!s.includes(q)) continue; const lab=labelOf.get(t);
      const part=parts.find(x=>x.page===p&&(x.ref.toLowerCase()===s||(x.bbox.x0<=t.x0&&x.bbox.x1>=t.x1&&x.bbox.y0<=t.y0&&x.bbox.y1>=t.y1&&REFDES_RE.test(t.str))));
      const kind=lab?(lab.l.isNetLabel?'net':'pin'):part?'part':'text';
      results.push({kind,page:p,bbox:t,label:t.str,exact:s===q,node:lab?lab.node:null,part:part||null,comp:lab?lab.l.comp:''}); } }
  results.sort((a,b)=>(b.exact-a.exact)||(PRIO[a.kind]-PRIO[b.kind])||(a.page-b.page)||(a.bbox.y0-b.bbox.y0));
  return results; }
