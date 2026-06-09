// Conductor Gauge — vision engine v2 (full rework)
// - Rotation-invariant marker assignment: card works in ANY orientation
// - Two-pass conductor detection with cross-scan voting: shadows can't win
// - Robust axis fit (Theil–Sen) + tilt correction
// - Visual strand-ridge counting (6-outer vs 19-wire vs 37-wire)
// - Bow estimation (flexible conductors lie curved; ACSR lies straight)

export const CARD = [ {x:-75,y:50}, {x:75,y:50}, {x:75,y:-50}, {x:-75,y:-50} ]; // TL TR BR BL
export const MIDS = [ {x:0,y:50}, {x:0,y:-50} ];   // long-side midpoint markers (card v2)
export const MARKER_PROMPTS = ["TOP-LEFT marker","TOP-RIGHT marker","BOTTOM-RIGHT marker","BOTTOM-LEFT marker"];

/* Copper colour — fresh (bright orange) and oxidised (dark brownish). */
function isCopper(sat,hue,lum=128){
  if(sat>0.18 && hue>=2 && hue<=62) return true;
  if(sat>0.09 && hue>=10 && hue<=55 && lum<160) return true;
  return false;
}

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

/* least-squares homography for N≥4 correspondences (normal equations) */
export function homographyLS(src,dst){
  const n=src.length, A=[], b=[];
  for(let i=0;i<n;i++){ const{x,y}=src[i],X=dst[i].x,Y=dst[i].y;
    A.push([x,y,1,0,0,0,-x*X,-y*X]); b.push(X);
    A.push([0,0,0,x,y,1,-x*Y,-y*Y]); b.push(Y); }
  // AtA h = At b
  const AtA=Array.from({length:8},()=>new Array(8).fill(0));
  const Atb=new Array(8).fill(0);
  for(let r=0;r<A.length;r++){
    for(let i=0;i<8;i++){ Atb[i]+=A[r][i]*b[r];
      for(let j=0;j<8;j++) AtA[i][j]+=A[r][i]*A[r][j]; } }
  const h=solveLinear(AtA,Atb);
  return [h[0],h[1],h[2],h[3],h[4],h[5],h[6],h[7],1];
}

/* ---- auto-detect the 4 corner markers — ROTATION INVARIANT ----
   Markers form a 150×100 mm rectangle. After finding the 4 marker blobs we
   sort them angularly around their centroid, then identify the LONG sides
   (150 mm) by comparing opposite side-length sums. Corners are assigned so
   the card-space x axis always runs along the long side — i.e. along the
   conductor channel — no matter how the phone or card is rotated. */
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
  let sumB=0,wB=0,wF=0,mxv=0,th=128,total=w*h;
  for(let i=0;i<256;i++){ wB+=hist[i]; if(!wB) continue; wF=total-wB; if(!wF) break;
    sumB+=i*hist[i]; const mB=sumB/wB, mF=(sum-sumB)/wF; const v=wB*wF*(mB-mF)*(mB-mF); if(v>mxv){mxv=v;th=i;} }
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

  // try the v2 6-marker layout first: 4 corners + 2 long-side midpoints
  let mids=null, warpMM=null;
  if(cands.length>=6){
    const six=cands.slice(0,6);
    const gx6=six.reduce((s,b)=>s+b.cx,0)/6, gy6=six.reduce((s,b)=>s+b.cy,0)/6;
    // corners are farther from the centroid than the mid markers
    const byDist=[...six].sort((a,b)=>
      Math.hypot(b.cx-gx6,b.cy-gy6)-Math.hypot(a.cx-gx6,a.cy-gy6));
    const cornerCand=byDist.slice(0,4), midCand=byDist.slice(4,6);
    // wind the 4 corners and assign by long side (same as 4-marker path below)
    const gxc=cornerCand.reduce((s,b)=>s+b.cx,0)/4, gyc=cornerCand.reduce((s,b)=>s+b.cy,0)/4;
    const quad6=[...cornerCand].sort((a,b)=>Math.atan2(a.cy-gyc,a.cx-gxc)-Math.atan2(b.cy-gyc,b.cx-gxc));
    const sl6=[0,1,2,3].map(i=>{const a=quad6[i],b=quad6[(i+1)%4];return Math.hypot(a.cx-b.cx,a.cy-b.cy);});
    const q6=(sl6[0]+sl6[2]>=sl6[1]+sl6[3])?quad6:[quad6[1],quad6[2],quad6[3],quad6[0]];
    try{
      const Hc=homography(CARD, q6.map(p=>({x:p.cx,y:p.cy})));
      // predicted image positions of the two mid markers
      const pm=MIDS.map(m=>applyH(Hc,m));
      // greedy match mid candidates to predictions
      const used=[false,false]; let errSum=0, okAll=true; const matched=[null,null];
      for(const mc of midCand){
        let bi=-1,bd=1e9;
        for(let i=0;i<2;i++){ if(used[i]) continue;
          const d=Math.hypot(mc.cx-pm[i].x, mc.cy-pm[i].y); if(d<bd){bd=d;bi=i;} }
        if(bi<0){ okAll=false; break; }
        used[bi]=true; matched[bi]=mc; errSum+=bd;
      }
      if(okAll && matched[0] && matched[1]){
        // express error in mm via local scale (px per mm along the top edge)
        const e0=Math.hypot(q6[0].cx-q6[1].cx,q6[0].cy-q6[1].cy)/150; // px/mm
        const errPx=errSum/2;
        const wm=errPx/(e0||1);
        if(wm<8){           // plausible mid markers (within 8 mm of prediction)
          mids=matched.map(p=>({x:p.cx/sc,y:p.cy/sc}));
          warpMM=wm;
          const out=q6.map(p=>({x:p.cx/sc,y:p.cy/sc}));
          out.mids=mids; out.warpMM=warpMM;
          return out;
        }
      }
    }catch{}
  }

  // 4-marker fallback (original cards)
  const four=cands.slice(0,4);
  // centroid
  const gx=four.reduce((s,b)=>s+b.cx,0)/4, gy=four.reduce((s,b)=>s+b.cy,0)/4;
  // angular sort around centroid → consistent quad winding
  const quad=[...four].sort((a,b)=>Math.atan2(a.cy-gy,a.cx-gx)-Math.atan2(b.cy-gy,b.cx-gx));
  // side lengths of the wound quad
  const sl=[0,1,2,3].map(i=>{ const a=quad[i], b=quad[(i+1)%4]; return Math.hypot(a.cx-b.cx,a.cy-b.cy); });
  // The 150 mm sides are the pair of opposite sides with the larger sum.
  // sides 0&2 vs sides 1&3
  let q;
  if(sl[0]+sl[2] >= sl[1]+sl[3]){
    // side 0 (quad0→quad1) is LONG ⇒ quad0,quad1 are one long edge (top or bottom — equivalent)
    q=[quad[0],quad[1],quad[2],quad[3]];   // TL TR BR BL
  } else {
    // side 1 (quad1→quad2) is LONG ⇒ rotate assignment by one
    q=[quad[1],quad[2],quad[3],quad[0]];
  }
  // sanity: all four distinct
  for(let i=0;i<4;i++) for(let j=i+1;j<4;j++) if(q[i]===q[j]) return null;
  return q.map(p=>({x:p.cx/sc, y:p.cy/sc}));
}

/* =====================================================================
   detectConductor v2 — two-pass voting detector
   PASS 1: per-scan classification + run finding → rough centres
           robust Theil–Sen axis fit through the centres
   PASS 2: re-sample every scan in the axis-centred frame; every scan
           votes per perpendicular offset t: "conductor here or not".
           Edges = where the vote fraction crosses 50 % (sub-bin interp).
           Diameter = band width × cos(tilt).
   Extras: per-scan strand-ridge counting → layer hint (o6/19/37)
           bow estimate from quadratic fit of centres
   ===================================================================== */
export function detectConductor(shot, markers){
  const imgW=shot.width, imgH=shot.height;
  // use all 6 markers (least squares) when the v2 card's mids were found and the card is flat
  const Hinv=(markers.mids && markers.warpMM!=null && markers.warpMM<1.5)
    ? homographyLS(CARD.concat(MIDS), [...markers, ...markers.mids])
    : homography(CARD, markers);
  const img=shot.getContext("2d").getImageData(0,0,imgW,imgH).data;
  const px=(ix,iy)=>{ ix|=0; iy|=0; if(ix<0||iy<0||ix>=imgW||iy>=imgH) return null;
    const o=(iy*imgW+ix)*4; return [img[o],img[o+1],img[o+2]]; };
  const toImg=(X,Y)=>applyH(Hinv,{x:X,y:Y});
  const med=a=>{ if(!a.length) return NaN; const s=[...a].sort((u,v)=>u-v); return s[s.length>>1]; };

  const STEP=0.06, Y0=22;
  const SM=Math.max(1,Math.round(0.05/STEP));
  const TW=Math.max(2,Math.round(0.25/STEP));
  const GAP=Math.round(2.0/STEP);
  const XS=[]; for(let x=-54;x<=54;x+=3) XS.push(x);

  // ---------- shared per-scan machinery ----------
  // samples a column of values at card-x = x along offsets list `offs` (mm, in +y direction
  // from base position baseY(off)), returns {L,R,G,B,ok,Ls,tex}
  function sampleColumn(x, offs, centerY){
    const n=offs.length;
    const L=new Float32Array(n),R=new Float32Array(n),G=new Float32Array(n),B=new Float32Array(n),ok=new Uint8Array(n);
    for(let i=0;i<n;i++){
      const p=toImg(x, centerY+offs[i]), c=px(p.x,p.y);
      if(!c){ok[i]=0;continue;} ok[i]=1; R[i]=c[0];G[i]=c[1];B[i]=c[2];
      L[i]=0.299*c[0]+0.587*c[1]+0.114*c[2];
    }
    const Ls=new Float32Array(n);
    for(let i=0;i<n;i++){ let s=0,m=0;
      for(let j=-SM;j<=SM;j++){ const t=i+j; if(t>=0&&t<n&&ok[t]){s+=L[t];m++;} }
      Ls[i]=m?s/m:NaN; }
    const tex=new Float32Array(n);
    for(let i=0;i<n;i++){ if(!ok[i]){tex[i]=0;continue;} let s=0,s2=0,m=0;
      for(let j=-TW;j<=TW;j++){ const t=i+j; if(t>=0&&t<n&&ok[t]){ s+=L[t];s2+=L[t]*L[t];m++; } }
      tex[i]=m?Math.sqrt(Math.max(0,s2/m-(s/m)*(s/m))):0; }
    return {L,R,G,B,ok,Ls,tex,n};
  }

  // builds paper stats from samples flagged paper (|offset|>paperFrom)
  function paperStats(col, offs, paperFrom){
    const oL=[],oR=[],oG=[],oB=[],oT=[];
    for(let i=0;i<col.n;i++) if(col.ok[i] && Math.abs(offs[i])>paperFrom){
      oL.push(col.Ls[i]);oR.push(col.R[i]);oG.push(col.G[i]);oB.push(col.B[i]);oT.push(col.tex[i]); }
    if(oL.length<12) return null;
    const Lp=med(oL),Rp=med(oR),Gp=med(oG),Bp=med(oB),Tp=med(oT);
    let v=0; for(const l of oL) v+=(l-Lp)*(l-Lp);
    const sigma=Math.sqrt(v/oL.length);
    const sP=(Rp+Gp+Bp)||1;
    return {Lp, sigma, Tp, rp:Rp/sP, gp:Gp/sP,
      Tlum:Math.max(8,2.2*sigma), Ttex:Math.max(5,Tp*3+2), Tchr:22,
      DkTex:Math.max(3.5,(Tp*3+2)*0.3)};
  }

  // per-sample conductor test — the shadow killer:
  //  1. brighter than paper  → specular metal (shadow is never brighter)
  //  2. coloured             → copper / coloured surface (shadow is neutral)
  //  3. dark AND textured    → strand structure (shadow is dark but SMOOTH)
  //  4. very deep black      → black covering (a card shadow rarely gets this dark)
  function makeIsObj(col, st){
    const chroma=i=>{ const s=(col.R[i]+col.G[i]+col.B[i])||1;
      return (Math.abs(col.R[i]/s-st.rp)+Math.abs(col.G[i]/s-st.gp))*510; };
    return i=>{
      if(!col.ok[i]||isNaN(col.Ls[i])) return false;
      const dl=col.Ls[i]-st.Lp;
      if(dl > st.Tlum*0.7) return true;
      if(chroma(i) > st.Tchr) return true;
      if(dl < -st.Tlum*0.5 && col.tex[i] > st.DkTex) return true;
      if(col.Ls[i] < st.Lp*0.55) return true;   // deep/mid-dark metal band (diffuse shadows stay >0.55·paper)
      return false;
    };
  }

  function longestRun(isObj,n){
    let bestLo=-1,bestHi=-1,bestLen=-1,i=0;
    while(i<n){
      if(isObj(i)){ let lo=i,hi=i,gap=0,j=i+1;
        while(j<n){ if(isObj(j)){hi=j;gap=0;} else if(++gap>GAP) break; j++; }
        if(hi-lo>bestLen){bestLen=hi-lo;bestLo=lo;bestHi=hi;}
        i=hi+1; }
      else i++;
    }
    return bestLo<0?null:[bestLo,bestHi];
  }

  /* ---------------- PASS 1: rough centres ---------------- */
  const offs1=[]; for(let y=Y0;y>=-Y0;y-=STEP) offs1.push(y);
  const centers=[];        // {x, c} rough conductor centre per scan
  const statsByX=new Map(); // paper stats per x (reused in pass 2)
  let rs=0,gs=0,bs=0,ns=0;

  for(const x of XS){
    const col=sampleColumn(x,offs1,0);
    const st=paperStats(col,offs1,16);
    if(!st) continue;
    statsByX.set(x,st);
    const run=longestRun(makeIsObj(col,st),col.n);
    if(!run) continue;
    const yTop=offs1[run[0]], yBot=offs1[run[1]];
    const w=yTop-yBot, cen=(yTop+yBot)/2;
    if(w>0.7 && w<24 && Math.abs(cen)<16) centers.push({x,c:cen,w});
  }
  if(centers.length<5) return null;

  // robust axis: Theil–Sen slope (median of pairwise slopes), median intercept
  const slopes=[];
  for(let i=0;i<centers.length;i++) for(let j=i+1;j<centers.length;j++){
    const dx=centers[j].x-centers[i].x;
    if(Math.abs(dx)>5) slopes.push((centers[j].c-centers[i].c)/dx);
  }
  const b=slopes.length?med(slopes):0;
  const a=med(centers.map(p=>p.c-b*p.x));
  const cosT=Math.cos(Math.atan(b));   // tilt correction

  // bow: quadratic residual — fit c = a2 + b2 x + q x², report sag q*54²
  let bow=0;
  if(centers.length>=8){
    // simple least squares for quadratic
    let Sx=0,Sx2=0,Sx3=0,Sx4=0,Sy=0,Sxy=0,Sx2y=0,n=centers.length;
    for(const p of centers){ const X=p.x,Y=p.c;
      Sx+=X;Sx2+=X*X;Sx3+=X*X*X;Sx4+=X*X*X*X;Sy+=Y;Sxy+=X*Y;Sx2y+=X*X*Y; }
    try{
      const sol=solveLinear([[n,Sx,Sx2],[Sx,Sx2,Sx3],[Sx2,Sx3,Sx4]],[Sy,Sxy,Sx2y]);
      bow=Math.abs(sol[2])*54*54;   // sag over the half-span in mm
    }catch{ bow=0; }
  }

  /* ---------------- PASS 2: axis-frame aggregation ---------------- */
  // Every scan is re-sampled in the axis-centred frame. Two aggregates per
  // perpendicular offset t:
  //   frac[t]  — fraction of scans whose pixel classifies as conductor (seed band)
  //   medL[t]  — median luminance across scans (strand spiral averages out,
  //              so the only sharp gradients left are the TRUE outer edges;
  //              shadow ramps are soft and lose)
  const T2=14, ST2=0.05;
  const offs2=[]; for(let t=T2;t>=-T2;t-=ST2) offs2.push(t);
  const NB=offs2.length;
  const vote=new Float32Array(NB), tot=new Float32Array(NB);
  const lumBins=Array.from({length:NB},()=>[]);
  const ridgeCounts=[], ridgeSpacings=[], layRow=[];

  for(const x of XS){
    const st=statsByX.get(x); if(!st) continue;
    const cAt=a+b*x;
    if(Math.abs(cAt)>16) continue;
    const col=sampleColumn(x,offs2,cAt);
    const isObj=makeIsObj(col,st);
    for(let i=0;i<NB;i++){ if(!col.ok[i]) continue;
      tot[i]++; if(isObj(i)) vote[i]++;
      // normalise luminance to this scan's paper so bins are comparable
      lumBins[i].push(col.Ls[i]/st.Lp);
    }
    // strand ridges on this scan: positions of luminance maxima → count AND spacing
    const run=longestRun(isObj,NB);
    if(run){
      const lo=run[0],hi=run[1];
      if(hi-lo>=6){
        const peaksT=[];
        let lastMin=col.Ls[lo], peak=-1, peakI=-1;
        const prom=Math.max(6, st.sigma*1.5);
        for(let i=lo+1;i<=hi;i++){
          const v2=col.Ls[i]; if(isNaN(v2)) continue;
          if(peak<0){ if(v2>lastMin+prom){ peak=v2; peakI=i; } else if(v2<lastMin) lastMin=v2; }
          else { if(v2>peak){ peak=v2; peakI=i; }
                 else if(v2<peak-prom){ peaksT.push(offs2[peakI]); lastMin=v2; peak=-1; } }
        }
        if(peak>0 && peakI>=0) peaksT.push(offs2[peakI]);
        if(peaksT.length>=1 && peaksT.length<=12){
          ridgeCounts.push(peaksT.length);
          for(let k=1;k<peaksT.length;k++) ridgeSpacings.push(Math.abs(peaksT[k-1]-peaksT[k]));
        }
      }
      const mid=(lo+hi)>>1;
      if(col.ok[mid]){ rs+=col.R[mid]; gs+=col.G[mid]; bs+=col.B[mid]; ns++;
        // lay rows: normalised inner-band luminance at the run centre per x (for axial period)
        layRow.push({x, v:col.Ls[mid]/st.Lp});
      }
    }
  }

  // scene quality: median paper luminance + lighting unevenness across scans
  const allLp=[...statsByX.values()].map(s=>s.Lp);
  const allSg=[...statsByX.values()].map(s=>s.sigma);
  const quality={ Lp:med(allLp), sigma:med(allSg) };

  const frac=new Float32Array(NB), medL=new Float32Array(NB);
  for(let i=0;i<NB;i++){ frac[i]=tot[i]?vote[i]/tot[i]:0; medL[i]=lumBins[i].length?med(lumBins[i]):NaN; }

  // seed band: contiguous frac≥0.5 region nearest t=0
  const c0=Math.round(T2/ST2);
  let lo=-1,hi=-1;
  if(frac[c0]>=0.5){ lo=hi=c0; }
  else for(let d=1;d<NB;d++){
    if(c0-d>=0 && frac[c0-d]>=0.5){ lo=hi=c0-d; break; }
    if(c0+d<NB && frac[c0+d]>=0.5){ lo=hi=c0+d; break; }
  }
  if(lo<0) return null;
  while(lo>0    && frac[lo-1]>=0.5) lo--;
  while(hi<NB-1 && frac[hi+1]>=0.5) hi++;
  // NOTE: offs2 descends (t: +14 → −14) ⇒ index lo = TOP edge (larger t), hi = BOTTOM edge.

  // aggregated gradient |d medL / d index| (light smoothing)
  const g=new Float32Array(NB);
  for(let i=1;i<NB-1;i++){
    const a1=medL[i-1], a2=medL[i+1];
    g[i]=(isNaN(a1)||isNaN(a2))?0:Math.abs(a2-a1);
  }
  for(let i=1;i<NB-1;i++) g[i]=(g[i-1]+2*g[i]+g[i+1])*0.25;

  // place each edge at the max aggregated gradient near the seed edge:
  // search 4 mm outward / 1.5 mm inward of the seed edge; parabolic sub-bin refine.
  const OUT=Math.round(4.0/ST2), IN=Math.round(1.5/ST2);
  function edgeAt(seedIdx, outwardDir){ // outwardDir: -1 = toward index 0 (larger t), +1 = toward NB-1
    let k0=seedIdx + outwardDir*OUT, k1=seedIdx - outwardDir*IN;
    let from=Math.max(1,Math.min(k0,k1)), to=Math.min(NB-2,Math.max(k0,k1));
    let bi=seedIdx, bg=-1;
    for(let k=from;k<=to;k++) if(g[k]>bg){ bg=g[k]; bi=k; }
    // parabolic interpolation around the gradient peak
    const y1=g[bi-1]||0, y2=g[bi], y3=g[bi+1]||0;
    const den=(y1-2*y2+y3);
    const dx=den!==0 ? 0.5*(y1-y3)/den : 0;
    const idx=bi+Math.max(-1,Math.min(1,dx));
    return offs2[0]-idx*ST2;  // index → t (offs2 descends linearly)
  }
  const tHi=edgeAt(lo,-1);   // top edge: search toward larger t
  const tLo=edgeAt(hi,+1);   // bottom edge: search toward smaller t
  const wBand=tHi-tLo;
  if(!(wBand>0.7 && wBand<26)) return null;
  const dia=wBand*cosT;

  // ridge → layer hint. Two estimators that vote:
  //   count:   number of bright ridges across the diameter (3 / 5 / 7)
  //   spacing: diameter ÷ median ridge spacing ≈ visible strand count (robust to missed peaks)
  const rMed=ridgeCounts.length>=4 ? med(ridgeCounts) : null;
  let layer=null;
  const spMed=ridgeSpacings.length>=6 ? med(ridgeSpacings) : null;
  const nBySpacing=spMed ? wBand/spMed : null;
  const classify=n=>{ if(n==null) return null;
    if(n>=2 && n<=4.2) return 'o6'; if(n>4.2 && n<=6.2) return '19'; if(n>6.2) return '37'; return null; };
  const byCount=classify(rMed), bySpacing=classify(nBySpacing);
  layer = bySpacing && byCount ? (bySpacing===byCount ? byCount : bySpacing)  // spacing wins disputes
        : (bySpacing || byCount);

  // axial lay period: autocorrelation of the centre-row luminance along the conductor
  let layPeriod=null;
  if(layRow.length>=18){
    layRow.sort((p,q)=>p.x-q.x);
    const v=layRow.map(p=>p.v), m=v.reduce((s,t)=>s+t,0)/v.length;
    const d=v.map(t=>t-m), n=d.length;
    let best=-1, bestLag=0;
    for(let lag=2;lag<=Math.min(8,n-6);lag++){     // lags of 6–24 mm (x step ≈ 3 mm)
      let s=0,c2=0;
      for(let i=0;i+lag<n;i++){ s+=d[i]*d[i+lag]; c2++; }
      const r=c2?s/c2:0;
      if(r>best){ best=r; bestLag=lag; }
    }
    let v0=0; for(const t of d) v0+=t*t; v0/=n;
    if(v0>1e-6 && best>0.25*v0) layPeriod=bestLag*3;   // mm between band repeats
  }

  // material
  let matHint="Aluminium";
  if(ns){ const Rr=rs/ns,Gg=gs/ns,Bb=bs/ns,mx=Math.max(Rr,Gg,Bb),mn=Math.min(Rr,Gg,Bb),S=mx?(mx-mn)/mx:0;
    let hh=0,d=mx-mn; if(d>0){if(mx===Rr)hh=60*(((Gg-Bb)/d)%6);else if(mx===Gg)hh=60*(((Bb-Rr)/d)+2);else hh=60*(((Rr-Gg)/d)+4);}if(hh<0)hh+=360;
    if(isCopper(S,hh,0.299*Rr+0.587*Gg+0.114*Bb)) matHint="Copper"; }

  // edge traces for the overlay — the fitted axis ± half width
  const topPts=[],botPts=[];
  const xMin=Math.max(-54, Math.min(...centers.map(p=>p.x)));
  const xMax=Math.min( 54, Math.max(...centers.map(p=>p.x)));
  for(let x=xMin;x<=xMax;x+=6){
    const c=a+b*x;
    topPts.push({x, y:c+wBand/2});
    botPts.push({x, y:c-wBand/2});
  }
  // caliper at the most central scanned x
  const cx0=Math.abs(xMin)<Math.abs(xMax)?Math.max(xMin,Math.min(0,xMax)):0;
  const cc=a+b*cx0;
  const calA=toImg(cx0, cc+wBand/2), calB=toImg(cx0, cc-wBand/2);

  return { dia, matHint, calA, calB, topPts, botPts, Hinv,
           nScans:centers.length, tilt:Math.atan(b)*180/Math.PI,
           bow, ridge:rMed, layer, layPeriod, quality,
           axis:{a,b}, wBand,
           warpMM:(markers.warpMM!=null?markers.warpMM:null) };
}


/* =====================================================================
   analyzeWinding — strand count from the helical winding pattern
   1. Rectify a patch of the conductor surface into (s,t) mm-space:
      s along the fitted axis, t across it (inner 84% of the face,
      avoiding the foreshortened edges).
   2. Remove per-row shading (specular stripes) so only the moving
      band pattern remains.
   3. Structure tensor over the patch → dominant gradient orientation
      = the normal to the winding bands.
   4. Project every sample onto that normal and autocorrelate the
      profile → band period = projected strand width d_s.
   5. Cylinder geometry: N_outer = π·(D − d_s)/d_s.
      N_outer ≈ 6  → 7-strand class (6+1: 7-wire Cu/AAC or 6/1 ACSR)
      N_outer ≈ 12 → 19-strand class (12+6+1)
      N_outer ≈ 18 → 37-strand class (18+12+6+1)
      (The core is inferred from standard constructions — it can't be
       seen from the side, as expected.)
   ===================================================================== */
export function analyzeWinding(shot, markers, det){
  if(!det || !det.axis || !det.wBand) return null;
  const imgW=shot.width, imgH=shot.height;
  const Hinv=det.Hinv || homography(CARD, markers);
  const img=shot.getContext("2d").getImageData(0,0,imgW,imgH).data;
  const px=(ix,iy)=>{ ix|=0; iy|=0; if(ix<0||iy<0||ix>=imgW||iy>=imgH) return null;
    const o=(iy*imgW+ix)*4; return img[o]*0.299+img[o+1]*0.587+img[o+2]*0.114; };
  const toImg=(X,Y)=>applyH(Hinv,{x:X,y:Y});
  const {a,b}=det.axis, D=det.wBand;

  // --- 1. rectified patch ---
  const S0=46, SST=0.3;                       // s: ±46 mm along the axis, 0.3 mm step
  const TT=0.42*D, TST=Math.max(0.05, D/70);  // t: inner 84% of the face
  const sN=Math.floor(2*S0/SST)+1, tN=Math.floor(2*TT/TST)+1;
  if(tN<8) return null;                        // conductor too thin to analyse
  const G=[];
  for(let r=0;r<tN;r++){
    const t=-TT+r*TST, row=new Float32Array(sN);
    for(let c2=0;c2<sN;c2++){
      const s=-S0+c2*SST, cen=a+b*s;
      const p=toImg(s, cen+t), v=px(p.x,p.y);
      row[c2]=v==null?NaN:v;
    }
    G.push(row);
  }
  // --- 2. per-row mean removal (kills static cross-face shading) ---
  for(let r=0;r<tN;r++){
    let m=0,n=0; for(let c2=0;c2<sN;c2++) if(!isNaN(G[r][c2])){m+=G[r][c2];n++;}
    if(!n){continue;} m/=n;
    for(let c2=0;c2<sN;c2++) G[r][c2]=isNaN(G[r][c2])?0:G[r][c2]-m;
  }
  // --- 3. structure tensor (gradients per mm) ---
  let Jss=0,Jtt=0,Jst=0;
  for(let r=1;r<tN-1;r++) for(let c2=1;c2<sN-1;c2++){
    const gs=(G[r][c2+1]-G[r][c2-1])/(2*SST);
    const gt=(G[r+1][c2]-G[r-1][c2])/(2*TST);
    Jss+=gs*gs; Jtt+=gt*gt; Jst+=gs*gt;
  }
  const tot=Jss+Jtt; if(tot<1e-6) return null;
  const phi=0.5*Math.atan2(2*Jst, Jss-Jtt);   // dominant gradient orientation (band normal)
  // coherence: how strongly oriented the pattern is (0 = isotropic noise, 1 = perfect bands)
  const coher=Math.sqrt((Jss-Jtt)*(Jss-Jtt)+4*Jst*Jst)/tot;
  if(coher<0.18) return null;                  // no winding pattern (smooth / covered)

  // --- 4. profile along the band normal, autocorrelation ---
  const nx=Math.cos(phi), ny=Math.sin(phi);
  const UB=0.05;                                // 0.05 mm bins
  const bins=new Map();
  for(let r=0;r<tN;r++){
    const t=-TT+r*TST;
    for(let c2=0;c2<sN;c2++){
      const s=-S0+c2*SST;
      const u=Math.round((s*nx+t*ny)/UB);
      const e=bins.get(u); if(e){e.s+=G[r][c2];e.n++;} else bins.set(u,{s:G[r][c2],n:1});
    }
  }
  const ks=[...bins.keys()].sort((x,y)=>x-y);
  const prof=ks.map(k=>{const e=bins.get(k);return e.s/e.n;});
  const M=prof.length; if(M<40) return null;
  let mean=0; for(const v of prof) mean+=v; mean/=M;
  const dprof=prof.map(v=>v-mean);
  let v0=0; for(const v of dprof) v0+=v*v; v0/=M;
  if(v0<1e-6) return null;
  // search lags from D/9 (37-wire strand) to D/2 (oversized guard)
  const lagMin=Math.max(3, Math.round((D/9)/UB));
  const lagMax=Math.min(M-10, Math.round((D/1.8)/UB));
  let best=-1, bestLag=0;
  for(let lag=lagMin;lag<=lagMax;lag++){
    let s2=0,n2=0;
    for(let i2=0;i2+lag<M;i2++){ s2+=dprof[i2]*dprof[i2+lag]; n2++; }
    const r2=n2?(s2/n2)/v0:0;
    if(r2>best){ best=r2; bestLag=lag; }
  }
  if(best<0.22) return null;                   // weak periodicity
  // harmonic correction: a periodic signal correlates at every multiple of its
  // true period — if half the winning lag also correlates strongly, the winner
  // was the 2nd harmonic. Walk down until the fundamental is found.
  const rAt=(lag)=>{ if(lag<lagMin||lag>lagMax) return -1;
    let s2=0,n2=0; for(let i2=0;i2+lag<M;i2++){ s2+=dprof[i2]*dprof[i2+lag]; n2++; }
    return n2?(s2/n2)/v0:-1; };
  let guard=0;
  while(guard++<3){
    const half=Math.round(bestLag/2);
    const rH=rAt(half);
    if(half>=lagMin && rH>0.7*best && rH>0.22){ bestLag=half; best=rH; } else break;
  }
  const dStrand=bestLag*UB;                    // projected strand width, mm

  // --- 5. cylinder geometry → outer strand count ---
  const nOuter=Math.round(Math.PI*(D-dStrand)/dStrand);
  let layer=null, total=null, label=null;
  if(nOuter>=4 && nOuter<=8){ layer='o6'; total=7;  label='6 outer + core (7-strand class: 7-wire or 6/1 ACSR)'; }
  else if(nOuter>=9 && nOuter<=14){ layer='19'; total=19; label='12 outer (19-strand class: 12+6+1)'; }
  else if(nOuter>=15 && nOuter<=24){ layer='37'; total=37; label='18 outer (37-strand class: 18+12+6+1)'; }
  if(!layer) return null;
  const angleDeg=Math.abs(90-Math.abs(phi*180/Math.PI));  // band angle vs the axis
  return { strandW:+dStrand.toFixed(2), nOuter, total, layer, label,
           angleDeg:+angleDeg.toFixed(1), coherence:+coher.toFixed(2), strength:+best.toFixed(2) };
}

/* classify material from two manual edge taps */
export function materialFromEdges(shot, edges){
  const ctx=shot.getContext("2d"), imgW=shot.width, imgH=shot.height;
  const a=edges[0], b=edges[1]; let R=0,G=0,B=0,n=0;
  for(let t=0.25;t<=0.75;t+=0.1){
    const x=Math.round(a.x+(b.x-a.x)*t), y=Math.round(a.y+(b.y-a.y)*t);
    for(let dx=-2;dx<=2;dx++) for(let dy=-2;dy<=2;dy++){
      const px2=Math.min(Math.max(x+dx,0),imgW-1), py=Math.min(Math.max(y+dy,0),imgH-1);
      const d=ctx.getImageData(px2,py,1,1).data; R+=d[0];G+=d[1];B+=d[2];n++; } }
  R/=n;G/=n;B/=n; const mx=Math.max(R,G,B),mn=Math.min(R,G,B),sat=mx?(mx-mn)/mx:0;
  let hue=0,dl=mx-mn; if(dl>0){ if(mx===R)hue=60*(((G-B)/dl)%6); else if(mx===G)hue=60*(((B-R)/dl)+2); else hue=60*(((R-G)/dl)+4);} if(hue<0)hue+=360;
  return { material:isCopper(sat,hue,0.299*R+0.587*G+0.114*B)?"Copper":"Aluminium", hue, sat };
}

/* ---- FAST live-preview detector (for AR overlay) ----
   Lightweight per-scan version with the same shadow-resistant rule. */
export function detectConductorLive(shot, markers){
  const imgW=shot.width, imgH=shot.height;
  const Hinv=homography(CARD, markers);
  const ctx=shot.getContext("2d");
  const img=ctx.getImageData(0,0,imgW,imgH).data;
  const px=(ix,iy)=>{ ix|=0; iy|=0; if(ix<0||iy<0||ix>=imgW||iy>=imgH) return null;
    const o=(iy*imgW+ix)*4; return [img[o],img[o+1],img[o+2]]; };
  const toImg=(X,Y)=>applyH(Hinv,{x:X,y:Y});
  const med=a=>{ const s=[...a].sort((u,v)=>u-v); return s[s.length>>1]; };
  const STEP=0.18, GAP=Math.round(1.6/STEP);
  const ys=[]; for(let y=20;y>=-20;y-=STEP) ys.push(y); const N=ys.length;
  const widths=[], topPts=[], botPts=[];
  let rs=0,gs=0,bs=0,ns=0;
  for(let x=-48;x<=48;x+=7){
    const L=new Float32Array(N), ok=new Uint8Array(N), R=new Float32Array(N),G=new Float32Array(N),B=new Float32Array(N);
    for(let i=0;i<N;i++){ const p=toImg(x,ys[i]),c=px(p.x,p.y);
      if(!c){ok[i]=0;continue;} ok[i]=1; R[i]=c[0];G[i]=c[1];B[i]=c[2]; L[i]=0.299*c[0]+0.587*c[1]+0.114*c[2]; }
    // light texture (3-sample span)
    const tex=new Float32Array(N);
    for(let i=1;i<N-1;i++){ if(ok[i-1]&&ok[i]&&ok[i+1])
      tex[i]=Math.abs(L[i+1]-L[i-1])+Math.abs(2*L[i]-L[i-1]-L[i+1]); }
    const oL=[],oR=[],oG=[],oB=[];
    for(let i=0;i<N;i++) if(ok[i]&&Math.abs(ys[i])>14){ oL.push(L[i]); oR.push(R[i]); oG.push(G[i]); oB.push(B[i]); }
    if(oL.length<6) continue;
    const Lp=med(oL), Rp=med(oR), Gp=med(oG), Bp=med(oB);
    let v=0;for(const l of oL) v+=(l-Lp)*(l-Lp); const sigma=Math.sqrt(v/oL.length);
    const Tlum=Math.max(10,2.6*sigma);
    const sP=(Rp+Gp+Bp)||1, rp=Rp/sP, gp=Gp/sP;
    const isObj=i=>{
      if(!ok[i]) return false;
      const dl=L[i]-Lp;
      if(dl>Tlum) return true;
      const s=(R[i]+G[i]+B[i])||1;
      if((Math.abs(R[i]/s-rp)+Math.abs(G[i]/s-gp))*510>26) return true;
      if(dl<-Tlum && tex[i]>14) return true;
      if(L[i]<Lp*0.40) return true;
      return false;
    };
    let bestLo=-1,bestHi=-1,bestLen=-1,i=0;
    while(i<N){ if(isObj(i)){let lo=i,hi=i,gap=0,j=i+1;
      while(j<N){if(isObj(j)){hi=j;gap=0;}else if(++gap>GAP)break;j++;}
      if(hi-lo>bestLen){bestLen=hi-lo;bestLo=lo;bestHi=hi;} i=hi+1;} else i++; }
    if(bestLo<0) continue;
    const yT=ys[bestLo],yB=ys[bestHi],w=yT-yB,cen=(yT+yB)/2;
    if(w>0.8&&w<24&&Math.abs(cen)<16){ widths.push(w); topPts.push({x,y:yT}); botPts.push({x,y:yB});
      const m=toImg(x,cen),c=px(m.x,m.y); if(c){rs+=c[0];gs+=c[1];bs+=c[2];ns++;} }
  }
  if(widths.length<3) return null;
  const dia=med(widths);
  let matHint="Aluminium";
  if(ns){ const Rr=rs/ns,Gg=gs/ns,Bb=bs/ns,mx=Math.max(Rr,Gg,Bb),mn=Math.min(Rr,Gg,Bb),S=mx?(mx-mn)/mx:0;
    let h=0,d=mx-mn; if(d>0){if(mx===Rr)h=60*(((Gg-Bb)/d)%6);else if(mx===Gg)h=60*(((Bb-Rr)/d)+2);else h=60*(((Rr-Gg)/d)+4);}if(h<0)h+=360;
    if(isCopper(S,h,0.299*Rr+0.587*Gg+0.114*Bb)) matHint="Copper"; }
  let bi=0,bd=1e9;for(let i=0;i<topPts.length;i++){const dd=Math.abs(topPts[i].x);if(dd<bd){bd=dd;bi=i;}}
  const calA=toImg(topPts[bi].x,topPts[bi].y),calB=toImg(botPts[bi].x,botPts[bi].y);
  return {dia,matHint,calA,calB,topPts,botPts,Hinv,nScans:widths.length};
}

/* ---- strand counting from a cross-section (end-on) photo ---- */
export function countStrands(canvas, cx, cy, cropRadius){
  const ctx=canvas.getContext("2d");
  const r=Math.round(cropRadius), d=r*2;
  const x0=Math.max(0,Math.round(cx)-r), y0=Math.max(0,Math.round(cy)-r);
  const w=Math.min(d, canvas.width-x0), h=Math.min(d, canvas.height-y0);
  if(w<20||h<20) return null;
  const id=ctx.getImageData(x0,y0,w,h).data;
  const gray=new Uint8Array(w*h); const hist=new Array(256).fill(0);
  for(let i=0;i<w*h;i++){ const g=(id[i*4]*0.299+id[i*4+1]*0.587+id[i*4+2]*0.114)|0; gray[i]=g; hist[g]++; }
  let sum=0; for(let i=0;i<256;i++) sum+=i*hist[i];
  let sB=0,wB=0,wF=0,mx=0,th=128,tot=w*h;
  for(let i=0;i<256;i++){ wB+=hist[i]; if(!wB)continue; wF=tot-wB; if(!wF)break;
    sB+=i*hist[i]; const mB=sB/wB,mF=(sum-sB)/wF,v=wB*wF*(mB-mF)*(mB-mF); if(v>mx){mx=v;th=i;} }
  const mask=new Uint8Array(w*h);
  for(let i=0;i<w*h;i++) mask[i]=gray[i]>=th?1:0;
  const cxL=w/2, cyL=h/2, rr=Math.min(w,h)/2*0.92;
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    if(Math.hypot(x-cxL,y-cyL)>rr) mask[y*w+x]=0; }
  const lab=new Int32Array(w*h); let next=1; const blobs=[]; const stack=[];
  for(let i=0;i<w*h;i++){
    if(mask[i] && !lab[i]){ const id2=next++; let area=0,sx=0,sy=0,mnx=w,mxx=0,mny=h,mxy=0;
      stack.push(i); lab[i]=id2;
      while(stack.length){ const p=stack.pop(), px2=p%w, py=(p/w)|0;
        area++; sx+=px2; sy+=py; if(px2<mnx)mnx=px2; if(px2>mxx)mxx=px2; if(py<mny)mny=py; if(py>mxy)mxy=py;
        for(const q of [p-1,p+1,p-w,p+w]){ if(q<0||q>=w*h)continue; if(Math.abs((q%w)-px2)>1)continue;
          if(mask[q]&&!lab[q]){ lab[q]=id2; stack.push(q); } } }
      const bw=mxx-mnx+1, bh=mxy-mny+1;
      blobs.push({area, cx:sx/area+x0, cy:sy/area+y0, w:bw, h:bh, fill:area/(bw*bh),
        ar:Math.min(bw,bh)/Math.max(bw,bh)}); }
  }
  const totalArea=Math.PI*rr*rr;
  const minA=totalArea*0.015, maxA=totalArea*0.35;
  const strands=blobs.filter(b=>b.area>minA && b.area<maxA && b.fill>0.55 && b.ar>0.45);
  if(strands.length<2) return null;
  let avgBright=0; strands.forEach(b=>{ let s=0,n=0;
    for(let dy=-3;dy<=3;dy++) for(let dx=-3;dx<=3;dx++){
      const ix=Math.round(b.cx-x0+dx), iy=Math.round(b.cy-y0+dy);
      if(ix>=0&&iy>=0&&ix<w&&iy<h){ s+=gray[iy*w+ix]; n++; } }
    b.bright=n?s/n:128; avgBright+=b.bright; });
  avgBright/=strands.length;
  strands.sort((a,b)=>Math.hypot(a.cx-cx,a.cy-cy)-Math.hypot(b.cx-cx,b.cy-cy));
  const center=strands[0];
  const hasSteel = center.bright < avgBright*0.88;
  const strandCount=strands.length;
  let construction=strandCount+"wire";
  if(hasSteel){
    if(strandCount<=8) construction="6/1 ACSR";
    else if(strandCount<=20) construction="18/1 or 12/7 ACSR";
    else construction=strandCount+"wire ACSR";
  } else {
    if(strandCount<=8) construction="7-wire AAC/Cu";
    else if(strandCount<=20) construction="19-wire";
    else construction=strandCount+"-wire";
  }
  return { count:strandCount, hasSteel, construction, strands:strands.map(s=>({x:s.cx,y:s.cy,area:s.area})) };
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
    x.lineWidth=lw*1.3; x.strokeStyle="#05C489"; x.lineJoin="round";
    [det.topPts,det.botPts].forEach(pts=>{ x.beginPath();
      pts.forEach((p,i)=>{ const q=applyH(Hinv,{x:p.x,y:p.y}); i?x.lineTo(q.x,q.y):x.moveTo(q.x,q.y); }); x.stroke(); });
  }
  const A=det.calA, B=det.calB;
  const dx=B.x-A.x, dy=B.y-A.y, len=Math.hypot(dx,dy)||1, ux=dx/len, uy=dy/len, tk=lw*7;
  x.lineWidth=lw*1.8; x.strokeStyle="#FF7031"; x.lineCap="round";
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
    x.fillStyle="#05C489"; x.textBaseline="middle"; x.font="700 "+f2+"px sans-serif";
    x.fillText(banner, imgW*0.04, imgH-bh*0.5);
  }
}
