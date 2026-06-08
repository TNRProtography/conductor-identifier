// Conductor Gauge — vision engine (framework-agnostic, validated).
// Card geometry MUST match the printed marker card.
export const CARD = [ {x:-75,y:50}, {x:75,y:50}, {x:75,y:-50}, {x:-75,y:-50} ]; // TL TR BR BL
export const MARKER_PROMPTS = ["TOP-LEFT marker","TOP-RIGHT marker","BOTTOM-RIGHT marker","BOTTOM-LEFT marker"];

/* ---- homography ---- */
export function solveLinear(A,b){
  const n=b.length, M=A.map((r,i)=>r.concat([b[i]]));
  for(let col=0;col<n;col++){
    let piv=col; for(let r=col+1;r<n;r++) if(Math.abs(M[r][col])>Math.abs(M[piv][col])) piv=r;
    [M[col],M[piv]]=[M[piv],M[col]];
    const d=M[col][col]; if(Math.abs(d)<1e-12) throw new Error("singular");
    for(let c=col;c<=n;c++) M[col][c]/=d;
    for(let r=0;r<n;r++){ if(r===col) continue; const f=M[r][col]; for(let c=col;c<=n;c++) M[r][c]-=f*M[col][c]; }
  }
  return M.map(r=>r[n]);
}
export function homography(src,dst){
  const A=[],b=[];
  for(let i=0;i<4;i++){ const{x,y}=src[i],X=dst[i].x,Y=dst[i].y;
    A.push([x,y,1,0,0,0,-x*X,-y*X]); b.push(X);
    A.push([0,0,0,x,y,1,-x*Y,-y*Y]); b.push(Y); }
  const h=solveLinear(A,b); return [h[0],h[1],h[2],h[3],h[4],h[5],h[6],h[7],1];
}
export function applyH(H,p){ const d=H[6]*p.x+H[7]*p.y+H[8];
  return {x:(H[0]*p.x+H[1]*p.y+H[2])/d, y:(H[3]*p.x+H[4]*p.y+H[5])/d}; }

/* ---- auto-detect the 4 corner markers ---- */
export function autoMarkers(shot){
  const imgW=shot.width, imgH=shot.height;
  const MAXD=720, sc=Math.min(1,MAXD/Math.max(imgW,imgH));
  const w=Math.round(imgW*sc), h=Math.round(imgH*sc);
  const c=document.createElement("canvas"); c.width=w; c.height=h;
  const cx=c.getContext("2d"); cx.drawImage(shot,0,0,w,h);
  const id=cx.getImageData(0,0,w,h).data;
  const gray=new Uint8Array(w*h), hist=new Array(256).fill(0);
  for(let i=0;i<w*h;i++){ const g=(id[i*4]*0.299+id[i*4+1]*0.587+id[i*4+2]*0.114)|0; gray[i]=g; hist[g]++; }
  let sum=0; for(let i=0;i<256;i++) sum+=i*hist[i];
  let sumB=0,wB=0,wF=0,mx=0,th=128,total=w*h;
  for(let i=0;i<256;i++){ wB+=hist[i]; if(!wB) continue; wF=total-wB; if(!wF) break;
    sumB+=i*hist[i]; const mB=sumB/wB, mF=(sum-sumB)/wF; const v=wB*wF*(mB-mF)*(mB-mF); if(v>mx){mx=v;th=i;} }
  const dark=new Uint8Array(w*h); for(let i=0;i<w*h;i++) dark[i]=gray[i]<th?1:0;
  const lab=new Int32Array(w*h); let next=1; const blobs=[], stack=[];
  for(let i=0;i<w*h;i++){
    if(dark[i] && !lab[i]){ const id2=next++; let area=0,sx=0,sy=0,minx=w,maxx=0,miny=h,maxy=0;
      stack.push(i); lab[i]=id2;
      while(stack.length){ const p=stack.pop(), px=p%w, py=(p/w)|0;
        area++; sx+=px; sy+=py; if(px<minx)minx=px; if(px>maxx)maxx=px; if(py<miny)miny=py; if(py>maxy)maxy=py;
        const nb=[p-1,p+1,p-w,p+w];
        for(const q of nb){ if(q<0||q>=w*h) continue; if(Math.abs((q%w)-px)>1) continue; if(dark[q]&&!lab[q]){ lab[q]=id2; stack.push(q);} } }
      const bw=maxx-minx+1, bh=maxy-miny+1, fill=area/(bw*bh), ar=bw/bh;
      blobs.push({area,cx:sx/area,cy:sy/area,fill,ar}); }
  }
  const minA=(w*h)*0.0006, maxA=(w*h)*0.05;
  let cands=blobs.filter(b=>b.area>minA && b.area<maxA && b.fill>0.7 && b.ar>0.6 && b.ar<1.7);
  cands.sort((a,b)=>b.area-a.area); cands=cands.slice(0,10);
  if(cands.length<4) return null;
  const byPS=[...cands].sort((a,b)=>(a.cx+a.cy)-(b.cx+b.cy));
  const byMS=[...cands].sort((a,b)=>(a.cx-a.cy)-(b.cx-b.cy));
  const pick=[byPS[0], byMS[byMS.length-1], byPS[byPS.length-1], byMS[0]]; // TL TR BR BL
  for(let i=0;i<4;i++) for(let j=i+1;j<4;j++) if(pick[i]===pick[j]) return null;
  return pick.map(p=>({x:p.cx/sc, y:p.cy/sc}));
}

/* ---- detect the conductor on the lane and measure its width ---- */
export function detectConductor(shot, markers){
  const imgW=shot.width, imgH=shot.height;
  const Hinv=homography(CARD, markers);
  const img=shot.getContext("2d").getImageData(0,0,imgW,imgH).data;
  const px=(ix,iy)=>{ ix=ix|0; iy=iy|0; if(ix<0||iy<0||ix>=imgW||iy>=imgH) return null;
    const o=(iy*imgW+ix)*4; return [img[o],img[o+1],img[o+2]]; };
  const toImg=(X,Y)=>applyH(Hinv,{x:X,y:Y});
  const med=a=>{ const s=[...a].sort((u,v)=>u-v); return s[s.length>>1]; };
  const Y0=22, STEP=0.06, GAP=Math.round(1.4/STEP), SM=Math.max(1,Math.round(0.05/STEP));
  const ys=[]; for(let y=Y0;y>=-Y0;y-=STEP) ys.push(y);
  const N=ys.length;
  const widths=[], topPts=[], botPts=[]; let rs=0,gs=0,bs=0,ns=0;

  for(let x=-54;x<=54;x+=3){
    const L=new Float32Array(N), R=new Float32Array(N), G=new Float32Array(N), B=new Float32Array(N), ok=new Uint8Array(N);
    for(let i=0;i<N;i++){ const p=toImg(x,ys[i]), c=px(p.x,p.y);
      if(!c){ ok[i]=0; continue; } ok[i]=1; R[i]=c[0]; G[i]=c[1]; B[i]=c[2]; L[i]=0.299*c[0]+0.587*c[1]+0.114*c[2]; }
    // light smoothing of luminance
    const Ls=new Float32Array(N);
    for(let i=0;i<N;i++){ let s=0,n=0; for(let j=-SM;j<=SM;j++){ const t=i+j; if(t>=0&&t<N&&ok[t]){s+=L[t];n++;} } Ls[i]=n?s/n:NaN; }
    // paper reference (luminance + colour) from the outer region |y|>16
    const oL=[],oR=[],oG=[],oB=[];
    for(let i=0;i<N;i++) if(ok[i] && Math.abs(ys[i])>16){ oL.push(Ls[i]); oR.push(R[i]); oG.push(G[i]); oB.push(B[i]); }
    if(oL.length<12) continue;
    const Lp=med(oL), Rp=med(oR), Gp=med(oG), Bp=med(oB);
    let v=0; for(const l of oL) v+=(l-Lp)*(l-Lp); const sigma=Math.sqrt(v/oL.length);
    const Tlum=Math.max(9, 2.6*sigma);       // TWO-SIDED luminance deviation (darker OR brighter)
    const Tcol=Math.max(26, 3.2*sigma);      // colour distance from paper (L1)
    const isObj=i=>{ if(!ok[i]||isNaN(Ls[i])) return false;
      const dl=Math.abs(Ls[i]-Lp);
      const dc=Math.abs(R[i]-Rp)+Math.abs(G[i]-Gp)+Math.abs(B[i]-Bp);
      return dl>Tlum || dc>Tcol; };
    // longest object run anywhere in the band, bridging small bright gaps (specular)
    let bestLo=-1,bestHi=-1,bestLen=-1, i=0;
    while(i<N){
      if(isObj(i)){ let lo=i,hi=i,gap=0,j=i+1;
        while(j<N){ if(isObj(j)){ hi=j; gap=0; } else if(++gap>GAP) break; j++; }
        if(hi-lo>bestLen){ bestLen=hi-lo; bestLo=lo; bestHi=hi; } i=hi+1; }
      else i++; }
    if(bestLo<0) continue;
    const yTop=(bestLo>0)?(ys[bestLo]+ys[bestLo-1])/2:ys[bestLo];
    const yBot=(bestHi<N-1)?(ys[bestHi]+ys[bestHi+1])/2:ys[bestHi];
    const w=yTop-yBot, cen=(yTop+yBot)/2;
    if(w>0.8 && w<24 && Math.abs(cen)<16){
      widths.push(w); topPts.push({x,y:yTop}); botPts.push({x,y:yBot});
      const m=toImg(x,cen), c=px(m.x,m.y); if(c){ rs+=c[0]; gs+=c[1]; bs+=c[2]; ns++; } }
  }
  if(widths.length<4) return null;
  // reject scan outliers, then take the median width
  const mw=med(widths); const kw=[],kt=[],kb=[];
  for(let i=0;i<widths.length;i++) if(Math.abs(widths[i]-mw) <= 0.3*mw+0.4){ kw.push(widths[i]); kt.push(topPts[i]); kb.push(botPts[i]); }
  const tw=kw.length?kw:widths, tt=kw.length?kt:topPts, tb=kw.length?kb:botPts;
  const dia=med(tw);
  let matHint="Aluminium";
  if(ns){ const Rr=rs/ns,Gg=gs/ns,Bb=bs/ns, mx=Math.max(Rr,Gg,Bb),mn=Math.min(Rr,Gg,Bb),S=mx?(mx-mn)/mx:0;
    let h=0,d=mx-mn; if(d>0){ if(mx===Rr)h=60*(((Gg-Bb)/d)%6); else if(mx===Gg)h=60*(((Bb-Rr)/d)+2); else h=60*(((Rr-Gg)/d)+4);} if(h<0)h+=360;
    if(S>0.16 && h>=2 && h<=55) matHint="Copper"; }
  let bi=0,bd=1e9; for(let i=0;i<tt.length;i++){ const dd=Math.abs(tt[i].x); if(dd<bd){bd=dd;bi=i;} }
  const calA=toImg(tt[bi].x,tt[bi].y), calB=toImg(tb[bi].x,tb[bi].y);
  return { dia, matHint, calA, calB, topPts:tt, botPts:tb, Hinv, nScans:tw.length };
}

/* classify material from two manual edge taps */
export function materialFromEdges(shot, edges){
  const ctx=shot.getContext("2d"), imgW=shot.width, imgH=shot.height;
  const a=edges[0], b=edges[1]; let R=0,G=0,B=0,n=0;
  for(let t=0.25;t<=0.75;t+=0.1){
    const x=Math.round(a.x+(b.x-a.x)*t), y=Math.round(a.y+(b.y-a.y)*t);
    for(let dx=-2;dx<=2;dx++) for(let dy=-2;dy<=2;dy++){
      const px=Math.min(Math.max(x+dx,0),imgW-1), py=Math.min(Math.max(y+dy,0),imgH-1);
      const d=ctx.getImageData(px,py,1,1).data; R+=d[0];G+=d[1];B+=d[2];n++; } }
  R/=n;G/=n;B/=n; const mx=Math.max(R,G,B),mn=Math.min(R,G,B),sat=mx?(mx-mn)/mx:0;
  let hue=0,dl=mx-mn; if(dl>0){ if(mx===R)hue=60*(((G-B)/dl)%6); else if(mx===G)hue=60*(((B-R)/dl)+2); else hue=60*(((R-G)/dl)+4);} if(hue<0)hue+=360;
  return { material:(sat>0.16 && hue>=2 && hue<=55)?"Copper":"Aluminium", hue, sat };
}

/* ---- overlay drawing ---- */
function roundRect(x,X,Y,W,H,r){ x.beginPath(); x.moveTo(X+r,Y); x.arcTo(X+W,Y,X+W,Y+H,r);
  x.arcTo(X+W,Y+H,X,Y+H,r); x.arcTo(X,Y+H,X,Y,r); x.arcTo(X,Y,X+W,Y,r); x.closePath(); }

export function drawOverlay(x, shot, det, dia, markers, banner){
  const imgW=shot.width, imgH=shot.height;
  x.drawImage(shot,0,0);
  if(!det) return;
  const lw=Math.max(2,imgW/600);
  const Hinv=det.Hinv || homography(CARD,markers);
  if(det.topPts && det.topPts.length>1){
    x.lineWidth=lw*1.3; x.strokeStyle="#19d3a2"; x.lineJoin="round";
    [det.topPts,det.botPts].forEach(pts=>{ x.beginPath();
      pts.forEach((p,i)=>{ const q=applyH(Hinv,{x:p.x,y:p.y}); i?x.lineTo(q.x,q.y):x.moveTo(q.x,q.y); }); x.stroke(); });
  }
  const A=det.calA, B=det.calB;
  const dx=B.x-A.x, dy=B.y-A.y, len=Math.hypot(dx,dy)||1, ux=dx/len, uy=dy/len, tk=lw*7;
  x.lineWidth=lw*1.8; x.strokeStyle="#e5007d"; x.lineCap="round";
  x.beginPath(); x.moveTo(A.x,A.y); x.lineTo(B.x,B.y); x.stroke();
  x.beginPath(); x.moveTo(A.x-uy*tk,A.y+ux*tk); x.lineTo(A.x+uy*tk,A.y-ux*tk);
                 x.moveTo(B.x-uy*tk,B.y+ux*tk); x.lineTo(B.x+uy*tk,B.y-ux*tk); x.stroke();
  const fs=Math.max(20,imgW/26), pad=fs*0.45, label=dia.toFixed(2)+" mm";
  x.font="700 "+fs+"px monospace"; const tw=x.measureText(label).width;
  let bx=((A.x+B.x)/2)+uy*tk+lw*4, by=((A.y+B.y)/2)-ux*tk-(fs+pad)/2;
  bx=Math.min(Math.max(bx,4),imgW-tw-2*pad-4); by=Math.min(Math.max(by,4),imgH-fs-pad-4);
  x.fillStyle="rgba(8,11,14,0.86)"; roundRect(x,bx,by,tw+2*pad,fs+pad,fs*0.32); x.fill();
  x.fillStyle="#fff"; x.textBaseline="middle"; x.fillText(label,bx+pad,by+(fs+pad)/2);
  if(banner){
    const bh=Math.max(120,imgH*0.15), f2=bh*0.30;
    x.fillStyle="rgba(8,11,14,0.82)"; x.fillRect(0,imgH-bh,imgW,bh);
    x.fillStyle="#19d3a2"; x.textBaseline="middle"; x.font="700 "+f2+"px sans-serif";
    x.fillText(banner, imgW*0.04, imgH-bh*0.5);
  }
}