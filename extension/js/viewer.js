import * as pdfjsLib from '../lib/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = '../lib/pdf.worker.min.mjs';
const OPS = pdfjsLib.OPS;

// ============================================================ state
const S = { doc:null, page:null, pageIndex:1, zoom:1.4, raw:null, model:null, selected:-1, hover:-1, colorsOn:new Set(), widthsOn:new Set(), filter:'' };
window.__S = S;
const $ = id => document.getElementById(id);
const T=(k,p)=>window.i18n.t(k,p);
await window.i18n.load(); window.i18n.apply(); $('lang').value=window.i18n.lang;
$('lang').onchange=async e=>{ await window.i18n.save(e.target.value); window.i18n.apply(); if(S.model) rebuild(); else renderDetail(); };
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
  const attach=(t,ti)=>{ let best=null, bd=opt.labelDist;
    for(const ci of candGrid.query(t.x0-bd,t.y0-bd,t.x1+bd,t.y1+bd)){ const c=cand[ci]; const d=Math.hypot(Math.max(t.x0-c.x,0,c.x-t.x1),Math.max(t.y0-c.y,0,c.y-t.y1));
      if(d<bd-1e-6 || (best&&Math.abs(d-bd)<1e-6&&best.s.isW&&!c.s.isW)){ bd=d; best=c; } }
    if(best&&best.net){ labelOf.set(ti,best); if(best.s.isW) connected[best.s.id*2+best.ei]=1; else if(best.s.cl && best.s.cl.group.nets.size===1 && /[A-Za-zА-Яа-я]/.test(t.str) && t.str.length>=2) best.s.cl.group.hasNetLabel=true; } };
  // pass A: ordinary labels (pin names, numbers, net labels). Power symbols get flagged by their net name.
  raw.texts.forEach((t,ti)=>{ if(nameIdx.has(ti)||refdesRe.test(t.str)) return; attach(t,ti); });
  // reference designators for symbols without a body rectangle (R1, C1, Q1...): nearest refdes-looking text, global greedy by distance
  const hosts=[...groups.values()].filter(g=>g.segs.length>=2 && !(g.nets.size===1&&g.hasNetLabel) && g.b.x1-g.b.x0<=120 && g.b.y1-g.b.y0<=120).map(g=>({cl:g,b:g.b}));
  const pairs=[];
  raw.texts.forEach((t,ti)=>{ if(nameIdx.has(ti)||!refdesRe.test(t.str)||inComp(t)) return;
    for(const h of hosts){ let d=Math.hypot(Math.max(h.b.x0-t.x1,0,t.x0-h.b.x1),Math.max(h.b.y0-t.y1,0,t.y0-h.b.y1)); if(d===0) d=8; /* overlapping a symbol's box: probably the neighbour's refdes */ if(d<=12) pairs.push({d,ti,h}); } });
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
  return {nets, comps, hit, hitItems, wires:segs.filter(s=>s.isW).length, graphics:segs.filter(s=>!s.isW).length, unconnectedClusters};
}

// ============================================================ 3. render
async function renderPage(){
  const dpr=window.devicePixelRatio||1, vp=S.page.getViewport({scale:S.zoom*dpr});
  pdfCanvas.width=vp.width; pdfCanvas.height=vp.height; pdfCanvas.style.width=(vp.width/dpr)+'px'; pdfCanvas.style.height=(vp.height/dpr)+'px';
  ov.width=vp.width; ov.height=vp.height; ov.style.width=pdfCanvas.style.width; ov.style.height=pdfCanvas.style.height;
  $('zoomVal').textContent=Math.round(S.zoom*100)+'%';
  await S.page.render({canvasContext:pdfCanvas.getContext('2d'), viewport:vp}).promise;
  drawOverlay();
}
function drawOverlay(){
  const dpr=window.devicePixelRatio||1, k=S.zoom*dpr, z=S.zoom;
  octx.setTransform(1,0,0,1,0,0); octx.clearRect(0,0,ov.width,ov.height); octx.setTransform(k,0,0,k,0,0); octx.lineCap='round'; octx.lineJoin='round';
  if(!S.model) return;
  const strokeSegs=(list,w)=>{ octx.lineWidth=w/z; octx.beginPath(); for(const s of list){ octx.moveTo(s.x1,s.y1); octx.lineTo(s.x2,s.y2); } octx.stroke(); };
  if($('showAll').checked){ octx.globalAlpha=0.55; for(const n of S.model.nets){ if(n.index===S.selected) continue; octx.strokeStyle=n.color; strokeSegs(n.segs,2.2); } octx.globalAlpha=1; }
  const drawNet=(n,color,w,glow)=>{
    if(glow){ octx.strokeStyle=color; octx.globalAlpha=0.35; strokeSegs(n.segs,w+8); octx.globalAlpha=1; }
    octx.strokeStyle=color; strokeSegs(n.segs,w); octx.globalAlpha=0.8; strokeSegs(n.pins,w*0.6); octx.globalAlpha=1;
    octx.fillStyle=color; for(const d of n.dots){ octx.beginPath(); octx.arc(d.x,d.y,d.r+1.5/z,0,7); octx.fill(); }
    octx.strokeStyle=color; octx.lineWidth=1/z; for(const l of n.labels){ const t=l.text; octx.strokeRect(t.x0-1.5,t.y0-1.5,t.x1-t.x0+3,t.y1-t.y0+3); }
  };
  const drawDangling=(n)=>{ octx.strokeStyle='#ff8c42'; octx.lineWidth=1.5/z; for(const [x,y] of n.dangling){ octx.beginPath(); octx.arc(x,y,4/z,0,7); octx.stroke(); } };
  if($('showDangling').checked) for(const n of S.model.nets) drawDangling(n);
  if(S.hover>=0 && S.hover!==S.selected) drawNet(S.model.nets[S.hover],'#4cc9ff',3,false);
  if(S.selected>=0){ drawNet(S.model.nets[S.selected],'#ff3d71',3.5,true); drawDangling(S.model.nets[S.selected]); }
}

// ============================================================ 4. UI
function hitNet(cssX,cssY){ if(!S.model) return -1; const x=cssX/S.zoom, y=cssY/S.zoom, thr=6/S.zoom; let best=-1,bd=thr;
  for(const i of S.model.hit.query(x-thr,y-thr,x+thr,y+thr)){ const [s,n]=S.model.hitItems[i]; const {d}=segPointDist(s,x,y); if(d<bd){ bd=d; best=n.index; } } return best; }
ov.addEventListener('mousemove',e=>{ const r=ov.getBoundingClientRect(); const h=hitNet(e.clientX-r.left,e.clientY-r.top); if(h!==S.hover){ S.hover=h; drawOverlay(); }
  const tip=$('tip'); if(h>=0){ const n=S.model.nets[h]; tip.textContent=T('tip',{name:n.name||T('netN',{n:h+1}),segs:n.segs.length,labels:n.labels.length}); tip.style.display='block'; tip.style.left=(e.clientX+14)+'px'; tip.style.top=(e.clientY+14)+'px'; } else tip.style.display='none'; });
ov.addEventListener('mouseleave',()=>{ S.hover=-1; $('tip').style.display='none'; drawOverlay(); });
ov.addEventListener('click',e=>{ const r=ov.getBoundingClientRect(); select(hitNet(e.clientX-r.left,e.clientY-r.top)); });
document.addEventListener('keydown',e=>{ if(e.key==='Escape') select(-1); });
$('viewport').addEventListener('wheel',e=>{ if(!e.ctrlKey||!S.page) return; e.preventDefault(); setZoom(S.zoom*(e.deltaY<0?1.15:1/1.15)); },{passive:false});
async function setZoom(z){ S.zoom=Math.max(0.2,Math.min(8,z)); if(S.page) await renderPage(); }
$('zoomIn').onclick=()=>setZoom(S.zoom*1.25); $('zoomOut').onclick=()=>setZoom(S.zoom/1.25);
$('zoomFit').onclick=()=>{ if(S.raw) setZoom(($('viewport').clientWidth-40)/S.raw.base.width); };

function select(i,scroll){ S.selected=i; drawOverlay(); renderList(); renderDetail();
  if(scroll && i>=0){ const b=S.model.nets[i].bbox, vp=$('viewport'); const cx=(b.x0+b.x1)/2*S.zoom+16, cy=(b.y0+b.y1)/2*S.zoom+16;
    if(cx<vp.scrollLeft||cx>vp.scrollLeft+vp.clientWidth||cy<vp.scrollTop||cy>vp.scrollTop+vp.clientHeight) vp.scrollTo({left:cx-vp.clientWidth/2, top:cy-vp.clientHeight/2, behavior:'smooth'}); } }
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function renderDetail(){ const d=$('detail'); if(S.selected<0){ d.className='hint'; d.textContent=T('detailHint'); return; }
  d.className=''; const n=S.model.nets[S.selected];
  const pins=n.labels.map(l=>(l.comp?`<code>${esc(l.comp)}</code> → `:'')+`<b>${esc(l.text.str)}</b>`+(l.isNetLabel&&!l.comp?' <span class="hint">'+T('labelTag')+'</span>':''));
  d.innerHTML=`<div><b>${esc(n.name||T('netN',{n:S.selected+1}))}</b></div><div class="hint">${T('detailLine',{segs:n.segs.length,pins:n.pins.length,dots:n.dots.length,len:n.len.toFixed(0)})}${n.parts>1?T('mergedParts',{n:n.parts}):''}</div>`
    +(pins.length?`<ul>${pins.map(p=>'<li>'+p+'</li>').join('')}</ul>`:'<div class="hint">'+T('noLabels')+'</div>')
    +(n.dangling.length?`<div class="warnbox">${T('danglingWarn',{n:n.dangling.length})}</div>`:''); }
function renderList(){ const el=$('netlist'); if(!S.model){ el.innerHTML=''; return; } const f=S.filter.toLowerCase();
  const list=S.model.nets.filter(n=>!f || n.name.toLowerCase().includes(f) || n.labels.some(l=>l.text.str.toLowerCase().includes(f)||l.comp.toLowerCase().includes(f)));
  el.innerHTML=list.map(n=>`<div class="net${n.index===S.selected?' sel':''}" data-i="${n.index}"><span class="n">#${n.index+1}</span><span class="sw" style="background:${n.color}"></span><span class="name">${esc(n.name)||'<span class="hint">'+T('noLabel')+'</span>'}</span>${n.dangling.length?`<span class="warn">⚠${n.dangling.length}</span>`:''}<span class="cnt">${T('segs',{n:n.segs.length})}${n.labels.length?' · '+T('pins',{n:n.labels.length}):''}</span></div>`).join('')
    +(list.length?'' :'<div class="hint" style="padding:8px 12px">'+T('nothingFound')+'</div>');
  el.querySelectorAll('.net').forEach(x=>x.onclick=()=>select(+x.dataset.i,true));
  const s=el.querySelector('.net.sel'); if(s) s.scrollIntoView({block:'nearest'}); }
$('search').oninput=e=>{ S.filter=e.target.value.trim(); renderList(); };
$('search').onkeydown=e=>{ if(e.key==='Enter'){ const first=$('netlist').querySelector('.net'); if(first) select(+first.dataset.i,true); } };

function renderFilters(){
  const cc=new Map(), wc=new Map();
  for(const s of S.raw.segments){ const L=dist(s.x1,s.y1,s.x2,s.y2); cc.set(s.color,(cc.get(s.color)||0)+1); const k=wkey(s.lw); wc.set(k,(wc.get(k)||0)+L); }
  const mk=(el,entries,set,fmt)=>{ el.innerHTML=entries.map(([k,v])=>`<label><input type="checkbox" data-k="${k}" ${set.has(k)?'checked':''}>${fmt(k,v)}</label>`).join('');
    el.querySelectorAll('input').forEach(i=>i.onchange=()=>{ if(i.checked) set.add(i.dataset.k); else set.delete(i.dataset.k); rebuild(); }); };
  mk($('colors'),[...cc.entries()].sort((a,b)=>b[1]-a[1]),S.colorsOn,(k,v)=>`<span class="sw" style="background:${k}"></span>${k} <span class="hint">(${v})</span>`);
  mk($('widths'),[...wc.entries()].sort((a,b)=>b[1]-a[1]),S.widthsOn,(k,v)=>`${k} <span class="hint">(${(v/1000).toFixed(1)}k pt)</span>`);
}
function defaultFilters(){ // colours: all; widths: the class with the most total length, plus classes with >= 25% of it
  S.colorsOn=new Set(S.raw.segments.map(s=>s.color));
  const wc=new Map(); for(const s of S.raw.segments){ if(s.closed||s.curve) continue; const k=wkey(s.lw); wc.set(k,(wc.get(k)||0)+dist(s.x1,s.y1,s.x2,s.y2)); }
  const max=Math.max(0,...wc.values()); S.widthsOn=new Set([...wc.entries()].filter(([k,v])=>v>=0.25*max).map(([k])=>k)); }

function rebuild(){ if(!S.raw) return;
  S.model=buildNets(S.raw,{colors:S.colorsOn, widths:S.widthsOn, tol:+$('tol').value||1, labelDist:+$('labelDist').value||8, needDot:$('needDot').checked, mergeLabels:$('mergeLabels').checked, insideRect:$('insideRect').checked});
  S.selected=-1; S.hover=-1; const m=S.model, r=S.raw;
  $('stats').innerHTML=T('stats',{segs:r.segments.length,wires:m.wires,graphics:m.graphics,dots:r.dots.length,texts:r.texts.length,nets:m.nets.length,labelled:m.nets.filter(n=>n.labels.length).length,comps:m.comps.length,dangling:m.nets.reduce((a,n)=>a+n.dangling.length,0)});
  const w=[]; if(!r.texts.length) w.push(T('warnNoText')); if(!r.segments.length) w.push(T('warnNoLines')); if(m.unconnectedClusters>5) w.push(T('warnUnconnected',{n:m.unconnectedClusters}));
  $('warnings').innerHTML=w.map(x=>`<div class="warnbox">⚠ ${x}</div>`).join('');
  renderList(); renderDetail(); drawOverlay(); }

async function loadPage(num){ $('busy').style.display='block';
  try{ S.pageIndex=num; S.page=await S.doc.getPage(num); S.raw=await extractPage(S.page); defaultFilters(); renderFilters();
    S.zoom=Math.max(0.3,Math.min(3,($('viewport').clientWidth-40)/S.raw.base.width)); await renderPage(); rebuild(); }
  catch(e){ console.error(e); $('stats').textContent=T('errorPrefix')+e.message; }
  $('busy').style.display='none'; }
async function loadData(data){ $('drop').classList.add('hidden'); $('busy').style.display='block';
  try{ S.doc=await pdfjsLib.getDocument({data}).promise; $('pageCount').textContent=S.doc.numPages; $('pageNum').value=1; $('pageNum').max=S.doc.numPages; await loadPage(1); }
  catch(e){ console.error(e); $('stats').textContent=T('openError')+e.message; $('busy').style.display='none'; } }
$('file').onchange=async e=>{ const f=e.target.files[0]; if(f) loadData(new Uint8Array(await f.arrayBuffer())); };
$('viewport').addEventListener('dragover',e=>e.preventDefault());
$('viewport').addEventListener('drop',async e=>{ e.preventDefault(); const f=e.dataTransfer.files[0]; if(f) loadData(new Uint8Array(await f.arrayBuffer())); });
$('pageNum').onchange=()=>{ const n=Math.max(1,Math.min(S.doc?S.doc.numPages:1,+$('pageNum').value||1)); $('pageNum').value=n; if(S.doc) loadPage(n); };
['needDot','mergeLabels','insideRect'].forEach(id=>$(id).onchange=rebuild); ['tol','labelDist'].forEach(id=>$(id).onchange=rebuild);
$('showAll').onchange=drawOverlay; $('showDangling').onchange=drawOverlay;
$('copy').onclick=async()=>{ if(!S.model) return;
  const txt=S.model.nets.map(n=>`${n.name||('NET'+(n.index+1))}\t${n.segs.length} seg\t${n.labels.map(l=>(l.comp?l.comp+'.':'')+l.text.str).join(', ')}${n.dangling.length?'\tDANGLING:'+n.dangling.length:''}`).join('\n');
  try{ await navigator.clipboard.writeText(txt); $('copy').textContent=T('copied'); setTimeout(()=>$('copy').textContent=T('copy'),1500); }catch{ $('copy').textContent=T('clipboardNA'); } };

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
  loadData(new Uint8Array(doc.output('arraybuffer')));
};
