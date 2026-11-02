import * as pdfjsLib from '../lib/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = '../lib/pdf.worker.min.mjs';
const OPS = pdfjsLib.OPS;

// ============================================================ state
const S = {
  doc:null, page:null, pageIndex:1, zoom:1.0,
  pages:[],            // per page: {raw, model, base} (index = page number)
  nodes:[], nodeByKey:new Map(), parts:[],
  raw:null, model:null, // current page shortcuts
  selKey:null, hover:null, labelIdx:0,
  colorsOn:new Set(), widthsOn:new Set(),
  results:[], resIdx:-1, query:'', tab:'nets', blink:null, outlineNets:null,
};
window.__S = S;
const $ = id => document.getElementById(id);
const T=(k,p)=>window.i18n.t(k,p);
await window.i18n.load(); window.i18n.apply(); $('lang').value=window.i18n.lang;
$('lang').onchange=async e=>{ await window.i18n.save(e.target.value); window.i18n.apply(); if(S.pages.length) { renderAll(); } };
const pdfCanvas = $('pdf'), ov = $('overlay'), octx = ov.getContext('2d');

// ============================================================ geometry
const mul = (m, n) => [ n[0]*m[0]+n[1]*m[2], n[0]*m[1]+n[1]*m[3], n[2]*m[0]+n[3]*m[2], n[2]*m[1]+n[3]*m[3], n[4]*m[0]+n[5]*m[2]+m[4], n[4]*m[1]+n[5]*m[3]+m[5] ];
const ap = (m, x, y) => [m[0]*x+m[2]*y+m[4], m[1]*x+m[3]*y+m[5]];
const dist = (ax,ay,bx,by) => Math.hypot(ax-bx, ay-by);
function segPointDist(s, px, py){ const dx=s.x2-s.x1, dy=s.y2-s.y1, l2=dx*dx+dy*dy; let t=l2?((px-s.x1)*dx+(py-s.y1)*dy)/l2:0; t=Math.max(0,Math.min(1,t)); return {d:dist(px,py,s.x1+t*dx,s.y1+t*dy), t}; }
const rgb = c => { if(!c) return '#000000'; const h=v=>Math.round(Math.max(0,Math.min(255,v))).toString(16).padStart(2,'0'); return '#'+h(c[0])+h(c[1])+h(c[2]); };
const wkey = lw => (Math.round(lw*20)/20).toFixed(2);
const bboxOf = pts => { let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9; for(const [x,y] of pts){ if(x<x0)x0=x; if(x>x1)x1=x; if(y<y0)y0=y; if(y>y1)y1=y; } return {x0,y0,x1,y1}; };

// simple uniform grid over segments (bbox-based)
class Grid { constructor(cell){ this.cell=cell; this.m=new Map(); }
  cells(x0,y0,x1,y1){ const c=this.cell, r=[]; for(let cx=Math.floor(Math.min(x0,x1)/c);cx<=Math.floor(Math.max(x0,x1)/c);cx++) for(let cy=Math.floor(Math.min(y0,y1)/c);cy<=Math.floor(Math.max(y0,y1)/c);cy++) r.push(cx+','+cy); return r; }
  add(id,x0,y0,x1,y1){ for(const k of this.cells(x0,y0,x1,y1)){ let a=this.m.get(k); if(!a) this.m.set(k,a=[]); a.push(id); } }
  query(x0,y0,x1,y1){ const out=new Set(); for(const k of this.cells(x0,y0,x1,y1)) for(const i of (this.m.get(k)||[])) out.add(i); return out; } }

// ============================================================ 1. extract geometry from the operator list
async function extractPage(page){
  const ol = await page.getOperatorList();
  const base = page.getViewport({scale:1});
  const V = base.transform;
  let ctm=[1,0,0,1,0,0], stroke='#000000', fill='#000000', lw=1;
  const stack=[];
  const segments=[], dots=[], rects=[];
  let pending=null;
  const toDev=(x,y)=>{ const p=ap(ctm,x,y); return ap(V,p[0],p[1]); };
  const devLw=()=> lw*Math.sqrt(Math.abs(ctm[0]*ctm[3]-ctm[1]*ctm[2]));

  function buildPath(ops, args){
    const subs=[]; let cur=null, ai=0;
    const start=(x,y)=>{ cur={pts:[toDev(x,y)], closed:false, isRect:false, hasCurve:false}; subs.push(cur); };
    for(const op of ops){
      switch(op){
        case OPS.moveTo: start(args[ai],args[ai+1]); ai+=2; break;
        case OPS.lineTo: if(!cur) start(args[ai],args[ai+1]); else cur.pts.push(toDev(args[ai],args[ai+1])); ai+=2; break;
        case OPS.curveTo: { if(!cur) start(args[ai],args[ai+1]); cur.hasCurve=true;
          const p0=cur.pts[cur.pts.length-1], c1=toDev(args[ai],args[ai+1]), c2=toDev(args[ai+2],args[ai+3]), p3=toDev(args[ai+4],args[ai+5]);
          for(let k=1;k<=4;k++){ const t=k/4,u=1-t; cur.pts.push([u*u*u*p0[0]+3*u*u*t*c1[0]+3*u*t*t*c2[0]+t*t*t*p3[0], u*u*u*p0[1]+3*u*u*t*c1[1]+3*u*t*t*c2[1]+t*t*t*p3[1]]); }
          ai+=6; break; }
        case OPS.curveTo2: case OPS.curveTo3: { if(!cur) start(args[ai],args[ai+1]); cur.hasCurve=true; cur.pts.push(toDev(args[ai+2],args[ai+3])); ai+=4; break; }
        case OPS.closePath: if(cur){ cur.closed=true; if(dist(...cur.pts[0],...cur.pts[cur.pts.length-1])>0.05) cur.pts.push(cur.pts[0]); cur=null; } break;
        case OPS.rectangle: { const [x,y,w,h]=[args[ai],args[ai+1],args[ai+2],args[ai+3]]; ai+=4;
          subs.push({pts:[toDev(x,y),toDev(x+w,y),toDev(x+w,y+h),toDev(x,y+h),toDev(x,y)], closed:true, isRect:true, hasCurve:false}); cur=null; break; }
      }
    }
    // closed axis-aligned 4-gon polylines are rectangles too (KiCad draws bodies this way)
    for(const sp of subs){ if(sp.isRect||sp.hasCurve) continue; const p=sp.pts;
      const closedish = sp.closed || (p.length===5 && dist(...p[0],...p[4])<0.05);
      if(closedish && p.length===5 && p.slice(0,4).every((q,i)=>{ const r=p[(i+1)%4]; return Math.abs(q[0]-r[0])<0.05||Math.abs(q[1]-r[1])<0.05; })) sp.isRect=true; }
    return subs;
  }
  const pushSeg=(a,b,extra)=>{ if(dist(a[0],a[1],b[0],b[1])<0.05) return; segments.push({x1:a[0],y1:a[1],x2:b[0],y2:b[1],id:segments.length,...extra}); };
  function emitStroke(){ if(!pending) return; const w=devLw();
    for(const sp of pending){
      if(sp.isRect){ const b=bboxOf(sp.pts); rects.push({...b,color:stroke,lw:w}); }
      if(sp.hasCurve && sp.closed){ const b=bboxOf(sp.pts); if(Math.max(b.x1-b.x0,b.y1-b.y0)<=7) continue; } // outline of a junction dot
      for(let i=1;i<sp.pts.length;i++) pushSeg(sp.pts[i-1],sp.pts[i],{color:stroke,lw:w,closed:sp.closed||sp.isRect,curve:sp.hasCurve});
    } }
  function emitFill(){ if(!pending) return;
    for(const sp of pending){ const b=bboxOf(sp.pts), w=b.x1-b.x0, h=b.y1-b.y0, mn=Math.min(w,h), mx=Math.max(w,h);
      if(mx<=7 && mn>0.3 && mn/mx>0.6) dots.push({x:(b.x0+b.x1)/2,y:(b.y0+b.y1)/2,r:mx/2,color:fill});
      else if(sp.isRect && mn<=2.2 && mx>=4*mn){ // thin filled rectangle = a line drawn as a fill
        if(w>=h) pushSeg([b.x0,(b.y0+b.y1)/2],[b.x1,(b.y0+b.y1)/2],{color:fill,lw:mn,closed:false,curve:false}); else pushSeg([(b.x0+b.x1)/2,b.y0],[(b.x0+b.x1)/2,b.y1],{color:fill,lw:mn,closed:false,curve:false}); }
    } }
  for(let i=0;i<ol.fnArray.length;i++){
    const fn=ol.fnArray[i], a=ol.argsArray[i];
    switch(fn){
      case OPS.save: stack.push({ctm,stroke,fill,lw}); break;
      case OPS.restore: if(stack.length) ({ctm,stroke,fill,lw}=stack.pop()); break;
      case OPS.transform: ctm=mul(ctm,a); break;
      case OPS.setLineWidth: lw=a[0]; break;
      case OPS.setStrokeRGBColor: stroke=rgb(a); break;
      case OPS.setFillRGBColor: fill=rgb(a); break;
      case OPS.setStrokeGray: stroke=rgb([a[0]*255,a[0]*255,a[0]*255]); break;
      case OPS.setFillGray: fill=rgb([a[0]*255,a[0]*255,a[0]*255]); break;
      case OPS.setStrokeCMYKColor: stroke=rgb([255*(1-a[0])*(1-a[3]),255*(1-a[1])*(1-a[3]),255*(1-a[2])*(1-a[3])]); break;
      case OPS.setFillCMYKColor: fill=rgb([255*(1-a[0])*(1-a[3]),255*(1-a[1])*(1-a[3]),255*(1-a[2])*(1-a[3])]); break;
      case OPS.constructPath: pending=buildPath(a[0],a[1]); break;
      case OPS.stroke: case OPS.closeStroke: emitStroke(); pending=null; break;
      case OPS.fill: case OPS.eoFill: emitFill(); pending=null; break;
      case OPS.fillStroke: case OPS.eoFillStroke: case OPS.closeFillStroke: case OPS.closeEOFillStroke: emitFill(); emitStroke(); pending=null; break;
      case OPS.endPath: pending=null; break;
    }
  }
  // text (rotation-aware boxes)
  const tc = await page.getTextContent();
  const texts=[];
  for(const it of tc.items){
    if(!it.str || !it.str.trim()) continue;
    const m=it.transform, fs=Math.hypot(m[0],m[1])||1, fy=Math.hypot(m[2],m[3])||1;
    const dir=[m[0]/fs,m[1]/fs], up=[m[2]/fy,m[3]/fy], w=it.width||0, h=it.height||fy;
    const o=[m[4],m[5]], corners=[o,[o[0]+dir[0]*w,o[1]+dir[1]*w],[o[0]+dir[0]*w+up[0]*h,o[1]+dir[1]*w+up[1]*h],[o[0]+up[0]*h,o[1]+up[1]*h]].map(p=>ap(V,p[0],p[1]));
    texts.push({str:it.str.trim(), ...bboxOf(corners)});
  }
  texts.sort((a,b)=>(a.y0-b.y0)||(a.x0-b.x0));
  const merged=[];
  for(const t of texts){ const p=merged[merged.length-1];
    if(p && Math.abs(p.y0-t.y0)<1.5 && Math.abs(p.y1-t.y1)<1.5 && t.x0-p.x1<2.5 && t.x0-p.x1>-1){ p.str+=t.str; p.x1=Math.max(p.x1,t.x1); } else merged.push({...t}); }
  // drop exact duplicate segments (some exporters draw wires twice)
  const seen=new Set(); const uniq=[];
  for(const s of segments){ const k=[s.x1,s.y1,s.x2,s.y2].map(v=>Math.round(v*10)).join(','), k2=[s.x2,s.y2,s.x1,s.y1].map(v=>Math.round(v*10)).join(',')+'|'+s.color;
    const key=k+'|'+s.color; if(seen.has(key)||seen.has(k2)) continue; seen.add(key); s.id=uniq.length; uniq.push(s); }
  return {segments:uniq,dots,rects,texts:merged,base};
}

// ============================================================ 2. build nets
function buildNets(raw, opt){
  const tol=opt.tol, segs=raw.segments;
  const pageArea=raw.base.width*raw.base.height;
  // components: rectangles of sensible size; name = text just above the top edge
  const bigRects=raw.rects.filter(r=>r.x1-r.x0>14 && r.y1-r.y0>14 && (r.x1-r.x0)*(r.y1-r.y0)<0.5*pageArea);
  const nameIdx=new Set();
  const comps=bigRects.map(r=>{ let ti=-1; raw.texts.forEach((t,i)=>{ if(ti<0 && t.y1<=r.y0+1 && t.y1>=r.y0-14 && t.x0<r.x1 && t.x1>r.x0) ti=i; }); if(ti>=0) nameIdx.add(ti); return {...r,name:ti>=0?raw.texts[ti].str:''}; });
  const strictlyInside=(x,y)=>comps.some(c=>x>c.x0+0.5&&x<c.x1-0.5&&y>c.y0+0.5&&y<c.y1-0.5);
  const inComp=(t)=>{ const cx=(t.x0+t.x1)/2, cy=(t.y0+t.y1)/2; let best=null; for(const c of comps) if(cx>=c.x0&&cx<=c.x1&&cy>=c.y0&&cy<=c.y1&&(!best||(c.x1-c.x0)*(c.y1-c.y0)<(best.x1-best.x0)*(best.y1-best.y0))) best=c; return best; };
  // classify: wire (conducts) vs graphics (attaches, never bridges)
  for(const s of segs){ s.isW = opt.colors.has(s.color) && opt.widths.has(wkey(s.lw)) && !s.closed && !s.curve && !(opt.insideRect && strictlyInside(s.x1,s.y1) && strictlyInside(s.x2,s.y2)); s.net=-1; s.pinOf=-1; s.pinNets=undefined; s.cl=undefined; }
  const n=segs.length, parent=Array.from({length:n},(_,i)=>i);
  const find=i=>{ while(parent[i]!==i){ parent[i]=parent[parent[i]]; i=parent[i]; } return i; };
  const touches=[]; // [wireSegIdx, graphicsSegIdx]
  const connected=new Uint8Array(n*2); // endpoint flags (idx*2 + end)
  const join=(i,j,ei)=>{ if(segs[i].isW===segs[j].isW){ const a=find(i),b=find(j); if(a!==b) parent[a]=b; } else touches.push(segs[i].isW?[i,j]:[j,i]); if(ei>=0) connected[i*2+ei]=1; };
  const grid=new Grid(Math.max(4,tol*4));
  segs.forEach((s,i)=>grid.add(i,Math.min(s.x1,s.x2)-tol,Math.min(s.y1,s.y2)-tol,Math.max(s.x1,s.x2)+tol,Math.max(s.y1,s.y2)+tol));
  const dotNear=(x,y)=>raw.dots.some(d=>dist(d.x,d.y,x,y)<=tol+d.r);
  segs.forEach((s,i)=>{
    [[s.x1,s.y1],[s.x2,s.y2]].forEach(([px,py],ei)=>{
      for(const j of grid.query(px-tol,py-tol,px+tol,py+tol)){ if(j===i) continue; const o=segs[j];
        if(dist(px,py,o.x1,o.y1)<=tol||dist(px,py,o.x2,o.y2)<=tol){ join(i,j,ei); continue; }
        const {d,t}=segPointDist(o,px,py);
        if(d<=tol && t>0 && t<1){ if(!opt.needDot || !(s.isW&&o.isW) || dotNear(px,py)) join(i,j,ei); } }
    });
  });
  for(const d of raw.dots){ const ids=[...grid.query(d.x-d.r-tol,d.y-d.r-tol,d.x+d.r+tol,d.y+d.r+tol)].filter(i=>segs[i].isW && segPointDist(segs[i],d.x,d.y).d<=tol+d.r);
    for(let k=1;k<ids.length;k++) join(ids[0],ids[k],-1);
    for(const i of ids){ const s=segs[i]; if(dist(s.x1,s.y1,d.x,d.y)<=tol+d.r) connected[i*2]=1; if(dist(s.x2,s.y2,d.x,d.y)<=tol+d.r) connected[i*2+1]=1; } }
  // wire nets and graphics clusters
  const netMap=new Map(), clMap=new Map();
  segs.forEach((s,i)=>{ const r=find(i); if(s.isW){ if(!netMap.has(r)) netMap.set(r,{segs:[],pins:[],labels:[],dots:[],dangling:[],nets:null}); const net=netMap.get(r); s.net=net; net.segs.push(s); }
    else { if(!clMap.has(r)) clMap.set(r,{segs:[],nets:new Set()}); const cl=clMap.get(r); s.cl=cl; cl.segs.push(s); } });
  for(const [wi,gi] of touches){ const net=segs[wi].net, g=segs[gi]; if(!net.pins.includes(g)) net.pins.push(g); g.cl.nets.add(net); g.pinNets=(g.pinNets||new Set()).add(net); }
  const clusters=[...clMap.values()];
  // group graphics clusters that sit almost touching (capacitor plates, split symbols) into one symbol for refdes purposes
  for(const cl of clusters){ cl.b=bboxOf(cl.segs.flatMap(s=>[[s.x1,s.y1],[s.x2,s.y2]])); cl.g=cl; }
  const cg=new Grid(16); clusters.forEach((cl,i)=>cg.add(i,cl.b.x0,cl.b.y0,cl.b.x1,cl.b.y1));
  const fg=cl=>{ while(cl.g!==cl) cl=cl.g; return cl; };
  const small=cl=>cl.segs.length<=24 && cl.b.x1-cl.b.x0<=60 && cl.b.y1-cl.b.y0<=60;
  clusters.forEach((cl,i)=>{ if(!small(cl)) return; for(const j of cg.query(cl.b.x0-6,cl.b.y0-6,cl.b.x1+6,cl.b.y1+6)){ const o=clusters[j]; if(o===cl||!small(o)) continue;
      const gx=Math.max(o.b.x0-cl.b.x1,0,cl.b.x0-o.b.x1), gy=Math.max(o.b.y0-cl.b.y1,0,cl.b.y0-o.b.y1);
      const ox=Math.min(cl.b.x1,o.b.x1)-Math.max(cl.b.x0,o.b.x0), oy=Math.min(cl.b.y1,o.b.y1)-Math.max(cl.b.y0,o.b.y0); // projection overlaps
      const minW=Math.max(1,Math.min(cl.b.x1-cl.b.x0,o.b.x1-o.b.x0)), minH=Math.max(1,Math.min(cl.b.y1-cl.b.y0,o.b.y1-o.b.y0));
      const aligned=(gx===0&&ox>=0.5*minW)||(gy===0&&oy>=0.5*minH); // stacked vertically with x-overlap, or side by side with y-overlap
      if(Math.hypot(gx,gy)<=6 && aligned){ const a=fg(cl),b=fg(o); if(a!==b) a.g=b; } } });
  const groups=new Map();
  for(const cl of clusters){ const r=fg(cl); if(!groups.has(r)) groups.set(r,{segs:[],nets:new Set(),members:[]}); const g=groups.get(r); g.segs.push(...cl.segs); cl.nets.forEach(n=>g.nets.add(n)); g.members.push(cl); cl.group=g; }
  for(const g of groups.values()) g.b=bboxOf(g.segs.flatMap(s=>[[s.x1,s.y1],[s.x2,s.y2]]));
  const refdesRe=/^[A-Z]{1,3}\d{1,3}[A-Z]?$/;
  const onBorder=(c,x,y)=>x>=c.x0-tol&&x<=c.x1+tol&&y>=c.y0-tol&&y<=c.y1+tol&&(Math.abs(x-c.x0)<=tol||Math.abs(x-c.x1)<=tol||Math.abs(y-c.y0)<=tol||Math.abs(y-c.y1)<=tol);
  const compOfSeg=s=>{ const c=comps.find(c=>onBorder(c,s.x1,s.y1)||onBorder(c,s.x2,s.y2)); if(c) return c.name; return s.cl&&s.cl.group.refdes||''; };
  // label candidates: every line end. Wire ends -> their net; graphics ends -> the net they hang on (pins of exactly one net,
  // or small clusters hanging on one net: power symbols, flags); pin-like lines with a free end are sinks that keep their own label unassigned.
  const cand=[]; const candGrid=new Grid(8);
  const addEnd=(s,ei,net)=>{ const x=ei?s.x2:s.x1, y=ei?s.y2:s.y1; candGrid.add(cand.length,x,y,x,y); cand.push({x,y,net,s,ei}); };
  for(const s of segs){ let net=null;
    if(s.isW) net=s.net; else if(s.pinNets&&s.pinNets.size===1) net=[...s.pinNets][0]; else if(!s.pinNets&&s.cl.nets.size===1&&s.cl.segs.length<=24) net=[...s.cl.nets][0];
    if(net){ addEnd(s,0,net); addEnd(s,1,net); }
    else if(!connected[s.id*2]||!connected[s.id*2+1]){ addEnd(s,0,null); addEnd(s,1,null); }
  }
  const labelOf=new Map();
  const VALUE_RE=/^\d+(\.\d+)?\s*[kKmMuUnNpPrRµΩ]\w*([/.-]\w+)*$|^\d+(\.\d+)?\s*(Ω|ohm|[uµn]?F|[um]?H|W|A)\b/;
  const attach=(t,ti)=>{ if(VALUE_RE.test(t.str)) return; let best=null, bd=opt.labelDist; const horiz=(t.x1-t.x0)>=(t.y1-t.y0);
    for(const ci of candGrid.query(t.x0-bd,t.y0-bd,t.x1+bd,t.y1+bd)){ const c=cand[ci]; let d=Math.hypot(Math.max(t.x0-c.x,0,c.x-t.x1),Math.max(t.y0-c.y,0,c.y-t.y1));
      if(horiz && c.y<t.y0) d+=2.5; // a point above the text is less likely its wire than one just below the baseline
      if(d<bd-1e-6 || (best&&Math.abs(d-bd)<1e-6&&best.s.isW&&!c.s.isW)){ bd=d; best=c; } }
    if(best&&best.net){ labelOf.set(ti,best); if(best.s.isW) connected[best.s.id*2+best.ei]=1; else if(best.s.cl && best.s.cl.group.nets.size===1 && /[A-Za-zА-Яа-я]/.test(t.str) && t.str.length>=2) best.s.cl.group.hasNetLabel=true; } };
  // pass A: ordinary labels (pin names, numbers, net labels). Power symbols get flagged by their net name.
  raw.texts.forEach((t,ti)=>{ if(nameIdx.has(ti)||refdesRe.test(t.str)) return; attach(t,ti); });
  // reference designators for symbols without a body rectangle (R1, C1, Q1...): nearest refdes-looking text, global greedy by distance
  const hosts=[...groups.values()].filter(g=>g.segs.length>=1 && !(g.nets.size===1&&g.hasNetLabel) && g.b.x1-g.b.x0<=120 && g.b.y1-g.b.y0<=120).map(g=>({cl:g,b:g.b}));
  const pairs=[];
  raw.texts.forEach((t,ti)=>{ if(nameIdx.has(ti)||!refdesRe.test(t.str)||inComp(t)) return;
    for(const h of hosts){ let d=Math.hypot(Math.max(h.b.x0-t.x1,0,t.x0-h.b.x1),Math.max(h.b.y0-t.y1,0,t.y0-h.b.y1)); if(d===0) d=8; /* overlapping a symbol's box: probably the neighbour's refdes */ if(d<=(h.cl.segs.length>=2?12:6)) pairs.push({d,ti,h}); } });
  pairs.sort((a,b)=>a.d-b.d); const usedT=new Set();
  for(const {ti,h} of pairs){ if(usedT.has(ti)||h.cl.refdes) continue; h.cl.refdes=raw.texts[ti].str; usedT.add(ti); nameIdx.add(ti); }
  // pass B: refdes-looking texts that are not refdes (net labels like D5)
  raw.texts.forEach((t,ti)=>{ if(nameIdx.has(ti)||!refdesRe.test(t.str)) return; attach(t,ti); });
  for(const [ti,c] of labelOf){ const t=raw.texts[ti]; const comp=inComp(t); const compName=comp?comp.name:(c.s.isW?'':compOfSeg(c.s)); c.net.labels.push({text:t, comp:compName, isNetLabel:!compName}); }
  // merge nets by identical net labels (labels outside component bodies only)
  let nets=[...netMap.values()];
  if(opt.mergeLabels){ const idx=new Map(nets.map((n,i)=>[n,i])); const p2=nets.map((_,i)=>i); const f2=i=>{ while(p2[i]!==i){ p2[i]=p2[p2[i]]; i=p2[i]; } return i; };
    const byName=new Map();
    for(const n of nets) for(const l of n.labels){ if(!l.isNetLabel) continue; const nm=l.text.str; if(!/[A-Za-zА-Яа-я]/.test(nm)||nm.length<2) continue; if(byName.has(nm)){ const a=f2(byName.get(nm)), b=f2(idx.get(n)); if(a!==b) p2[a]=b; } else byName.set(nm,idx.get(n)); }
    const groups=new Map(); nets.forEach((n,i)=>{ const r=f2(i); if(!groups.has(r)) groups.set(r,{segs:[],pins:[],labels:[],dots:[],dangling:[],parts:0}); const g=groups.get(r); g.segs.push(...n.segs); g.pins.push(...n.pins); g.labels.push(...n.labels); g.parts++; n.merged=g; });
    nets=[...groups.values()]; for(const s of segs) if(s.net) s.net=s.net.merged||s.net; }
  // dots and dangling ends per net
  for(const net of nets){ net.set=new Set(net.segs); }
  for(const d of raw.dots){ const i=[...grid.query(d.x-d.r-tol,d.y-d.r-tol,d.x+d.r+tol,d.y+d.r+tol)].find(i=>segs[i].isW && segPointDist(segs[i],d.x,d.y).d<=tol+d.r); if(i!==undefined) segs[i].net.dots.push(d); }
  for(const s of segs){ if(!s.isW) continue; if(!connected[s.id*2]) s.net.dangling.push([s.x1,s.y1]); if(!connected[s.id*2+1]) s.net.dangling.push([s.x2,s.y2]); }
  for(const net of nets){
    const names=[...new Set(net.labels.map(l=>l.text.str))], good=names.filter(s=>/[A-Za-zА-Яа-я]/.test(s)).sort((a,b)=>b.length-a.length);
    const netLbl=[...new Set(net.labels.filter(l=>l.isNetLabel).map(l=>l.text.str))].filter(s=>/[A-Za-zА-Яа-я]/.test(s));
    net.name=(netLbl.length?netLbl:good.length?good:names).slice(0,3).join(' / ');
    net.len=net.segs.reduce((a,s)=>a+dist(s.x1,s.y1,s.x2,s.y2),0);
    net.bbox=bboxOf(net.segs.flatMap(s=>[[s.x1,s.y1],[s.x2,s.y2]]));
  }
  nets.sort((a,b)=>(b.segs.length-a.segs.length)||(b.len-a.len));
  nets.forEach((n,i)=>{ n.index=i; n.color=`hsl(${(i*137.508)%360} 85% 55%)`; });
  // hit grid over wires + pins
  const hit=new Grid(8); const hitItems=[];
  for(const n of nets){ for(const s of n.segs){ hitItems.push([s,n]); hit.add(hitItems.length-1,Math.min(s.x1,s.x2),Math.min(s.y1,s.y2),Math.max(s.x1,s.x2),Math.max(s.y1,s.y2)); }
    for(const s of n.pins){ hitItems.push([s,n]); hit.add(hitItems.length-1,Math.min(s.x1,s.x2),Math.min(s.y1,s.y2),Math.max(s.x1,s.x2),Math.max(s.y1,s.y2)); } }
  const unconnectedClusters=[...clMap.values()].filter(c=>c.nets.size===0 && c.segs.length>1).length;
  const symbols=[...groups.values()].filter(g=>g.refdes).map(g=>({refdes:g.refdes,b:g.b}));
  return {nets, comps, symbols, hit, hitItems, wires:segs.filter(s=>s.isW).length, graphics:segs.filter(s=>!s.isW).length, unconnectedClusters};
}



// ============================================================ 3. document model across pages: nodes (named nets) and parts
const POWER_RE=/^([+-]?\d+([.,]\d+)?V\d*([_\-/.]\w*)?|V(CC|DD|SS|EE|BAT|IN|OUT|BUS|REF|SYS|PP|AA|IO|USB|CORE|DDR|LED|MOT|ANA|DIG)\w*|[ADPSC]?GND\w*|EARTH|PE|PP\d\w*|[1-9]V\d|VBB\w*|V[+-]|[+-]\d+V\w*)$/i;
const REFDES_RE=/^[A-Z]{1,3}\d{1,4}[A-Z]?$/;
const isPower=n=>POWER_RE.test(n.replace(/\s+/g,''));
const goodName=s=>/[A-Za-zА-Яа-я]/.test(s)&&s.length>=2;
const tcx=t=>(t.x0+t.x1)/2, tcy=t=>(t.y0+t.y1)/2;

function buildNodes(){
  const byName=new Map(); const nodes=[];
  const mk=()=>({key:'',name:'',names:new Set(),type:'signal',nets:[],labels:[],pages:new Set(),segs:0,pins:0,dangling:0});
  for(let p=1;p<S.pages.length;p++){ const pg=S.pages[p]; if(!pg||!pg.model) continue;
    for(const net of pg.model.nets){
      const names=[...new Set(net.labels.filter(l=>l.isNetLabel).map(l=>l.text.str))].filter(goodName);
      let node=null; for(const nm of names){ if(byName.has(nm)){ node=byName.get(nm); break; } }
      if(!node){ node=mk(); nodes.push(node); if(names.length){ node.name=names[0]; node.key='N:'+names[0]; } else { node.key=`P:${p}:${net.index}`; } }
      for(const nm of names){ node.names.add(nm); byName.set(nm,node); }
      node.nets.push({page:p,net}); net.node=node; node.pages.add(p); node.segs+=net.segs.length; node.pins+=net.labels.length; node.dangling+=net.dangling.length;
      for(const l of net.labels) node.labels.push({page:p,text:l.text,comp:l.comp,isNetLabel:l.isNetLabel});
    }
  }
  // Altium "Smart PDF" bookmarks carry the netlist: NETNAME -> [REF-PIN]; use it to name and merge nodes (best effort)
  if(S.outlineNets){ for(const [netName,pins] of S.outlineNets){ const hit=new Set();
      for(const node of nodes) for(const l of node.labels){ if(!l.comp) continue; const ref=l.comp.split(/\s+/)[0]; if(pins.has(ref+'-'+l.text.str)||pins.has(ref+'.'+l.text.str)) hit.add(node); }
      if(!hit.size) continue; const [first,...rest]=[...hit];
      for(const o of rest){ first.nets.push(...o.nets); first.labels.push(...o.labels); o.pages.forEach(x=>first.pages.add(x)); first.segs+=o.segs; first.pins+=o.pins; first.dangling+=o.dangling; o.names.forEach(x=>first.names.add(x)); o.nets.forEach(x=>x.net.node=first); o.dead=true; }
      if(!first.name){ first.name=netName; first.key='N:'+netName; } first.names.add(netName); } }
  S.nodes=nodes.filter(n=>!n.dead);
  for(const node of S.nodes){ node.type=[...node.names].some(isPower)?'power':'signal'; node.labelCount=node.labels.filter(l=>l.isNetLabel&&node.names.has(l.text.str)).length;
    node.labels.sort((a,b)=>(a.page-b.page)||(a.text.y0-b.text.y0)||(a.text.x0-b.text.x0)); }
  S.nodes.sort((a,b)=>(b.segs-a.segs)||(b.labels.length-a.labels.length));
  S.nodes.forEach((n,i)=>{ n.index=i; n.color=n.type==='power'?`hsl(${(i*137.508)%360} 80% 60%)`:`hsl(${(i*137.508)%360} 85% 55%)`; n.nets.forEach(x=>x.net.color=n.color); });
  S.nodeByKey=new Map(S.nodes.map(n=>[n.key,n]));
}

function buildParts(){
  const parts=new Map(); const unitRe=/^([A-Z]{1,3}\d{1,4})([A-Z])$/;
  const add=(ref,value,page,bbox)=>{ const m=unitRe.exec(ref); const base=m?m[1]:ref; const unit=m?m[2]:'';
    let p=parts.get(base+'@'+page); if(!p){ p={ref:base,value:'',page,bbox:{...bbox},units:new Set()}; parts.set(base+'@'+page,p); }
    if(unit) p.units.add(unit); if(value&&!p.value) p.value=value;
    p.bbox={x0:Math.min(p.bbox.x0,bbox.x0),y0:Math.min(p.bbox.y0,bbox.y0),x1:Math.max(p.bbox.x1,bbox.x1),y1:Math.max(p.bbox.y1,bbox.y1)}; };
  for(let p=1;p<S.pages.length;p++){ const pg=S.pages[p]; if(!pg||!pg.model) continue; const {raw,model}=pg;
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
    for(const t of raw.texts){ if(used.has(t)||!REFDES_RE.test(t.str)||inBody(t)) continue; const m=unitRe.exec(t.str); const base=m?m[1]:t.str; if(parts.has(base+'@'+p)) continue;
      used.add(t); add(t.str, valueOf(t,(t.x1-t.x0)>=(t.y1-t.y0)), p, t); }
  }
  S.parts=[...parts.values()].sort((a,b)=>{ const pa=a.ref.match(/^([A-Z]+)(\d+)/), pb=b.ref.match(/^([A-Z]+)(\d+)/); return (pa[1]<pb[1]?-1:pa[1]>pb[1]?1:0)||(+pa[2]-+pb[2])||(a.page-b.page); });
}

// ============================================================ 4. render
async function renderPage(keep){
  const dpr=window.devicePixelRatio||1, vp=S.page.getViewport({scale:S.zoom*dpr});
  pdfCanvas.width=vp.width; pdfCanvas.height=vp.height; pdfCanvas.style.width=(vp.width/dpr)+'px'; pdfCanvas.style.height=(vp.height/dpr)+'px';
  ov.width=vp.width; ov.height=vp.height; ov.style.width=pdfCanvas.style.width; ov.style.height=pdfCanvas.style.height;
  $('zoomVal').textContent=Math.round(S.zoom*100)+'%';
  if(keep){ const v=$('viewport'); v.scrollLeft=keep.px*S.zoom+16-keep.cx; v.scrollTop=keep.py*S.zoom+16-keep.cy; }
  const task=S.page.render({canvasContext:pdfCanvas.getContext('2d'), viewport:vp}); S.renderTask=task;
  try{ await task.promise; }catch(e){ if(e&&e.name==='RenderingCancelledException') return; throw e; }
  drawOverlay();
}
function curNetsOf(node){ return node?node.nets.filter(x=>x.page===S.pageIndex).map(x=>x.net):[]; }
function drawOverlay(){
  const dpr=window.devicePixelRatio||1, k=S.zoom*dpr, z=S.zoom;
  octx.setTransform(1,0,0,1,0,0); octx.clearRect(0,0,ov.width,ov.height); octx.setTransform(k,0,0,k,0,0); octx.lineCap='round'; octx.lineJoin='round';
  if(!S.model) return;
  const sel=S.selKey?S.nodeByKey.get(S.selKey):null, hov=S.hover?S.nodeByKey.get(S.hover):null;
  const strokeSegs=(list,w)=>{ octx.lineWidth=w/z; octx.beginPath(); for(const s of list){ octx.moveTo(s.x1,s.y1); octx.lineTo(s.x2,s.y2); } octx.stroke(); };
  if($('showAll').checked){ octx.globalAlpha=0.55; for(const n of S.model.nets){ if(sel&&n.node===sel) continue; octx.strokeStyle=n.color; strokeSegs(n.segs,2.2); } octx.globalAlpha=1; }
  if((sel||S.selPart)&&$('dim').checked){ octx.fillStyle='rgba(255,255,255,0.62)'; octx.fillRect(0,0,ov.width/k,ov.height/k); }
  const drawNets=(nets,color,w,glow)=>{ for(const n of nets){
    if(glow){ octx.strokeStyle=color; octx.globalAlpha=0.35; strokeSegs(n.segs,w+8); octx.globalAlpha=1; }
    octx.strokeStyle=color; strokeSegs(n.segs,w); octx.globalAlpha=0.85; strokeSegs(n.pins,w*0.6); octx.globalAlpha=1;
    octx.fillStyle=color; for(const d of n.dots){ octx.beginPath(); octx.arc(d.x,d.y,d.r+1.5/z,0,7); octx.fill(); }
    octx.strokeStyle=color; octx.lineWidth=1/z; for(const l of n.labels){ const t=l.text; octx.strokeRect(t.x0-1.5,t.y0-1.5,t.x1-t.x0+3,t.y1-t.y0+3); } } };
  const drawDangling=n=>{ octx.strokeStyle='#ff8c42'; octx.lineWidth=1.5/z; for(const [x,y] of n.dangling){ octx.beginPath(); octx.arc(x,y,4/z,0,7); octx.stroke(); } };
  if($('showDangling').checked) for(const n of S.model.nets) drawDangling(n);
  if(hov&&hov!==sel) drawNets(curNetsOf(hov),'#4cc9ff',3,false);
  if(sel){ const nets=curNetsOf(sel); drawNets(nets,'#ff3d71',3.5,true); nets.forEach(drawDangling); }
  if(S.selPart&&S.selPart.page===S.pageIndex){ const b=S.selPart.bbox; octx.strokeStyle='#ff3d71'; octx.lineWidth=2/z; octx.strokeRect(b.x0-3,b.y0-3,b.x1-b.x0+6,b.y1-b.y0+6); }
  // search markers
  if(S.results.length){ octx.fillStyle='rgba(255,220,0,0.35)'; octx.strokeStyle='rgba(255,180,0,0.9)'; octx.lineWidth=1/z;
    S.results.forEach((r,i)=>{ if(r.page!==S.pageIndex) return; const b=r.bbox; octx.fillRect(b.x0-2,b.y0-2,b.x1-b.x0+4,b.y1-b.y0+4); if(i===S.resIdx){ octx.lineWidth=2/z; octx.strokeRect(b.x0-3,b.y0-3,b.x1-b.x0+6,b.y1-b.y0+6); octx.lineWidth=1/z; } }); }
  // blinking border for the current label / jump target
  if(S.blink&&S.blink.page===S.pageIndex&&Date.now()<S.blink.until&&Math.floor(Date.now()/250)%2===0){ const b=S.blink.bbox; octx.strokeStyle='#ff3d71'; octx.lineWidth=2.5/z; octx.strokeRect(b.x0-4,b.y0-4,b.x1-b.x0+8,b.y1-b.y0+8); }
}
function startBlink(page,bbox){ S.blink={page,bbox,until:Date.now()+2200}; const tick=()=>{ if(!S.blink) return; drawOverlay(); if(Date.now()<S.blink.until) requestAnimationFrame(tick); else { S.blink=null; drawOverlay(); } }; tick(); }

// ============================================================ 5. navigation: pages, zoom, pan
async function showPage(p, keep){ if(!S.doc) return; p=Math.max(1,Math.min(S.doc.numPages,p)); if(S.renderTask){ try{ S.renderTask.cancel(); }catch{} }
  S.pageIndex=p; $('pageNum').value=p; const pg=S.pages[p]; S.raw=pg.raw; S.model=pg.model; S.page=pg.page; S.hover=null; renderPageDots(); await renderPage(keep); }
function renderPageDots(){ const el=$('pageDots'); if(!S.doc||S.doc.numPages<2||S.doc.numPages>40){ el.innerHTML=''; return; } const sel=S.selKey?S.nodeByKey.get(S.selKey):null;
  el.innerHTML=Array.from({length:S.doc.numPages},(_,i)=>`<span data-p="${i+1}" class="${i+1===S.pageIndex?'cur':''} ${sel&&sel.pages.has(i+1)?'has':''}" title="${i+1}"></span>`).join('');
  el.querySelectorAll('span').forEach(s=>s.onclick=()=>showPage(+s.dataset.p)); }
$('pageNum').onchange=()=>showPage(+$('pageNum').value||1); $('pagePrev').onclick=()=>showPage(S.pageIndex-1); $('pageNext').onclick=()=>showPage(S.pageIndex+1);
function zoomAt(z, cx, cy){ // keep the page point under (cx,cy) viewport-client coords fixed
  const v=$('viewport'); const r=v.getBoundingClientRect(); cx=cx??r.width/2; cy=cy??r.height/2;
  const px=(v.scrollLeft+cx-16)/S.zoom, py=(v.scrollTop+cy-16)/S.zoom; S.zoom=Math.max(0.15,Math.min(10,z)); if(S.page) renderPage({px,py,cx,cy}); }
const fitWidth=()=>{ if(S.raw) zoomAt(($('viewport').clientWidth-40)/S.raw.base.width); };
const fitPage=()=>{ if(S.raw) zoomAt(Math.min(($('viewport').clientWidth-40)/S.raw.base.width,($('viewport').clientHeight-40)/S.raw.base.height)); };
$('zoomIn').onclick=$('zoomIn2').onclick=()=>zoomAt(S.zoom*1.25); $('zoomOut').onclick=$('zoomOut2').onclick=()=>zoomAt(S.zoom/1.25); $('zoomFit').onclick=fitWidth; $('zoomFitPage').onclick=$('zoomFit2').onclick=fitPage;
$('viewport').addEventListener('wheel',e=>{ if(!S.page) return; e.preventDefault(); const r=$('viewport').getBoundingClientRect(); zoomAt(S.zoom*(e.deltaY<0?1.12:1/1.12), e.clientX-r.left, e.clientY-r.top); },{passive:false});
// pointer: click vs drag-pan, pinch zoom
const ptr={down:false,moved:false,x:0,y:0,sl:0,st:0,pts:new Map(),pinch:null};
ov.addEventListener('pointerdown',e=>{ ptr.pts.set(e.pointerId,{x:e.clientX,y:e.clientY}); ov.setPointerCapture(e.pointerId);
  if(ptr.pts.size===2){ const [a,b]=[...ptr.pts.values()]; ptr.pinch={d:Math.hypot(a.x-b.x,a.y-b.y),z:S.zoom}; return; }
  ptr.down=true; ptr.moved=false; ptr.x=e.clientX; ptr.y=e.clientY; ptr.sl=$('viewport').scrollLeft; ptr.st=$('viewport').scrollTop; });
ov.addEventListener('pointermove',e=>{ if(ptr.pts.has(e.pointerId)) ptr.pts.set(e.pointerId,{x:e.clientX,y:e.clientY});
  if(ptr.pinch&&ptr.pts.size===2){ const [a,b]=[...ptr.pts.values()]; const d=Math.hypot(a.x-b.x,a.y-b.y); const r=$('viewport').getBoundingClientRect(); zoomAt(ptr.pinch.z*d/ptr.pinch.d,(a.x+b.x)/2-r.left,(a.y+b.y)/2-r.top); return; }
  if(ptr.down){ const dx=e.clientX-ptr.x, dy=e.clientY-ptr.y; if(!ptr.moved&&Math.hypot(dx,dy)>4){ ptr.moved=true; ov.classList.add('panning'); }
    if(ptr.moved){ $('viewport').scrollLeft=ptr.sl-dx; $('viewport').scrollTop=ptr.st-dy; return; } }
  if(e.pointerType==='mouse') onHover(e); });
const endPtr=e=>{ ptr.pts.delete(e.pointerId); if(ptr.pts.size<2) ptr.pinch=null; if(!ptr.down) return; ptr.down=false; ov.classList.remove('panning'); if(!ptr.moved&&e.type==='pointerup') onClick(e); };
ov.addEventListener('pointerup',endPtr); ov.addEventListener('pointercancel',endPtr);
ov.addEventListener('pointerleave',()=>{ S.hover=null; $('tip').style.display='none'; drawOverlay(); });
ov.addEventListener('dblclick',e=>{ const r=$('viewport').getBoundingClientRect(); zoomAt(S.zoom*(e.shiftKey?0.5:2),e.clientX-r.left,e.clientY-r.top); });
document.addEventListener('keydown',e=>{ if(e.target.matches('input,select,textarea')){ if(e.key==='Escape') e.target.blur(); return; }
  const v=$('viewport'); if(e.key==='Escape') clearSelection(); else if(e.key==='+'||e.key==='=') zoomAt(S.zoom*1.25); else if(e.key==='-') zoomAt(S.zoom/1.25); else if(e.key==='0') fitPage();
  else if(e.key==='ArrowLeft') v.scrollLeft-=60; else if(e.key==='ArrowRight') v.scrollLeft+=60; else if(e.key==='ArrowUp') v.scrollTop-=60; else if(e.key==='ArrowDown') v.scrollTop+=60; else if(e.key==='PageDown') showPage(S.pageIndex+1); else if(e.key==='PageUp') showPage(S.pageIndex-1); else return; e.preventDefault(); });
function scrollTo(page,bbox){ const go=()=>{ const v=$('viewport'); const cx=(bbox.x0+bbox.x1)/2*S.zoom+16, cy=(bbox.y0+bbox.y1)/2*S.zoom+16; v.scrollTo({left:cx-v.clientWidth/2, top:cy-v.clientHeight/2, behavior:'smooth'}); startBlink(page,bbox); };
  if(page!==S.pageIndex) showPage(page).then(go); else go(); }

// ============================================================ 6. selection
function hitAt(cssX,cssY,touch){ if(!S.model) return null; const x=cssX/S.zoom, y=cssY/S.zoom, thr=(touch?14:6)/S.zoom; let best=null,bd=thr; const near=new Map();
  for(const i of S.model.hit.query(x-thr,y-thr,x+thr,y+thr)){ const [s,n]=S.model.hitItems[i]; const {d}=segPointDist(s,x,y); if(d<thr){ const nd=n.node; if(!near.has(nd)||near.get(nd)>d) near.set(nd,d); } if(d<bd){ bd=d; best=n; } }
  if(best) return {node:best.node, candidates:[...near.entries()].sort((a,b)=>a[1]-b[1]).map(([nd])=>nd)};
  const part=S.parts.find(p=>p.page===S.pageIndex&&x>=p.bbox.x0-2&&x<=p.bbox.x1+2&&y>=p.bbox.y0-2&&y<=p.bbox.y1+2); if(part) return {part};
  return null; }
function onHover(e){ const r=ov.getBoundingClientRect(); const h=hitAt(e.clientX-r.left,e.clientY-r.top); const key=h&&h.node?h.node.key:null; if(key!==S.hover){ S.hover=key; drawOverlay(); }
  const tip=$('tip'); if(h&&h.node){ const n=h.node; tip.textContent=T('tip',{name:nodeName(n),segs:n.segs,labels:n.pins}); tip.style.display='block'; tip.style.left=(e.clientX+14)+'px'; tip.style.top=(e.clientY+14)+'px'; }
  else if(h&&h.part){ tip.textContent=h.part.ref+(h.part.value?' · '+h.part.value:''); tip.style.display='block'; tip.style.left=(e.clientX+14)+'px'; tip.style.top=(e.clientY+14)+'px'; } else tip.style.display='none'; }
function onClick(e){ const r=ov.getBoundingClientRect(); const touch=e.pointerType==='touch'; const h=hitAt(e.clientX-r.left,e.clientY-r.top,touch);
  if(h&&h.node){ if(touch&&h.candidates.length>1){ const vr=$('viewport').getBoundingClientRect(); chooserShow(h.candidates.slice(0,6),e.clientX-vr.left,e.clientY-vr.top); return; } selectNode(h.node.key); if(touch&&sheetState==='expanded') setSheet('default'); }
  else if(h&&h.part) selectPart(h.part); else clearSelection(); }
const nodeName=n=>n.name||T('netN',{n:n.index+1});
function clearSelection(){ S.selKey=null; S.selPart=null; S.labelIdx=0; drawOverlay(); renderLists(); renderDetail(); renderPageDots(); }
function selectNode(key,fromList){ const node=S.nodeByKey.get(key); if(!node) return; if(fromList&&window.innerWidth<=800&&sheetState==='expanded') setSheet('default');
  if(S.selKey===key&&fromList){ stepLabel(1); return; }
  S.selKey=key; S.selPart=null; S.labelIdx=0; renderPageDots(); renderLists(); renderDetail();
  if(fromList){ const nets=curNetsOf(node); if(nets.length){ const b=nets[0].bbox; scrollTo(S.pageIndex,b); } else if(node.nets.length){ const x=node.nets[0]; scrollTo(x.page,x.net.bbox); } }
  else drawOverlay(); }
function selectPart(part,jump){ S.selPart=part; S.selKey=null; renderLists(); renderDetail(); if(jump) scrollTo(part.page,part.bbox); else drawOverlay(); }
function stepLabel(d){ const node=S.nodeByKey.get(S.selKey); if(!node||!node.labels.length) return; S.labelIdx=(S.labelIdx+d+node.labels.length)%node.labels.length; const l=node.labels[S.labelIdx]; renderDetail(); scrollTo(l.page,l.text); }
$('detail').addEventListener('click',e=>{ const b=e.target.closest('button'); if(!b) return; if(b.id==='lblPrev') stepLabel(-1); else if(b.id==='lblNext') stepLabel(1); else if(b.id==='lblGo'){ const node=S.nodeByKey.get(S.selKey); if(node&&node.labels.length){ const l=node.labels[S.labelIdx]; scrollTo(l.page,l.text); } } });

// ============================================================ 7. side panel
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const badge=n=>`<span class="badge ${n.type==='power'?'pwr':'sig'}">${n.type==='power'?T('power'):T('signal')}</span>`;
function renderDetail(){ const d=$('detail');
  if(S.selPart){ const p=S.selPart; d.className=''; d.innerHTML=`<div><b>${esc(p.ref)}</b>${p.units.size?' <span class="hint">('+[...p.units].sort().join(', ')+')</span>':''} ${p.value?'· '+esc(p.value):''}</div><div class="hint">${T('pageN',{n:p.page})}</div>`; return; }
  if(!S.selKey){ d.className='hint'; d.textContent=T('detailHint'); return; }
  const n=S.nodeByKey.get(S.selKey); d.className='';
  const pins=n.labels.map((l,i)=>`<li${i===S.labelIdx?' style="color:#ff3d71"':''}>${l.comp?`<code>${esc(l.comp)}</code> → `:''}<b>${esc(l.text.str)}</b>${l.isNetLabel&&!l.comp?' <span class="hint">'+T('labelTag')+'</span>':''}${n.pages.size>1?` <span class="hint">p${l.page}</span>`:''}</li>`);
  d.innerHTML=`<div><b>${esc(nodeName(n))}</b> ${badge(n)}${n.names.size>1?' <span class="hint">'+esc([...n.names].filter(x=>x!==n.name).join(', '))+'</span>':''}</div>
    <div class="hint">${T('detailLine',{segs:n.segs,pins:n.pins,pages:[...n.pages].sort((a,b)=>a-b).join(', ')})}</div>
    ${n.labels.length?`<div id="labelNav"><button class="sm icon" id="lblPrev">◀</button><button class="sm" id="lblGo">${S.labelIdx+1} / ${n.labels.length}</button><button class="sm icon" id="lblNext">▶</button><span class="hint">${T('labelNavHint')}</span></div><ul>${pins.join('')}</ul>`:'<div class="hint">'+T('noLabels')+'</div>'}
    ${n.dangling?`<div class="warnbox">${T('danglingWarn',{n:n.dangling})}</div>`:''}`; }
function renderLists(){ renderNetList(); renderPartList(); renderResults(); }
function renderNetList(){ const el=$('netlist'); const q=S.query.toLowerCase();
  const list=S.nodes.filter(n=>!q||nodeName(n).toLowerCase().includes(q)||[...n.names].some(x=>x.toLowerCase().includes(q))||n.labels.some(l=>l.text.str.toLowerCase().includes(q)||l.comp.toLowerCase().includes(q)));
  $('netsCount').textContent=S.nodes.length||'';
  el.innerHTML=list.map(n=>`<div class="net${n.key===S.selKey?' sel':''}" data-k="${esc(n.key)}"><span class="n">#${n.index+1}</span><span class="sw" style="background:${n.color}"></span><span class="name">${esc(nodeName(n))}${n.labelCount>1?' <span class="cnt">×'+n.labelCount+'</span>':''}</span>${n.name?badge(n):''}${n.dangling?`<span class="warn">⚠${n.dangling}</span>`:''}<span class="cnt">${T('segs',{n:n.segs})}${n.pins?' · '+T('pins',{n:n.pins}):''}${S.doc&&S.doc.numPages>1?' · p'+[...n.pages].sort((a,b)=>a-b).join(','):''}</span></div>`).join('')+(list.length?'':'<div class="hint" style="padding:8px 12px">'+T('nothingFound')+'</div>');
  el.querySelectorAll('.net').forEach(x=>x.onclick=()=>selectNode(x.dataset.k,true)); const s=el.querySelector('.net.sel'); if(s) s.scrollIntoView({block:'nearest'}); }
function renderPartList(){ const el=$('partlist'); const q=S.query.toLowerCase(); const list=S.parts.filter(p=>!q||p.ref.toLowerCase().includes(q)||p.value.toLowerCase().includes(q)); $('partsCount').textContent=S.parts.length||'';
  el.innerHTML=list.map((p,i)=>`<div class="part${p===S.selPart?' sel':''}" data-i="${S.parts.indexOf(p)}"><span class="name" style="flex:0 0 64px">${esc(p.ref)}${p.units.size?'<span class="hint">'+[...p.units].sort().join('')+'</span>':''}</span><span style="flex:1;color:var(--muted)">${esc(p.value)}</span>${S.doc&&S.doc.numPages>1?'<span class="cnt">p'+p.page+'</span>':''}</div>`).join('')+(list.length?'':'<div class="hint" style="padding:8px 12px">'+(S.parts.length?T('nothingFound'):T('noParts'))+'</div>');
  el.querySelectorAll('.part').forEach(x=>x.onclick=()=>selectPart(S.parts[+x.dataset.i],true)); }
$('tabs').querySelectorAll('button').forEach(b=>b.onclick=()=>setTab(b.dataset.tab));
function setTab(t){ S.tab=t; $('tabs').querySelectorAll('button').forEach(b=>b.classList.toggle('on',b.dataset.tab===t)); document.querySelectorAll('.pane').forEach(p=>p.classList.toggle('on',p.id==='pane-'+t)); }

// ============================================================ 8. search
let searchTimer=null;
$('search').oninput=e=>{ S.query=e.target.value.trim(); renderNetList(); renderPartList(); clearTimeout(searchTimer); searchTimer=setTimeout(()=>runSearch(true),250); };
$('search').onkeydown=e=>{ if(e.key==='Enter'){ e.preventDefault(); if(!S.results.length) runSearch(true); else gotoResult(S.resIdx<0?0:S.resIdx); } else if(e.key==='Escape'){ $('search').value=''; S.query=''; runSearch(false); renderNetList(); renderPartList(); } };
$('searchPrev').onclick=()=>gotoResult(S.resIdx-1); $('searchNext').onclick=()=>gotoResult(S.resIdx+1);
function runSearch(jump){ const q=S.query.toLowerCase(); S.results=[]; S.resIdx=-1;
  if(q){ const labelOf=new Map(); for(const n of S.nodes) for(const l of n.labels) labelOf.set(l.text,{node:n,l});
    for(let p=1;p<S.pages.length;p++){ const pg=S.pages[p]; if(!pg||!pg.raw) continue;
      for(const t of pg.raw.texts){ const s=t.str.toLowerCase(); if(!s.includes(q)) continue; const lab=labelOf.get(t); const part=S.parts.find(x=>x.page===p&&(x.ref.toLowerCase()===s||(x.bbox.x0<=t.x0&&x.bbox.x1>=t.x1&&x.bbox.y0<=t.y0&&x.bbox.y1>=t.y1&&REFDES_RE.test(t.str))));
        const kind=lab?(lab.l.isNetLabel?'net':'pin'):part?'part':'text'; S.results.push({kind,page:p,bbox:t,label:t.str,exact:s===q,node:lab?lab.node:null,part:part||null,comp:lab?lab.l.comp:''}); } } }
  const prio={net:0,part:1,pin:2,text:3}; S.results.sort((a,b)=>(b.exact-a.exact)||(prio[a.kind]-prio[b.kind])||(a.page-b.page)||(a.bbox.y0-b.bbox.y0));
  const exact=S.results.filter(r=>r.exact).length; $('searchInfo').textContent=q?T('searchInfo',{n:S.results.length,e:exact}):''; $('resCount').textContent=S.results.length||'';
  renderResults(); if(q&&S.results.length&&S.tab!=='results'&&S.tab!=='nets'&&S.tab!=='parts') setTab('results');
  if(jump&&q.length>=2&&S.results.length) gotoResult(0); else drawOverlay(); }
function gotoResult(i){ if(!S.results.length) return; S.resIdx=(i+S.results.length)%S.results.length; const r=S.results[S.resIdx]; renderResults(); scrollTo(r.page,r.bbox); }
function renderResults(){ const el=$('reslist'); const kindLbl={net:T('kindNet'),part:T('kindPart'),pin:T('kindPin'),text:T('kindText')};
  el.innerHTML=S.results.slice(0,400).map((r,i)=>`<div class="res${i===S.resIdx?' sel':''}" data-i="${i}"><span class="badge ${r.kind==='net'?'sig':r.kind==='part'?'pwr':''}" style="${r.kind==='pin'||r.kind==='text'?'background:#2b313b;color:var(--muted)':''}">${kindLbl[r.kind]}</span><span class="name">${esc(r.label)}${r.exact?' <span class="cnt">=</span>':''}</span><span class="cnt">${r.node?esc(nodeName(r.node)):r.comp?esc(r.comp):''}${S.doc&&S.doc.numPages>1?' p'+r.page:''}</span></div>`).join('')+(S.results.length?'':'<div class="hint" style="padding:8px 12px">'+(S.query?T('nothingFound'):T('resultsHint'))+'</div>');
  el.querySelectorAll('.res').forEach(x=>x.onclick=()=>{ const r=S.results[+x.dataset.i]; S.resIdx=+x.dataset.i; if(r.node) { S.selKey=r.node.key; S.selPart=null; } else if(r.part){ S.selPart=r.part; S.selKey=null; } renderPageDots(); renderLists(); renderDetail(); scrollTo(r.page,r.bbox); }); }

// ============================================================ 9. export
const csvCell=v=>{ v=String(v??''); if(/^[=+\-@]/.test(v)) v='="'+v.replace(/"/g,'""')+'"'; else if(/[",\n;]/.test(v)) v='"'+v.replace(/"/g,'""')+'"'; return v; };
async function deliver(name,text){ try{ const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob(['﻿'+text],{type:'text/csv;charset=utf-8'})); a.download=name; document.body.appendChild(a); a.click(); a.remove(); }catch{}
  try{ await navigator.clipboard.writeText(text); }catch{} }
$('menuBtn').onclick=e=>{ e.stopPropagation(); $('menu').style.display=$('menu').style.display==='block'?'none':'block'; }; document.addEventListener('click',()=>$('menu').style.display='none');
$('csvNodes').onclick=()=>{ if(!S.nodes.length) return; const rows=[['name','type','labels','pages','wires','pins'].join(',')];
  for(const n of S.nodes) rows.push([nodeName(n),n.type,n.labelCount,[...n.pages].sort((a,b)=>a-b).join(' '),n.segs,n.labels.map(l=>(l.comp?l.comp.split(/\s+/)[0]+'.':'')+l.text.str).join(' ')].map(csvCell).join(','));
  deliver('nodes.csv',rows.join('\r\n')); };
$('csvParts').onclick=()=>{ if(!S.parts.length) return; const rows=[['reference','value','units','page'].join(',')]; for(const p of S.parts) rows.push([p.ref,p.value,[...p.units].sort().join(''),p.page].map(csvCell).join(',')); deliver('parts.csv',rows.join('\r\n')); };
$('copy').onclick=async()=>{ if(!S.nodes.length) return; const txt=S.nodes.map(n=>`${nodeName(n)}\t${n.type}\t${n.segs} seg\t${n.labels.map(l=>(l.comp?l.comp.split(/\s+/)[0]+'.':'')+l.text.str).join(', ')}${n.dangling?'\tDANGLING:'+n.dangling:''}`).join('\n');
  try{ await navigator.clipboard.writeText(txt); $('copy').textContent=T('copied'); setTimeout(()=>$('copy').textContent=T('copy'),1500); }catch{ $('copy').textContent=T('clipboardNA'); } };

// ============================================================ 10. settings, filters, (re)build
function renderFilters(){ const cc=new Map(), wc=new Map();
  for(let p=1;p<S.pages.length;p++){ const pg=S.pages[p]; if(!pg||!pg.raw) continue; for(const s of pg.raw.segments){ const L=dist(s.x1,s.y1,s.x2,s.y2); cc.set(s.color,(cc.get(s.color)||0)+1); const k=wkey(s.lw); wc.set(k,(wc.get(k)||0)+L); } }
  const mk=(el,entries,set,fmt)=>{ el.innerHTML=entries.map(([k,v])=>`<label><input type="checkbox" data-k="${k}" ${set.has(k)?'checked':''}>${fmt(k,v)}</label>`).join('');
    el.querySelectorAll('input').forEach(i=>i.onchange=()=>{ if(i.checked) set.add(i.dataset.k); else set.delete(i.dataset.k); rebuildAll(); }); };
  mk($('colors'),[...cc.entries()].sort((a,b)=>b[1]-a[1]),S.colorsOn,(k,v)=>`<span class="sw" style="background:${k}"></span>${k} <span class="hint">(${v})</span>`);
  mk($('widths'),[...wc.entries()].sort((a,b)=>b[1]-a[1]),S.widthsOn,(k,v)=>`${k} <span class="hint">(${(v/1000).toFixed(1)}k pt)</span>`); }
function defaultFilters(){ S.colorsOn=new Set(); const wc=new Map();
  for(let p=1;p<S.pages.length;p++){ const pg=S.pages[p]; if(!pg||!pg.raw) continue; for(const s of pg.raw.segments){ S.colorsOn.add(s.color); if(s.closed||s.curve) continue; const k=wkey(s.lw); wc.set(k,(wc.get(k)||0)+dist(s.x1,s.y1,s.x2,s.y2)); } }
  const max=Math.max(0,...wc.values()); S.widthsOn=new Set([...wc.entries()].filter(([k,v])=>v>=0.25*max).map(([k])=>k)); }
function opts(){ return {colors:S.colorsOn, widths:S.widthsOn, tol:+$('tol').value||1, labelDist:+$('labelDist').value||8, needDot:$('needDot').checked, mergeLabels:$('mergeLabels').checked, insideRect:$('insideRect').checked}; }
function rebuildAll(){ if(!S.pages.length) return; const o=opts(); for(let p=1;p<S.pages.length;p++){ const pg=S.pages[p]; if(pg&&pg.raw) pg.model=buildNets(pg.raw,o); } S.model=S.pages[S.pageIndex].model;
  S.selKey=null; S.selPart=null; S.hover=null; buildNodes(); buildParts(); renderAll(); runSearch(false); }
function renderAll(){ let segs=0,wires=0,gr=0,dots=0,texts=0,comps=0,dang=0,unc=0; for(let p=1;p<S.pages.length;p++){ const pg=S.pages[p]; if(!pg||!pg.model) continue; segs+=pg.raw.segments.length; wires+=pg.model.wires; gr+=pg.model.graphics; dots+=pg.raw.dots.length; texts+=pg.raw.texts.length; comps+=pg.model.comps.length; dang+=pg.model.nets.reduce((a,n)=>a+n.dangling.length,0); unc+=pg.model.unconnectedClusters; }
  $('stats').innerHTML=T('stats',{segs,wires,graphics:gr,dots,texts,nets:S.nodes.length,labelled:S.nodes.filter(n=>n.pins).length,comps:S.parts.length,dangling:dang,pages:S.pages.length-1});
  const w=[]; if(!texts) w.push(T('warnNoText')); if(!segs) w.push(T('warnNoLines')); if(unc>5) w.push(T('warnUnconnected',{n:unc})); $('warnings').innerHTML=w.map(x=>`<div class="warnbox">⚠ ${x}</div>`).join('');
  renderPageDots(); renderLists(); renderDetail(); drawOverlay(); }
['needDot','mergeLabels','insideRect'].forEach(id=>$(id).onchange=rebuildAll); ['tol','labelDist'].forEach(id=>$(id).onchange=rebuildAll);
$('showAll').onchange=drawOverlay; $('showDangling').onchange=drawOverlay; $('dim').onchange=drawOverlay;

// ============================================================ 11. loading
async function readOutline(doc){ try{ const ol=await doc.getOutline(); if(!ol) return null; const nets=new Map();
    const walk=(items)=>{ for(const it of items||[]){ const kids=it.items||[]; const pinLike=kids.filter(k=>/^[A-Z]{1,3}\d{1,4}[A-Z]?[-.]\S+$/.test((k.title||'').trim()));
        if(kids.length&&pinLike.length>=Math.max(1,kids.length*0.6)) nets.set(it.title.trim(),new Set(pinLike.map(k=>k.title.trim()))); else walk(kids); } };
    walk(ol); return nets.size?nets:null; }catch{ return null; } }
async function loadData(data){ $('drop').classList.add('hidden'); $('busy').style.display='block'; $('busy').textContent=T('parsing'); S.results=[]; S.query=''; $('search').value=''; $('searchInfo').textContent='';
  try{ if(S.doc){ try{ await S.doc.destroy(); }catch{} }
    S.doc=await pdfjsLib.getDocument({data}).promise; const N=S.doc.numPages; $('pageCount').textContent=N; $('pageNum').max=N; S.pages=[null];
    for(let p=1;p<=N;p++){ $('busy').textContent=T('analyzing',{i:p,n:N}); const page=await S.doc.getPage(p); const raw=await extractPage(page); S.pages.push({page,raw,model:null}); }
    S.outlineNets=await readOutline(S.doc);
    defaultFilters(); renderFilters(); const o=opts(); for(let p=1;p<=N;p++) S.pages[p].model=buildNets(S.pages[p].raw,o);
    buildNodes(); buildParts(); S.selKey=null; S.selPart=null;
    S.pageIndex=1; $('pageNum').value=1; S.raw=S.pages[1].raw; S.model=S.pages[1].model; S.page=S.pages[1].page;
    S.zoom=Math.max(0.3,Math.min(3,($('viewport').clientWidth-40)/S.raw.base.width)); await renderPage(); renderAll(); setTab('nets'); }
  catch(e){ console.error(e); $('stats').textContent=(e&&e.name==='PasswordException'?T('encrypted'):T('openError')+e.message); $('drop').classList.remove('hidden'); $('drop').innerHTML='<div>'+esc(e&&e.name==='PasswordException'?T('encrypted'):T('openError')+e.message)+'</div>'; }
  $('busy').style.display='none'; }
$('file').onchange=async e=>{ const f=e.target.files[0]; if(f){ document.title=f.name+' — Net Tracer'; loadData(new Uint8Array(await f.arrayBuffer())); } };
$('viewport').addEventListener('dragover',e=>e.preventDefault());
$('viewport').addEventListener('drop',async e=>{ e.preventDefault(); const f=e.dataTransfer.files[0]; if(f){ document.title=f.name+' — Net Tracer'; loadData(new Uint8Array(await f.arrayBuffer())); } });
$('viewport').addEventListener('paste',e=>{ const f=[...(e.clipboardData?.files||[])][0]; if(f) f.arrayBuffer().then(b=>loadData(new Uint8Array(b))); });


// ============================================================ 12. mobile: mirrors, bottom sheet, tap chooser
const isTouch=matchMedia('(pointer:coarse)').matches; if(isTouch) document.body.classList.add('touch');
document.querySelectorAll('[data-mirror]').forEach(m=>{ const master=$(m.dataset.mirror); const sync=()=>{ if(m.type==='checkbox') m.checked=master.checked; else m.value=master.value; }; sync();
  m.addEventListener('change',()=>{ if(m.type==='checkbox') master.checked=m.checked; else master.value=m.value; master.dispatchEvent(new Event('change')); });
  master.addEventListener('change',sync); });
$('openBtn').onclick=()=>$('file').click(); $('dropBtn').onclick=()=>$('file').click(); $('demoM').onclick=()=>$('demo').click();
const aside=document.querySelector('aside'); let sheetState='default';
function setSheet(st){ sheetState=st; aside.classList.toggle('collapsed',st==='collapsed'); aside.classList.toggle('expanded',st==='expanded'); aside.style.height=''; $('sheetToggle').textContent=st==='expanded'?'⌄':'⌃'; }
$('sheetToggle').onclick=e=>{ e.stopPropagation(); setSheet(sheetState==='expanded'?'default':'expanded'); };
{ const h=$('handle'); let drag=null;
  h.addEventListener('pointerdown',e=>{ if(e.target.id==='sheetToggle') return; drag={y:e.clientY,h:aside.getBoundingClientRect().height,moved:false}; h.setPointerCapture(e.pointerId); });
  h.addEventListener('pointermove',e=>{ if(!drag) return; const dy=drag.y-e.clientY; if(Math.abs(dy)>4) drag.moved=true; if(drag.moved){ aside.classList.remove('collapsed','expanded'); aside.style.height=Math.max(58,Math.min(window.innerHeight*0.9,drag.h+dy))+'px'; } });
  h.addEventListener('pointerup',e=>{ if(!drag) return; const moved=drag.moved; drag=null; if(!moved){ setSheet(sheetState==='collapsed'?'default':'collapsed'); return; }
    const hh=aside.getBoundingClientRect().height, H=window.innerHeight; if(hh<110) setSheet('collapsed'); else if(hh>H*0.7) setSheet('expanded'); else { sheetState='default'; aside.classList.remove('collapsed','expanded'); } }); }
function chooserHide(){ $('chooser').style.display='none'; }
function chooserShow(items,cx,cy){ const el=$('chooser'); el.innerHTML=items.map((n,i)=>`<div data-i="${i}"><span class="sw" style="background:${n.color}"></span><span class="name">${esc(nodeName(n))}</span><span class="cnt">${T('segs',{n:n.segs})}</span></div>`).join('');
  el.style.display='block'; const v=$('viewport'); el.style.left=Math.min(cx,v.clientWidth-180)+v.scrollLeft+'px'; el.style.top=Math.min(cy,v.clientHeight-items.length*38-10)+v.scrollTop+'px';
  el.querySelectorAll('div').forEach(d=>d.onclick=ev=>{ ev.stopPropagation(); chooserHide(); selectNode(items[+d.dataset.i].key); }); }
document.addEventListener('pointerdown',e=>{ if(!e.target.closest('#chooser')) chooserHide(); },true);
window.addEventListener('resize',()=>{ if(window.innerWidth>800){ aside.classList.remove('collapsed','expanded'); aside.style.height=''; } });

// ============================================================ extension: open URL passed as ?file=
const params=new URLSearchParams(location.search); const fileUrl=params.get('file') || (location.hash.length>1 ? location.hash.slice(1) : null); // ?file= from menus, #url from the .pdf redirect rule
const isExt=typeof chrome!=='undefined'&&chrome.runtime&&chrome.runtime.id;
async function loadUrl(url){ $('drop').classList.add('hidden'); $('busy').style.display='block'; $('busy').textContent=T('loading',{url:url.slice(0,80)});
  try{ const r=await fetch(url,{credentials:'include'}); if(!r.ok) throw new Error('HTTP '+r.status); const buf=await r.arrayBuffer();
    document.title=decodeURIComponent(url.split('/').pop().split('?')[0]||'PDF')+' — Net Tracer'; $('busy').textContent=T('parsing'); await loadData(new Uint8Array(buf)); }
  catch(e){ console.error(e); $('busy').style.display='none'; $('drop').classList.remove('hidden'); $('drop').innerHTML=T('loadError',{url:esc(url),err:esc(e.message)}); } }
if(fileUrl){ $('srcbar').style.display='flex'; $('srcurl').textContent=fileUrl; $('srcurl').href=fileUrl; loadUrl(fileUrl);
  $('native').onclick=async()=>{ if(isExt){ await chrome.runtime.sendMessage({type:'openNative',url:fileUrl}); } else location.href=fileUrl; }; }
else $('srcbar').style.display='none';
$('viewport').addEventListener('paste',e=>{ const f=[...(e.clipboardData?.files||[])][0]; if(f) f.arrayBuffer().then(b=>loadData(new Uint8Array(b))); });

// ============================================================ demo schematic (jsPDF, data in lib/demo.js)
$('demo').onclick=()=>{
  const D=window.DEMO, { jsPDF } = window.jspdf; const doc=new jsPDF({unit:'pt',format:'a4',orientation:'landscape'});
  const H=D.H, W=D.W, Y=y=>H-y;
  doc.setDrawColor(0); doc.setLineWidth(0.5); doc.rect(20,Y(H-20),W-40,H-40); doc.rect(W-220,Y(70),200,50); doc.line(W-220,Y(45),W-20,Y(45));
  doc.setFontSize(7); doc.text('TITLE: Demo schematic (generated in browser)',W-215,Y(58)); doc.text('Sheet 1/1   Rev 1.0',W-215,Y(32));
  for(const [name,x,y,w,h,L,R,T,B] of D.comps){ doc.setDrawColor(140,0,0); doc.setLineWidth(0.6); doc.rect(x,Y(y+h),w,h); doc.setTextColor(0); doc.setFontSize(6); doc.text(name,x,Y(y+h+3)); doc.setFontSize(5);
    L.forEach((l,i)=>{ const py=y+h-10-i*10; doc.line(x-10,Y(py),x,Y(py)); doc.text(l,x+2,Y(py-1.5)); });
    R.forEach((l,i)=>{ const py=y+h-10-i*10; doc.line(x+w,Y(py),x+w+10,Y(py)); doc.text(l,x+w-2,Y(py-1.5),{align:'right'}); });
    T.forEach((l,i)=>{ const px=x+10+i*12; doc.line(px,Y(y+h),px,Y(y+h+10)); doc.text(l,px+1.5,Y(y+h-6)); });
    B.forEach((l,i)=>{ const px=x+10+i*12; doc.line(px,Y(y),px,Y(y-10)); doc.text(l,px+1.5,Y(y+2)); }); }
  doc.setDrawColor(0,133,0); doc.setLineWidth(0.7);
  for(const pts of D.wires) for(let i=1;i<pts.length;i++) doc.line(pts[i-1][0],Y(pts[i-1][1]),pts[i][0],Y(pts[i][1]));
  doc.setFillColor(0,133,0); for(const [x,y] of D.dots) doc.circle(x,Y(y),1.6,'F');
  doc.setTextColor(0); doc.setFontSize(6); for(const [t,x,y] of D.labels) doc.text(t,x,Y(y));
  // page 2: a small sheet that shares the VIN / GND / SENSOR_A nets by label
  doc.addPage('a4','landscape'); doc.setDrawColor(0); doc.setLineWidth(0.5); doc.rect(20,Y(H-20),W-40,H-40); doc.setFontSize(7); doc.text('Sheet 2/2   Sensor board',W-215,Y(32));
  const comps2=[['U4  AMS1117-3.3',300,300,100,60,['VIN','GND'],['VOUT']],['J3  SENSOR',520,290,60,70,['VCC','GND','OUT'],[]]];
  for(const [name,x,y,w,h,L,R] of comps2){ doc.setDrawColor(140,0,0); doc.setLineWidth(0.6); doc.rect(x,Y(y+h),w,h); doc.setTextColor(0); doc.setFontSize(6); doc.text(name,x,Y(y+h+3)); doc.setFontSize(5);
    L.forEach((l,i)=>{ const py=y+h-10-i*10; doc.line(x-10,Y(py),x,Y(py)); doc.text(l,x+2,Y(py-1.5)); });
    R.forEach((l,i)=>{ const py=y+h-10-i*10; doc.line(x+w,Y(py),x+w+10,Y(py)); doc.text(l,x+w-2,Y(py-1.5),{align:'right'}); }); }
  doc.setDrawColor(0,133,0); doc.setLineWidth(0.7);
  const w2=[[[290,350],[200,350]],[[290,340],[200,340]],[[410,350],[460,350],[460,350],[460,350],[460,350]],[[410,350],[510,350]],[[510,340],[470,340],[470,250],[200,250]],[[510,330],[600,330],[600,250]]];
  for(const pts of w2) for(let i=1;i<pts.length;i++) if(pts[i-1][0]!==pts[i][0]||pts[i-1][1]!==pts[i][1]) doc.line(pts[i-1][0],Y(pts[i-1][1]),pts[i][0],Y(pts[i][1]));
  doc.setTextColor(0); doc.setFontSize(6); doc.text('VIN',185,Y(352)); doc.text('GND',185,Y(342)); doc.text('GND',185,Y(252)); doc.text('SENSOR_A',600,Y(240));
  doc.setFontSize(5); doc.text('R5',430,Y(360)); doc.text('10k',430,Y(354)); doc.setDrawColor(140,0,0); doc.setLineWidth(1.0); doc.line(425,Y(350),445,Y(350));
  loadData(new Uint8Array(doc.output('arraybuffer')));
};

// ============================================================ 13. PWA: offline cache + Android share target
if(!isExt && 'serviceWorker' in navigator && /^https?:/.test(location.protocol)){ navigator.serviceWorker.register('./sw.js').catch(()=>{}); }
if(!isExt && params.get('shared')){ (async()=>{ try{ const c=await caches.open('nt-shared'); const r=await c.match('shared-pdf'); if(r){ const buf=await r.arrayBuffer(); await c.delete('shared-pdf'); document.title=(r.headers.get('x-name')||'shared.pdf')+' — Net Tracer'; loadData(new Uint8Array(buf)); } }catch(e){ console.error(e); } })(); }
