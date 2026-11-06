// Schematic Net Tracer — extraction: turns a pdf.js page (operator list + text layer) into plain geometry.
// Pure module: no DOM, no global state. Imported by the UI, the analysis worker and the Node tests.
import { mul, ap, dist, rgb, bboxOf } from './geom.js';

// Returns {segments, dots, rects, texts, base}. Everything is plain data (structured-clone safe).
export async function extractPage(page, OPS){
  const ol = await page.getOperatorList();
  const vp = page.getViewport({scale:1});
  const V = vp.transform;
  const base = {width:vp.width, height:vp.height, transform:[...vp.transform]}; // plain object: survives postMessage
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
  function emitStroke(forceClosed){ if(!pending) return; const w=devLw(); if(forceClosed) for(const sp of pending) sp.closed=true;
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
      case OPS.stroke: emitStroke(false); pending=null; break;
      case OPS.closeStroke: emitStroke(true); pending=null; break;
      case OPS.fill: case OPS.eoFill: emitFill(); pending=null; break;
      case OPS.fillStroke: case OPS.eoFillStroke: emitFill(); emitStroke(false); pending=null; break;
      case OPS.closeFillStroke: case OPS.closeEOFillStroke: emitFill(); emitStroke(true); pending=null; break;
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
  // Stroked glyphs: KiCad (and other plotters) draw text as short pen strokes and lay an invisible text layer
  // on top for search. A short segment that lies entirely inside a text item's box is a letter, not a wire.
  const glyphGrid=new Map(), GC=16, gk=(x,y)=>Math.floor(x/GC)+','+Math.floor(y/GC);
  for(const t of texts){ for(let gx=Math.floor(t.x0/GC);gx<=Math.floor(t.x1/GC);gx++) for(let gy=Math.floor(t.y0/GC);gy<=Math.floor(t.y1/GC);gy++){ const k=gx+','+gy; let a=glyphGrid.get(k); if(!a) glyphGrid.set(k,a=[]); a.push(t); } }
  const isGlyph=s=>{ const len=dist(s.x1,s.y1,s.x2,s.y2); for(const t of glyphGrid.get(gk((s.x1+s.x2)/2,(s.y1+s.y2)/2))||[]){ const h=Math.min(t.x1-t.x0,t.y1-t.y0), m=Math.max(0.6,h*0.12);
      if(len<=h*1.6 && Math.min(s.x1,s.x2)>=t.x0-m && Math.max(s.x1,s.x2)<=t.x1+m && Math.min(s.y1,s.y2)>=t.y0-m && Math.max(s.y1,s.y2)<=t.y1+m) return true; } return false; };
  const kept=[]; let glyphs=0; for(const s of uniq){ if(isGlyph(s)){ glyphs++; continue; } s.id=kept.length; kept.push(s); }
  return {segments:kept,dots,rects,texts:merged,base,glyphs};
}


// Altium "Smart PDF" puts the netlist into the bookmarks: NETNAME -> [REF-PIN, ...]
export async function readOutline(doc){ try{ const ol=await doc.getOutline(); if(!ol) return null; const nets=new Map();
    const walk=(items)=>{ for(const it of items||[]){ const kids=it.items||[]; const pinLike=kids.filter(k=>/^[A-Z]{1,3}\d{1,4}[A-Z]?[-.]\S+$/.test((k.title||'').trim()));
        if(kids.length&&pinLike.length>=Math.max(1,kids.length*0.6)) nets.set(it.title.trim(),[...new Set(pinLike.map(k=>k.title.trim()))]); else walk(kids); } };
    walk(ol); return nets.size?[...nets.entries()]:null; }catch{ return null; } }
