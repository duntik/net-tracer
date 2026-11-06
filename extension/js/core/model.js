// Schematic Net Tracer — document model: merges per-page nets into named nodes across pages and collects parts.
// Pure module: no DOM, no global state. Imported by the UI, the analysis worker and the Node tests.
import { POWER_RE, REFDES_RE, isPower, goodName, powerFamily, conflictingPowerLabels } from './names.js';
export { POWER_RE, REFDES_RE, isPower, goodName, powerFamily, conflictingPowerLabels };
const tcx=t=>(t.x0+t.x1)/2, tcy=t=>(t.y0+t.y1)/2;

// pages: [null, {raw, model}, ...] (1-based). outlineNets: [[name, [REF-PIN...]], ...] or null.
// Mutates each net (net.node, net.color) and returns {nodes, nodeByKey}.
export function buildNodes(pages, outlineNets){
  const byName=new Map(); const nodes=[];
  const mk=()=>({key:'',name:'',names:new Set(),type:'signal',nets:[],labels:[],pages:new Set(),segs:0,pins:0,dangling:0});
  for(let p=1;p<pages.length;p++){ const pg=pages[p]; if(!pg||!pg.model) continue;
    for(const net of pg.model.nets){
      // only the net's most reliable label merges it with same-name nets elsewhere; the other labels are kept as aliases
      const names=[...new Set(net.labels.filter(l=>l.isNetLabel).map(l=>l.text.str))].filter(goodName);
      const key=net.mergeName&&goodName(net.mergeName)?net.mergeName:null;
      let node=key?byName.get(key):null;
      if(!node){ node=mk(); nodes.push(node); if(key){ node.name=key; node.key='N:'+key; byName.set(key,node); } else { node.key=`P:${p}:${net.index}`; if(names.length) node.name=names[0]; } }
      for(const nm of names) node.names.add(nm);
      node.nets.push({page:p,net}); net.node=node; node.pages.add(p); node.segs+=net.segs.length; node.pins+=net.labels.length; node.dangling+=net.dangling.length;
      for(const l of net.labels) node.labels.push({page:p,text:l.text,comp:l.comp,isNetLabel:l.isNetLabel,d:l.d});
    }
  }
  // Altium "Smart PDF" bookmarks carry the netlist: NETNAME -> [REF-PIN]; use it to name and merge nodes (best effort)
  if(outlineNets){ for(const [netName,pinList] of outlineNets){ const pins=new Set(pinList); const hit=new Set();
      for(const node of nodes) for(const l of node.labels){ if(!l.comp) continue; const ref=l.comp.split(/\s+/)[0]; if(pins.has(ref+'-'+l.text.str)||pins.has(ref+'.'+l.text.str)) hit.add(node); }
      if(!hit.size) continue; const [first,...rest]=[...hit];
      for(const o of rest){ first.nets.push(...o.nets); first.labels.push(...o.labels); o.pages.forEach(x=>first.pages.add(x)); first.segs+=o.segs; first.pins+=o.pins; first.dangling+=o.dangling; o.names.forEach(x=>first.names.add(x)); o.nets.forEach(x=>x.net.node=first); o.dead=true; }
      if(!first.name){ first.name=netName; first.key='N:'+netName; } first.names.add(netName); } }
  const out=nodes.filter(n=>!n.dead);
  // a node merged across pages by name keeps the voltage family of that name; stray labels of other rails go
  for(const node of out){ const bad=new Set(conflictingPowerLabels(node.labels,node.key.startsWith('N:')?node.name:null)); if(!bad.size) continue;
    node.labels=node.labels.filter(l=>!bad.has(l)); const left=new Set(node.labels.filter(l=>l.isNetLabel).map(l=>l.text.str));
    for(const l of bad) if(!left.has(l.text.str)) node.names.delete(l.text.str); }
  for(const node of out){ node.type=[...node.names].some(isPower)?'power':'signal'; node.labelCount=node.labels.filter(l=>l.isNetLabel&&node.names.has(l.text.str)).length;
    node.labels.sort((a,b)=>(a.page-b.page)||(a.text.y0-b.text.y0)||(a.text.x0-b.text.x0)); }
  out.sort((a,b)=>(b.segs-a.segs)||(b.labels.length-a.labels.length));
  out.forEach((n,i)=>{ n.index=i; n.color=n.type==='power'?`hsl(${(i*137.508)%360} 80% 60%)`:`hsl(${(i*137.508)%360} 85% 55%)`; n.nets.forEach(x=>x.net.color=n.color); });
  return {nodes:out, nodeByKey:new Map(out.map(n=>[n.key,n]))};
}

// Returns the parts list: [{ref, value, page, bbox, units:Set}] sorted by reference.
export function buildParts(pages){
  const parts=new Map(); const unitRe=/^([A-Z]{1,3}\d{1,4})([A-Z])$/;
  const add=(ref,value,page,bbox)=>{ const m=unitRe.exec(ref); const base=m?m[1]:ref; const unit=m?m[2]:'';
    let p=parts.get(base+'@'+page); if(!p){ p={ref:base,value:'',page,bbox:{...bbox},units:new Set()}; parts.set(base+'@'+page,p); }
    if(unit) p.units.add(unit); if(value&&!p.value) p.value=value;
    p.bbox={x0:Math.min(p.bbox.x0,bbox.x0),y0:Math.min(p.bbox.y0,bbox.y0),x1:Math.max(p.bbox.x1,bbox.x1),y1:Math.max(p.bbox.y1,bbox.y1)}; };
  for(let p=1;p<pages.length;p++){ const pg=pages[p]; if(!pg||!pg.model) continue; const {raw,model}=pg;
    const used=new Set(); for(const net of model.nets) for(const l of net.labels) used.add(l.text);
    const valueOf=(anchor,orient)=>{ let best=null,bd=24;
      for(const t of raw.texts){ if(t===anchor||used.has(t)||REFDES_RE.test(t.str)) continue; const horiz=(t.x1-t.x0)>=(t.y1-t.y0); if(horiz!==orient) continue;
        const d=Math.hypot(Math.max(anchor.x0-t.x1,0,t.x0-anchor.x1),Math.max(anchor.y0-t.y1,0,t.y0-anchor.y1)); const score=d-(/\d/.test(t.str)?6:0); if(score<bd){ bd=score; best=t; } }
      return best?best.str:''; };
    // 1. rectangle components: "U1  ESP32_DevKit" -> ref + value from the name line
    for(const c of model.comps){ if(!c.name) continue; const toks=c.name.split(/\s+/); const ref=toks.find(x=>REFDES_RE.test(x)); if(!ref) continue;
      const nameText=raw.texts.find(t=>t.str===c.name); const value=toks.filter(x=>x!==ref).join(' ')||(nameText?valueOf(nameText,true):'');
      if(nameText) used.add(nameText); add(ref,value,p,{x0:c.x0,y0:c.y0,x1:c.x1,y1:c.y1}); }
    // 2. body-less symbols with a reference designator next to them
    for(const s of model.symbols){ const t=raw.texts.find(t=>t.str===s.refdes && !used.has(t) && t.x1>=s.b.x0-14&&t.x0<=s.b.x1+14&&t.y1>=s.b.y0-14&&t.y0<=s.b.y1+14); if(t) used.add(t);
      add(s.refdes, t?valueOf(t,(t.x1-t.x0)>=(t.y1-t.y0)):'', p, t?{x0:Math.min(s.b.x0,t.x0),y0:Math.min(s.b.y0,t.y0),x1:Math.max(s.b.x1,t.x1),y1:Math.max(s.b.y1,t.y1)}:s.b); }
    // 3. any remaining refdes-looking text that is not a pin label or net label
    const inBody=t=>model.comps.some(c=>t.x0>=c.x0-0.5&&t.x1<=c.x1+0.5&&t.y0>=c.y0-0.5&&t.y1<=c.y1+0.5);
    // a reference-like text right next to a pin line is a pin / ball number (A12, B3), not a part
    const pinEnds=[]; for(const net of model.nets) for(const s of net.pins) pinEnds.push([s.x1,s.y1],[s.x2,s.y2]);
    const nearPin=t=>pinEnds.some(([x,y])=>Math.hypot(Math.max(t.x0-x,0,x-t.x1),Math.max(t.y0-y,0,y-t.y1))<6);
    for(const t of raw.texts){ if(used.has(t)||!REFDES_RE.test(t.str)||inBody(t)||nearPin(t)) continue; const m=unitRe.exec(t.str); const base=m?m[1]:t.str; if(parts.has(base+'@'+p)) continue;
      used.add(t); add(t.str, valueOf(t,(t.x1-t.x0)>=(t.y1-t.y0)), p, t); }
  }
  return [...parts.values()].sort((a,b)=>{ const pa=a.ref.match(/^([A-Z]+)(\d+)/), pb=b.ref.match(/^([A-Z]+)(\d+)/); return (pa[1]<pb[1]?-1:pa[1]>pb[1]?1:0)||(+pa[2]-+pb[2])||(a.page-b.page); });
}

