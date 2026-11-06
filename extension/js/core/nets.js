// Schematic Net Tracer — connectivity: builds the nets of one page from its extracted geometry.
// Pure module: no DOM, no global state. Imported by the UI, the analysis worker and the Node tests.
import { dist, segPointDist, wkey, bboxOf, Grid } from './geom.js';

// opt: {colors:Set, widths:Set, tol, labelDist, needDot, mergeLabels, insideRect}
export function buildNets(raw, opt){
  const tol=opt.tol, segs=raw.segments;
  const pageArea=raw.base.width*raw.base.height;
  // components: rectangles of sensible size. Rectangles that touch (sections of one symbol) share a group and a name.
  // Eagle (and some others) draw a symbol body as four separate lines: find axis-aligned 4-line rectangles among non-wire lines
  const lineRects=[]; { const E=0.6, H=new Map(), V=new Map(), k=(x,y)=>Math.round(x/E)+','+Math.round(y/E);
    const hs=[], vs=[];
    for(const s of segs){ if(opt.colors.has(s.color)&&opt.widths.has(wkey(s.lw))) continue; if(s.closed||s.curve) continue;
      if(Math.abs(s.y1-s.y2)<0.05&&Math.abs(s.x1-s.x2)>14){ const a=s.x1<s.x2?[s.x1,s.x2]:[s.x2,s.x1]; hs.push({x0:a[0],x1:a[1],y:s.y1,color:s.color}); }
      else if(Math.abs(s.x1-s.x2)<0.05&&Math.abs(s.y1-s.y2)>14){ const a=s.y1<s.y2?[s.y1,s.y2]:[s.y2,s.y1]; vs.push({y0:a[0],y1:a[1],x:s.x1,color:s.color}); } }
    for(const v of vs){ const key=k(v.x,v.y0); (V.get(key)||V.set(key,[]).get(key)).push(v); }
    for(const h of hs){ const key=k(h.x0,h.y); (H.get(key)||H.set(key,[]).get(key)).push(h); }
    for(const top of hs){ for(const left of V.get(k(top.x0,top.y))||[]){ if(left.color!==top.color) continue;
        const right=(V.get(k(top.x1,top.y))||[]).find(v=>v.color===top.color&&Math.abs(v.y1-left.y1)<E);
        const bottom=right&&(H.get(k(top.x0,left.y1))||[]).find(h=>h.color===top.color&&Math.abs(h.x1-top.x1)<E);
        if(bottom) lineRects.push({x0:top.x0,y0:top.y,x1:top.x1,y1:left.y1,color:top.color}); } } }
  // a body never has wires inside it; a rectangle that does is a frame / section box (EasyEDA, title blocks)
  const wireClass=s=>opt.colors.has(s.color)&&opt.widths.has(wkey(s.lw))&&!s.closed&&!s.curve;
  const wiresInside=r=>{ let n=0; for(const s of segs){ if(!wireClass(s)) continue; if(Math.min(s.x1,s.x2)>r.x0+0.5&&Math.max(s.x1,s.x2)<r.x1-0.5&&Math.min(s.y1,s.y2)>r.y0+0.5&&Math.max(s.y1,s.y2)<r.y1-0.5&&++n>1) return n; } return n; };
  const bigRects=[...raw.rects,...lineRects].filter(r=>r.x1-r.x0>14 && r.y1-r.y0>14 && (r.x1-r.x0)*(r.y1-r.y0)<0.5*pageArea && wiresInside(r)<2);
  const nameIdx=new Set();
  const comps=bigRects.map(r=>({...r,name:''}));
  { const par=comps.map((_,i)=>i), f=i=>{ while(par[i]!==i){ par[i]=par[par[i]]; i=par[i]; } return i; };
    for(let i=0;i<comps.length;i++) for(let j=i+1;j<comps.length;j++){ const a=comps[i], b=comps[j];
      const gx=Math.max(a.x0-b.x1,0,b.x0-a.x1), gy=Math.max(a.y0-b.y1,0,b.y0-a.y1);
      const nested=(a.x0>=b.x0-1&&a.x1<=b.x1+1&&a.y0>=b.y0-1&&a.y1<=b.y1+1)||(b.x0>=a.x0-1&&b.x1<=a.x1+1&&b.y0>=a.y0-1&&b.y1<=a.y1+1);
      if((gx<=1&&gy<=1)||nested){ par[f(i)]=f(j); } }
    const sym=new Map(); comps.forEach((c,i)=>{ const r=f(i); if(!sym.has(r)) sym.set(r,{rects:[],name:''}); sym.get(r).rects.push(c); c.sym=sym.get(r); });
    for(const g of sym.values()) g.b=bboxOf(g.rects.flatMap(r=>[[r.x0,r.y0],[r.x1,r.y1]]));
    comps.symbols=[...sym.values()]; }
  const strictlyInside=(x,y)=>comps.some(c=>x>c.x0+0.5&&x<c.x1-0.5&&y>c.y0+0.5&&y<c.y1-0.5);
  // smallest body rectangle containing the text centre
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
  // needDot 'auto': CAD tools draw a dot on every real T-junction, so on a page that has junction dots a T without one is not a connection
  const needDot=opt.needDot==='auto'?raw.dots.length>=3:!!opt.needDot;
  segs.forEach((s,i)=>{
    [[s.x1,s.y1],[s.x2,s.y2]].forEach(([px,py],ei)=>{
      for(const j of grid.query(px-tol,py-tol,px+tol,py+tol)){ if(j===i) continue; const o=segs[j];
        if(dist(px,py,o.x1,o.y1)<=tol||dist(px,py,o.x2,o.y2)<=tol){ join(i,j,ei); continue; }
        const {d,t}=segPointDist(o,px,py);
        if(d<=tol && t>0 && t<1){ if(!needDot || !(s.isW&&o.isW) || dotNear(px,py)) join(i,j,ei); } }
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
  // label candidates: every line. Wires -> their net; graphics -> the net they hang on (pins of exactly one net,
  // or small clusters hanging on one net: power symbols, flags); pin-like lines with a free end are sinks that keep their own label unassigned.
  const cand=[]; const candGrid=new Grid(12);
  const addSeg=(s,net)=>{ candGrid.add(cand.length,Math.min(s.x1,s.x2),Math.min(s.y1,s.y2),Math.max(s.x1,s.x2),Math.max(s.y1,s.y2)); cand.push({s,net}); };
  for(const s of segs){ let net=null;
    if(s.isW) net=s.net; else if(s.pinNets&&s.pinNets.size===1) net=[...s.pinNets][0]; else if(!s.pinNets&&s.cl.nets.size===1&&s.cl.segs.length<=24) net=[...s.cl.nets][0];
    if(net) addSeg(s,net); else if(!connected[s.id*2]||!connected[s.id*2+1]) addSeg(s,null);
  }
  // distance from a text box to a segment, and the parameter t of the closest point on the segment
  const rectSeg=(r,s)=>{ // Liang–Barsky: does the segment enter the box?
    let t0=0,t1=1; const dx=s.x2-s.x1, dy=s.y2-s.y1; let inside=true;
    for(const [p,q] of [[-dx,s.x1-r.x0],[dx,r.x1-s.x1],[-dy,s.y1-r.y0],[dy,r.y1-s.y1]]){ if(p===0){ if(q<0){ inside=false; break; } } else { const u=q/p; if(p<0){ if(u>t1){ inside=false; break; } if(u>t0) t0=u; } else { if(u<t0){ inside=false; break; } if(u<t1) t1=u; } } }
    if(inside) return {d:0,t:(t0+t1)/2};
    let best={d:Infinity,t:0};
    for(const [x,y] of [[r.x0,r.y0],[r.x1,r.y0],[r.x0,r.y1],[r.x1,r.y1]]){ const q=segPointDist(s,x,y); if(q.d<best.d) best=q; }
    for(const [x,y,t] of [[s.x1,s.y1,0],[s.x2,s.y2,1]]){ const d=Math.hypot(Math.max(r.x0-x,0,x-r.x1),Math.max(r.y0-y,0,y-r.y1)); if(d<best.d) best={d,t}; }
    return best; };
  const labelOf=new Map();
  const VALUE_RE=/^\d+(\.\d+)?\s*[kKmMuUnNpPrRµΩ]\w*([/.-]\w+)*$|^\d+(\.\d+)?\s*(Ω|ohm|[uµn]?F|[um]?H|W|A)\b/;
  const PINNUM_RE=/^([A-Z]{0,2}\d{1,3}|\d{1,3}[A-Z]?)$/; // 15, A12, 3B: pin numbers sit on the pin line, not on the wire beyond it
  const attach=(t,ti,onWireOnly)=>{ if(VALUE_RE.test(t.str)) return; const horiz=(t.x1-t.x0)>=(t.y1-t.y0); const body=inComp(t); const pinNum=PINNUM_RE.test(t.str);
    let best=null, bd=opt.labelDist, bt=0; const L=opt.labelDist;
    for(const ci of candGrid.query(t.x0-L,t.y0-L,t.x1+L,t.y1+L)){ const c=cand[ci];
      // a text inside a body labels one of that body's pins: only the inner end counts
      let q; if(body){ const e=[[c.s.x1,c.s.y1,0],[c.s.x2,c.s.y2,1]].map(([x,y,tt])=>({d:Math.hypot(Math.max(t.x0-x,0,x-t.x1),Math.max(t.y0-y,0,y-t.y1)),t:tt})); q=e[0].d<=e[1].d?e[0]:e[1]; }
      else q=rectSeg(t,c.s);
      let d=q.d;
      if(!body){ // a label sits on (above / beside) a parallel wire; a perpendicular wire or one cutting through the letters is someone else's
        const ax=Math.abs(c.s.x2-c.s.x1), ay=Math.abs(c.s.y2-c.s.y1), sh=ay<0.3*ax?true:ax<0.3*ay?false:null /* diagonal: no orientation */, px=c.s.x1+(c.s.x2-c.s.x1)*q.t, py=c.s.y1+(c.s.y2-c.s.y1)*q.t;
        if(horiz){ const h=t.y1-t.y0; if(c.s.isW&&py<t.y0-0.5) d+=2.5; /* symbol names (GND under a triangle) may sit below */ if(sh!==null&&sh!==horiz) d+=q.d<0.3?6:4; else if(sh===horiz&&py>t.y0+0.3*h&&py<t.y1-0.3*h) d+=4; }
        else { const w=t.x1-t.x0; if(sh!==null&&sh!==horiz) d+=q.d<0.3?6:4; else if(sh===horiz&&px>t.x0+0.3*w&&px<t.x1-0.3*w) d+=4; } }
      if(pinNum && c.s.isW) d+=3; // prefer the pin line itself
      if(d<bd-1e-6 || (best&&Math.abs(d-bd)<1e-6&&best.s.isW&&!c.s.isW)){ bd=d; best=c; bt=q.t; } }
    if(onWireOnly&&!(best&&best.s.isW&&bd<=1.5)) return;
    if(best&&best.net){ labelOf.set(ti,{...best,d:bd});
      if(best.s.isW){ const s=best.s, near=(x,y)=>Math.hypot(Math.max(t.x0-x,0,x-t.x1),Math.max(t.y0-y,0,y-t.y1))<=opt.labelDist*0.75; // a label at a wire end terminates it
        if(near(s.x1,s.y1)) connected[s.id*2]=1; if(near(s.x2,s.y2)) connected[s.id*2+1]=1; }
      else if(best.s.cl && best.s.cl.group.nets.size===1 && /[A-Za-zА-Яа-я]/.test(t.str) && t.str.length>=2) best.s.cl.group.hasNetLabel=true; } };
  const refdesOf=str=>{ const tok=str.trim().split(/\s+/); return refdesRe.test(tok[0])&&(tok.length===1||tok.length<=4)?tok[0]:null; };
  // pass A: ordinary labels (pin names, numbers, net labels). Power symbols get flagged by their net name.
  raw.texts.forEach((t,ti)=>{ if(refdesOf(t.str)&&!inComp(t)) return; attach(t,ti); });
  // reference designators: nearest refdes-looking text outside bodies, global greedy by distance.
  // Hosts are body symbols (touching rectangles) and graphics groups without a body (R, C, Q drawn from lines).
  const hosts=[...groups.values()].filter(g=>g.segs.length>=1 && !(g.nets.size===1&&g.hasNetLabel) && g.b.x1-g.b.x0<=120 && g.b.y1-g.b.y0<=120).map(g=>({cl:g,b:g.b,body:false}));
  for(const sy of comps.symbols) hosts.push({cl:sy,b:sy.b,body:true});
  const pairs=[];
  raw.texts.forEach((t,ti)=>{ const ref=refdesOf(t.str); if(!ref||inComp(t)) return;
    for(const h of hosts){ let d=Math.hypot(Math.max(h.b.x0-t.x1,0,t.x0-h.b.x1),Math.max(h.b.y0-t.y1,0,t.y0-h.b.y1));
      const lim=h.body?Math.max(14,0.2*Math.min(h.b.x1-h.b.x0,h.b.y1-h.b.y0)):(h.cl.segs.length>=2?12:6);
      if(!h.body && d===0) d=8; /* overlapping a body-less symbol's box: probably the neighbour's refdes */
      if(d<=lim) pairs.push({d:h.body?d*0.8:d,ti,h}); } });
  pairs.sort((a,b)=>a.d-b.d); const usedT=new Set();
  for(const {ti,h} of pairs){ if(usedT.has(ti)||h.cl.refdes) continue; h.cl.refdes=raw.texts[ti].str; usedT.add(ti); nameIdx.add(ti); }
  for(const c of comps) c.name=c.sym.refdes||'';
  // pass B: refdes-looking texts that are not refdes (net labels like D5)
  // pass B: refdes-looking texts that found no symbol are net labels (D5, A3) only when they sit right on a wire
  raw.texts.forEach((t,ti)=>{ if(nameIdx.has(ti)||labelOf.has(ti)||!refdesOf(t.str)||inComp(t)) return; attach(t,ti,true); });
  for(const [ti,c] of labelOf){ const t=raw.texts[ti]; const comp=inComp(t); const compName=comp?comp.name:(c.s.isW?'':compOfSeg(c.s)); c.net.labels.push({text:t, comp:compName, isNetLabel:!compName, d:c.d}); }
  // merge nets by identical net labels (labels outside component bodies only)
  // the label a net is merged by: its most reliable net label, unless another name is (almost) as reliable — then it is ambiguous
  const bestLabel=n=>{ let b=null,c=null; for(const l of n.labels){ if(!l.isNetLabel) continue; const nm=l.text.str; if(!/[A-Za-zА-Яа-я]/.test(nm)||nm.length<2) continue;
      if(!b||l.d<b.d){ if(b&&b.text.str!==nm) c=b; b=l; } else if(nm!==b.text.str&&(!c||l.d<c.d)) c=l; }
    return b&&c&&c.d-b.d<1?null:b; };
  let nets=[...netMap.values()];
  if(opt.mergeLabels){ const idx=new Map(nets.map((n,i)=>[n,i])); const p2=nets.map((_,i)=>i); const f2=i=>{ while(p2[i]!==i){ p2[i]=p2[p2[i]]; i=p2[i]; } return i; };
    const byName=new Map();
    // each net joins the name-merge with its single most reliable label, so one misplaced text cannot glue two big nets
    for(const n of nets){ const lb=bestLabel(n);
      if(!lb) continue; const nm=lb.text.str; if(byName.has(nm)){ const a=f2(byName.get(nm)), b=f2(idx.get(n)); if(a!==b) p2[a]=b; } else byName.set(nm,idx.get(n)); }
    const groups=new Map(); nets.forEach((n,i)=>{ const r=f2(i); if(!groups.has(r)) groups.set(r,{segs:[],pins:[],labels:[],dots:[],dangling:[],parts:0}); const g=groups.get(r); g.segs.push(...n.segs); g.pins.push(...n.pins); g.labels.push(...n.labels); g.parts++; n.merged=g; });
    nets=[...groups.values()]; for(const s of segs) if(s.net) s.net=s.net.merged||s.net; }
  // dots and dangling ends per net
  for(const net of nets){ net.set=new Set(net.segs); }
  for(const d of raw.dots){ const i=[...grid.query(d.x-d.r-tol,d.y-d.r-tol,d.x+d.r+tol,d.y+d.r+tol)].find(i=>segs[i].isW && segPointDist(segs[i],d.x,d.y).d<=tol+d.r); if(i!==undefined) segs[i].net.dots.push(d); }
  for(const s of segs){ if(!s.isW) continue; if(!connected[s.id*2]) s.net.dangling.push([s.x1,s.y1]); if(!connected[s.id*2+1]) s.net.dangling.push([s.x2,s.y2]); }
  for(const net of nets){
    // the name this net is merged by (on this page and across pages): its most reliable net label
    const mb=bestLabel(net); net.mergeName=mb?mb.text.str:null;
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



