import * as pdfjsLib from '../lib/pdf.min.mjs';
import { dist, segPointDist, wkey } from './core/geom.js';
import { extractPage, readOutline } from './core/extract.js';
import { buildNets } from './core/nets.js';
import { buildNodes, buildParts } from './core/model.js';
import { search } from './core/search.js';
import { nodesCsv, partsCsv, netlistText } from './core/export.js';
import { defaultFilters, DEFAULT_OPTIONS } from './core/pipeline.js';
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
function runSearch(jump){ const q=S.query.toLowerCase(); S.resIdx=-1; S.results=search(q,S.pages,S.nodes,S.parts);
  const exact=S.results.filter(r=>r.exact).length; $('searchInfo').textContent=q?T('searchInfo',{n:S.results.length,e:exact}):''; $('resCount').textContent=S.results.length||'';
  renderResults(); if(q&&S.results.length&&S.tab!=='results'&&S.tab!=='nets'&&S.tab!=='parts') setTab('results');
  if(jump&&q.length>=2&&S.results.length) gotoResult(0); else drawOverlay(); }
function gotoResult(i){ if(!S.results.length) return; S.resIdx=(i+S.results.length)%S.results.length; const r=S.results[S.resIdx]; renderResults(); scrollTo(r.page,r.bbox); }
function renderResults(){ const el=$('reslist'); const kindLbl={net:T('kindNet'),part:T('kindPart'),pin:T('kindPin'),text:T('kindText')};
  el.innerHTML=S.results.slice(0,400).map((r,i)=>`<div class="res${i===S.resIdx?' sel':''}" data-i="${i}"><span class="badge ${r.kind==='net'?'sig':r.kind==='part'?'pwr':''}" style="${r.kind==='pin'||r.kind==='text'?'background:#2b313b;color:var(--muted)':''}">${kindLbl[r.kind]}</span><span class="name">${esc(r.label)}${r.exact?' <span class="cnt">=</span>':''}</span><span class="cnt">${r.node?esc(nodeName(r.node)):r.comp?esc(r.comp):''}${S.doc&&S.doc.numPages>1?' p'+r.page:''}</span></div>`).join('')+(S.results.length?'':'<div class="hint" style="padding:8px 12px">'+(S.query?T('nothingFound'):T('resultsHint'))+'</div>');
  el.querySelectorAll('.res').forEach(x=>x.onclick=()=>{ const r=S.results[+x.dataset.i]; S.resIdx=+x.dataset.i; if(r.node) { S.selKey=r.node.key; S.selPart=null; } else if(r.part){ S.selPart=r.part; S.selKey=null; } renderPageDots(); renderLists(); renderDetail(); scrollTo(r.page,r.bbox); }); }

// ============================================================ 9. export
async function deliver(name,text){ try{ const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob(['﻿'+text],{type:'text/csv;charset=utf-8'})); a.download=name; document.body.appendChild(a); a.click(); a.remove(); }catch{}
  try{ await navigator.clipboard.writeText(text); }catch{} }
$('menuBtn').onclick=e=>{ e.stopPropagation(); $('menu').style.display=$('menu').style.display==='block'?'none':'block'; }; document.addEventListener('click',()=>$('menu').style.display='none');
$('csvNodes').onclick=()=>{ if(S.nodes.length) deliver('nodes.csv',nodesCsv(S.nodes,nodeName)); };
$('csvParts').onclick=()=>{ if(S.parts.length) deliver('parts.csv',partsCsv(S.parts)); };
$('copy').onclick=async()=>{ if(!S.nodes.length) return; const txt=netlistText(S.nodes,nodeName);
  try{ await navigator.clipboard.writeText(txt); $('copy').textContent=T('copied'); setTimeout(()=>$('copy').textContent=T('copy'),1500); }catch{ $('copy').textContent=T('clipboardNA'); } };

// ============================================================ 10. settings, filters, (re)build
function renderFilters(){ const cc=new Map(), wc=new Map();
  for(let p=1;p<S.pages.length;p++){ const pg=S.pages[p]; if(!pg||!pg.raw) continue; for(const s of pg.raw.segments){ const L=dist(s.x1,s.y1,s.x2,s.y2); cc.set(s.color,(cc.get(s.color)||0)+1); const k=wkey(s.lw); wc.set(k,(wc.get(k)||0)+L); } }
  const mk=(el,entries,set,fmt)=>{ el.innerHTML=entries.map(([k,v])=>`<label><input type="checkbox" data-k="${k}" ${set.has(k)?'checked':''}>${fmt(k,v)}</label>`).join('');
    el.querySelectorAll('input').forEach(i=>i.onchange=()=>{ if(i.checked) set.add(i.dataset.k); else set.delete(i.dataset.k); rebuildAll(); }); };
  mk($('colors'),[...cc.entries()].sort((a,b)=>b[1]-a[1]),S.colorsOn,(k,v)=>`<span class="sw" style="background:${k}"></span>${k} <span class="hint">(${v})</span>`);
  mk($('widths'),[...wc.entries()].sort((a,b)=>b[1]-a[1]),S.widthsOn,(k,v)=>`${k} <span class="hint">(${(v/1000).toFixed(1)}k pt)</span>`); }
function defaultFiltersUI(){ const f=defaultFilters(S.pages.slice(1).map(p=>p&&p.raw)); S.colorsOn=f.colors; S.widthsOn=f.widths; }
function opts(){ return {colors:S.colorsOn, widths:S.widthsOn, tol:+$('tol').value||DEFAULT_OPTIONS.tol, labelDist:+$('labelDist').value||DEFAULT_OPTIONS.labelDist, needDot:$('needDot').checked?'auto':false, mergeLabels:$('mergeLabels').checked, insideRect:$('insideRect').checked}; }
function buildModel(){ ({nodes:S.nodes,nodeByKey:S.nodeByKey}=buildNodes(S.pages,S.outlineNets)); S.parts=buildParts(S.pages); }
// rebuild nets on every page, yielding to the browser between pages so big manuals stay responsive
let rebuildToken=0;
async function rebuildAll(){ if(!S.pages.length) return; const tok=++rebuildToken; const o=opts(); const t0=performance.now(); for(let p=1;p<S.pages.length;p++){ const pg=S.pages[p]; if(pg&&pg.raw) pg.model=buildNets(pg.raw,o); if(performance.now()-t0>40){ await new Promise(r=>setTimeout(r)); if(tok!==rebuildToken) return; } } S.model=S.pages[S.pageIndex].model;
  S.selKey=null; S.selPart=null; S.hover=null; buildModel(); renderAll(); runSearch(false); }
function renderAll(){ let segs=0,wires=0,gr=0,dots=0,texts=0,comps=0,dang=0,unc=0; for(let p=1;p<S.pages.length;p++){ const pg=S.pages[p]; if(!pg||!pg.model) continue; segs+=pg.raw.segments.length; wires+=pg.model.wires; gr+=pg.model.graphics; dots+=pg.raw.dots.length; texts+=pg.raw.texts.length; comps+=pg.model.comps.length; dang+=pg.model.nets.reduce((a,n)=>a+n.dangling.length,0); unc+=pg.model.unconnectedClusters; }
  $('stats').innerHTML=T('stats',{segs,wires,graphics:gr,dots,texts,nets:S.nodes.length,labelled:S.nodes.filter(n=>n.pins).length,comps:S.parts.length,dangling:dang,pages:S.pages.length-1});
  const w=[]; if(!texts) w.push(T('warnNoText')); if(!segs) w.push(T('warnNoLines')); if(unc>5) w.push(T('warnUnconnected',{n:unc})); $('warnings').innerHTML=w.map(x=>`<div class="warnbox">⚠ ${x}</div>`).join('');
  renderPageDots(); renderLists(); renderDetail(); drawOverlay(); }
['needDot','mergeLabels','insideRect'].forEach(id=>$(id).onchange=rebuildAll); ['tol','labelDist'].forEach(id=>$(id).onchange=rebuildAll);
$('showAll').onchange=drawOverlay; $('showDangling').onchange=drawOverlay; $('dim').onchange=drawOverlay;

// ============================================================ 11. loading
// ---- parsing runs in a Web Worker (core/extract.js); rendering stays on the main thread
let analyzer=null, jobId=0;
function getAnalyzer(){ if(analyzer!==null) return analyzer; try{ analyzer=new Worker(new URL('./analyze.worker.js', import.meta.url), {type:'module'}); analyzer.onerror=()=>{ analyzer=false; }; }catch{ analyzer=false; } return analyzer; }
function analyzeInWorker(data, onMeta, onPage){ const w=getAnalyzer(); if(!w) return null; const id=++jobId;
  return new Promise((resolve,reject)=>{ const h=e=>{ const m=e.data; if(m.id!==id) return;
      if(m.type==='meta') onMeta(m.numPages); else if(m.type==='page') onPage(m.p,m.raw); else if(m.type==='done'){ w.removeEventListener('message',h); resolve(m.outline); } else if(m.type==='error'){ w.removeEventListener('message',h); const err=new Error(m.message); err.name=m.name; reject(err); } };
    w.addEventListener('message',h); w.postMessage({id,data},[data]); }); }
async function analyzeHere(doc, onMeta, onPage){ onMeta(doc.numPages); for(let p=1;p<=doc.numPages;p++){ const page=await doc.getPage(p); onPage(p, await extractPage(page, pdfjsLib.OPS)); await new Promise(r=>setTimeout(r)); } return readOutline(doc); }
async function loadData(data){ $('drop').classList.add('hidden'); $('busy').style.display='block'; $('busy').textContent=T('parsing'); S.results=[]; S.query=''; $('search').value=''; $('searchInfo').textContent='';
  try{ if(S.doc){ try{ await S.doc.destroy(); }catch{} }
    const forWorker=data.slice(); // pdf.js takes ownership of the buffer it is given, so the worker gets its own copy
    S.doc=await pdfjsLib.getDocument({data}).promise; const N=S.doc.numPages; $('pageCount').textContent=N; $('pageNum').max=N; S.pages=[null];
    for(let p=1;p<=N;p++) S.pages.push({page:null,raw:null,model:null});
    const onMeta=()=>{}; let done=0; const onPage=(p,raw)=>{ S.pages[p].raw=raw; done++; $('busy').textContent=T('analyzing',{i:done,n:N}); };
    const t0=performance.now();
    let outline; const viaWorker=analyzeInWorker(forWorker.buffer,onMeta,onPage);
    try{ outline=viaWorker? await viaWorker : await analyzeHere(S.doc,onMeta,onPage); }
    catch(e){ if(e&&e.name==='PasswordException') throw e; console.warn('worker analysis failed, falling back to main thread',e); done=0; outline=await analyzeHere(S.doc,onMeta,onPage); }
    S.analysisMs=Math.round(performance.now()-t0); S.outlineNets=outline;
    for(let p=1;p<=N;p++) S.pages[p].page=await S.doc.getPage(p);
    defaultFiltersUI(); renderFilters(); const o=opts(); for(let p=1;p<=N;p++){ S.pages[p].model=buildNets(S.pages[p].raw,o); if(p%5===0) await new Promise(r=>setTimeout(r)); }
    buildModel(); S.selKey=null; S.selPart=null;
    S.pageIndex=1; $('pageNum').value=1; S.raw=S.pages[1].raw; S.model=S.pages[1].model; S.page=S.pages[1].page;
    S.zoom=Math.max(0.3,Math.min(3,($('viewport').clientWidth-40)/S.raw.base.width)); await renderPage(); renderAll(); setTab('nets'); }
  catch(e){ console.error(e); const msg=e&&e.name==='PasswordException'?T('encrypted'):T('openError')+e.message; $('stats').textContent=msg; $('drop').classList.remove('hidden'); $('drop').innerHTML='<div>'+esc(msg)+'</div>'; }
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
