// Schematic Net Tracer — geometry: affine maths, distances, colour keys and a uniform spatial grid.
// Pure module: no DOM, no global state. Imported by the UI, the analysis worker and the Node tests.
export const mul = (m, n) => [ n[0]*m[0]+n[1]*m[2], n[0]*m[1]+n[1]*m[3], n[2]*m[0]+n[3]*m[2], n[2]*m[1]+n[3]*m[3], n[4]*m[0]+n[5]*m[2]+m[4], n[4]*m[1]+n[5]*m[3]+m[5] ];
export const ap = (m, x, y) => [m[0]*x+m[2]*y+m[4], m[1]*x+m[3]*y+m[5]];
export const dist = (ax,ay,bx,by) => Math.hypot(ax-bx, ay-by);
export function segPointDist(s, px, py){ const dx=s.x2-s.x1, dy=s.y2-s.y1, l2=dx*dx+dy*dy; let t=l2?((px-s.x1)*dx+(py-s.y1)*dy)/l2:0; t=Math.max(0,Math.min(1,t)); return {d:dist(px,py,s.x1+t*dx,s.y1+t*dy), t}; }
export const rgb = c => { if(!c) return '#000000'; const h=v=>Math.round(Math.max(0,Math.min(255,v))).toString(16).padStart(2,'0'); return '#'+h(c[0])+h(c[1])+h(c[2]); };
export const wkey = lw => (Math.round(lw*20)/20).toFixed(2);
export const bboxOf = pts => { let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9; for(const [x,y] of pts){ if(x<x0)x0=x; if(x>x1)x1=x; if(y<y0)y0=y; if(y>y1)y1=y; } return {x0,y0,x1,y1}; };

// simple uniform grid over segments (bbox-based)
export class Grid { constructor(cell){ this.cell=cell; this.m=new Map(); }
  cells(x0,y0,x1,y1){ const c=this.cell, r=[]; for(let cx=Math.floor(Math.min(x0,x1)/c);cx<=Math.floor(Math.max(x0,x1)/c);cx++) for(let cy=Math.floor(Math.min(y0,y1)/c);cy<=Math.floor(Math.max(y0,y1)/c);cy++) r.push(cx+','+cy); return r; }
  add(id,x0,y0,x1,y1){ for(const k of this.cells(x0,y0,x1,y1)){ let a=this.m.get(k); if(!a) this.m.set(k,a=[]); a.push(id); } }
  query(x0,y0,x1,y1){ const out=new Set(); for(const k of this.cells(x0,y0,x1,y1)) for(const i of (this.m.get(k)||[])) out.add(i); return out; } }
