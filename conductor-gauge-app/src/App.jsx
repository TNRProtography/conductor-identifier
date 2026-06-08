import React, { useEffect, useRef, useState, useCallback } from 'react'
import { TABLE } from './lib/conductors.js'
import { applyVerified, confirmMeasurement, loadVerified } from './lib/learning.js'
import {
  CARD, MARKER_PROMPTS, homography, applyH,
  autoMarkers, detectConductor, detectConductorLive, materialFromEdges, drawOverlay, countStrands
} from './lib/vision.js'

const stamp = () => { const d=new Date(), p=n=>String(n).padStart(2,'0')
  return d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+'_'+p(d.getHours())+p(d.getMinutes())+p(d.getSeconds()) }

function computeMatch(dia, material, det, strandInfo){
  // Enhance table with any verified (learned) diameters
  const enhanced = applyVerified(TABLE)
  let cands = enhanced.filter(c=>c.mat===material).map(c=>({ ...c, err:Math.abs(c.dia-dia) }))
  // If strand count known, filter to matching constructions
  if(strandInfo && strandInfo.count){
    const sc=strandInfo.count; const hasS=strandInfo.hasSteel;
    const strandMatch = cands.filter(c=>{
      // 6/1 ACSR = 7 strands with steel; 7-wire Cu/AAC = 7 no steel; 19-wire = 19; 37-wire = 37
      const code=c.cons||''; const n=parseInt(code); const type=c.type||'';
      if(sc<=8 && hasS && type==='ACSR') return true;
      if(sc<=8 && !hasS && type!=='ACSR') return true;
      if(sc>=17 && sc<=20) return code.startsWith('19') || type==='AAAC' || type==='AAC';
      if(sc>=35 && sc<=39) return code.startsWith('37');
      return true; // uncertain count → don't filter
    });
    if(strandMatch.length>0) cands=strandMatch;
  }
  cands.sort((a,b)=>a.err-b.err);
  const best=cands[0], margin = cands[1] ? (cands[1].err-best.err) : 99;
  let conf='low', label='Low';
  if(best.err<0.30 && margin>0.7){ conf='good'; label='High' }
  else if(best.err<0.6 && margin>0.35){ conf='med'; label='Medium' }
  // Boost confidence if verified
  if(best.verified && best.err<0.25){ conf='good'; label='High (verified)' }
  const src = (det && det.topPts) ? `Measured across ${det.nScans} scan lines.` : 'Measured from edge taps.'
  return { dia, best, cands:cands.slice(0,4), conf, label, margin, src, material }
}

export default function App(){
  const [screen,setScreen]   = useState('intro')   // intro | camera | measure | result
  const [phase,setPhase]     = useState('markers')  // manual fallback
  const [markers,setMarkers] = useState([])
  const [edges,setEdges]     = useState([])
  const [material,setMaterial] = useState(null)
  const [result,setResult]   = useState(null)
  const [strandInfo,setStrandInfo] = useState(null)   // from end-on strand counting
  const [strandMode,setStrandMode] = useState(false) // true = next capture is for strand counting
  const [cameras,setCameras] = useState([])
  const [camId,setCamId]     = useState('')
  const [torch,setTorch]     = useState({capable:false,on:false})
  const [camNote,setCamNote] = useState('')
  const [instr,setInstr]     = useState({text:'',warn:false})
  const [toast,setToast]     = useState('')
  const [parallax,setParallax] = useState(true)
  const [standoff,setStandoff] = useState(250)
  const [calBar,setCalBar] = useState(100)   // measured length of the printed 100mm calibration bar
  const [canInstall,setCanInstall] = useState(false)

  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const trackRef = useRef(null)
  const shotRef = useRef(null)        // offscreen full-res canvas
  const measRef = useRef(null)        // visible canvas (measure)
  const resRef  = useRef(null)        // visible canvas (result)
  const detRef  = useRef(null)
  const diaRef  = useRef(0)
  const promptRef = useRef(null)      // beforeinstallprompt event
  const toastT = useRef(null)
  const procRef = useRef(null)       // offscreen canvas for live processing
  const overlayRef = useRef(null)    // AR overlay canvas (on top of video)
  const [liveMatch,setLiveMatch] = useState(null) // live AR detection result
  const liveT = useRef(0)           // throttle timestamp for live HUD updates

  if(!shotRef.current && typeof document!=='undefined') shotRef.current = document.createElement('canvas')
  if(!procRef.current && typeof document!=='undefined') procRef.current = document.createElement('canvas')

  const showToast = useCallback(msg=>{ setToast(msg); clearTimeout(toastT.current)
    toastT.current=setTimeout(()=>setToast(''),2400) },[])

  // install prompt capture
  useEffect(()=>{
    const h = e=>{ e.preventDefault(); promptRef.current=e; setCanInstall(true) }
    window.addEventListener('beforeinstallprompt',h)
    return ()=>window.removeEventListener('beforeinstallprompt',h)
  },[])

  /* ---------- AR LIVE OVERLAY (runs while camera is active) ---------- */
  useEffect(()=>{
    if(screen!=='camera') { setLiveMatch(null); return; }
    let running=true, busy=false;
    const proc=procRef.current, ov=overlayRef.current;
    if(!proc) return;
    function loop(){ if(!running) return; if(!busy){ busy=true; frame().finally(()=>{busy=false;}); } requestAnimationFrame(loop); }
    async function frame(){
      const v=videoRef.current; if(!v||v.readyState<2||!ov) return;
      const pw=640, ph=Math.round(640*v.videoHeight/(v.videoWidth||1));
      proc.width=pw; proc.height=ph;
      proc.getContext('2d').drawImage(v,0,0,pw,ph);
      // size overlay to match video display
      const vr=v.getBoundingClientRect(); const dpr=window.devicePixelRatio||1;
      const ow=Math.round(vr.width*dpr), oh=Math.round(vr.height*dpr);
      if(ov.width!==ow||ov.height!==oh){ ov.width=ow; ov.height=oh; ov.style.width=vr.width+'px'; ov.style.height=vr.height+'px'; }
      const ox=ov.getContext('2d'); ox.clearRect(0,0,ow,oh);
      const sx=ow/pw, sy=oh/ph;
      // detect markers
      let mk=null; try{mk=autoMarkers(proc);}catch{}
      if(mk&&mk.length===4){
        // draw marker circles + card outline
        ox.strokeStyle='#19d3a2'; ox.lineWidth=2.5*dpr;
        mk.forEach(m=>{ ox.beginPath(); ox.arc(m.x*sx,m.y*sy,10*dpr,0,7); ox.stroke(); });
        ox.beginPath(); mk.forEach((m,i)=>i?ox.lineTo(m.x*sx,m.y*sy):ox.moveTo(m.x*sx,m.y*sy));
        ox.closePath(); ox.strokeStyle='rgba(25,211,162,0.35)'; ox.lineWidth=1.5*dpr; ox.setLineDash([6*dpr,4*dpr]); ox.stroke(); ox.setLineDash([]);
        // detect conductor (fast)
        let det=null; try{det=detectConductorLive(proc,mk);}catch{}
        if(det){
          // draw edge traces
          const Hi=det.Hinv;
          ox.lineWidth=2*dpr; ox.lineJoin='round'; ox.strokeStyle='#e5007d';
          [det.topPts,det.botPts].forEach(pts=>{ox.beginPath();pts.forEach((p,i)=>{const q=applyH(Hi,{x:p.x,y:p.y});i?ox.lineTo(q.x*sx,q.y*sy):ox.moveTo(q.x*sx,q.y*sy);});ox.stroke();});
          // caliper
          const A=det.calA,B=det.calB;
          ox.lineWidth=2.5*dpr; ox.beginPath(); ox.moveTo(A.x*sx,A.y*sy); ox.lineTo(B.x*sx,B.y*sy); ox.stroke();
          // diameter label
          const fs=Math.round(14*dpr), label=det.dia.toFixed(1)+' mm';
          ox.font='700 '+fs+'px monospace'; const tw=ox.measureText(label).width;
          const tx=(A.x+B.x)/2*sx+8*dpr, ty=(A.y+B.y)/2*sy;
          ox.fillStyle='rgba(8,11,14,0.82)'; ox.fillRect(tx-3*dpr,ty-fs*0.6,tw+6*dpr,fs*1.2);
          ox.fillStyle='#fff'; ox.textBaseline='middle'; ox.fillText(label,tx,ty);
          // throttled HUD update (every 300ms)
          const now=Date.now();
          if(now-liveT.current>300){
            liveT.current=now;
            const cb=Math.max(50,calBar||100); let dia=det.dia*(cb/100);
            if(parallax){const s=Math.max(60,standoff||250); dia=dia*(s-dia/2)/s;}
            const m=computeMatch(dia,det.matHint,null,strandInfo);
            setLiveMatch({dia,name:m.best.name==='—'?m.best.cons:m.best.name,type:m.best.type,conf:m.conf,label:m.label});
          }
        } else { if(Date.now()-liveT.current>600) setLiveMatch(null); }
      } else {
        // no markers: guidance
        ox.font=`600 ${Math.round(14*dpr)}px sans-serif`; ox.fillStyle='rgba(25,211,162,0.85)'; ox.textAlign='center';
        ox.fillText('Point at the marker card',ow/2,oh-30*dpr);
        if(Date.now()-liveT.current>600) setLiveMatch(null);
      }
    }
    const tid=setTimeout(loop,400);
    return ()=>{ running=false; clearTimeout(tid); };
  },[screen,calBar,parallax,standoff,strandInfo])

  /* ---------- camera ---------- */
  // manual toggle (single attempt)
  const tryTorch = useCallback(async (on)=>{
    const track=trackRef.current; if(!track) return false
    const caps = track.getCapabilities ? track.getCapabilities() : {}
    if(('torch' in caps) && !caps.torch){
      setTorch({capable:false,on:false})
      setCamNote("This camera/browser can't control the flash (e.g. iPhone Safari). Use bright lighting.")
      return false
    }
    try{ await track.applyConstraints({advanced:[{torch:on}]}); setTorch({capable:true,on}); if(on) setCamNote(''); return true }
    catch{ setTorch({capable:false,on:false})
      setCamNote("Flash didn't respond — tap ⚡ to retry, or use bright light (iPhone Safari can't fire it from the web).")
      return false }
  },[])

  // auto-enable with retries (capabilities/torch often aren't ready immediately)
  const enableTorch = useCallback(async ()=>{
    const track=trackRef.current; if(!track) return
    for(let attempt=0; attempt<4; attempt++){
      const caps = track.getCapabilities ? track.getCapabilities() : {}
      if(('torch' in caps) && !caps.torch){
        setTorch({capable:false,on:false})
        setCamNote("This camera/browser can't control the flash (e.g. iPhone Safari). Use bright lighting.")
        return
      }
      try{ await track.applyConstraints({advanced:[{torch:true}]}); setTorch({capable:true,on:true}); setCamNote(''); return }
      catch{ await new Promise(r=>setTimeout(r, 300*(attempt+1))) }
    }
    setTorch({capable:false,on:false})
    setCamNote("Flash didn't respond automatically — tap the ⚡ button to try again, or use bright light.")
  },[])

  const populateCameras = useCallback(async ()=>{
    try{
      const devs = await navigator.mediaDevices.enumerateDevices()
      const cams = devs.filter(d=>d.kind==='videoinput')
      setCameras(cams.map((c,i)=>({id:c.deviceId,label:c.label||`Camera ${i+1}`})))
      const cur = trackRef.current?.getSettings?.().deviceId
      if(cur) setCamId(cur)
    }catch{}
  },[])

  const startCamera = useCallback(async (deviceId)=>{
    const video = deviceId
      ? { deviceId:{exact:deviceId}, width:{ideal:1920}, height:{ideal:1080} }
      : { facingMode:{ideal:'environment'}, width:{ideal:1920}, height:{ideal:1080} }
    if(streamRef.current){ streamRef.current.getTracks().forEach(t=>t.stop()) }
    let stream
    try{ stream = await navigator.mediaDevices.getUserMedia({video,audio:false}) }
    catch{
      try{ stream = await navigator.mediaDevices.getUserMedia({video:true,audio:false}) }
      catch(err){ setCamNote('Camera access failed: '+err.message+'. The app must be served over HTTPS and granted camera permission.'); setScreen('camera'); return }
    }
    streamRef.current=stream; trackRef.current=stream.getVideoTracks()[0]
    setScreen('camera')
    setTimeout(async ()=>{
      const v=videoRef.current; if(!v) return
      v.srcObject=stream
      v.onplaying = ()=>{ enableTorch() }    // fire flash once frames are actually flowing
      await v.play().catch(()=>{})
      populateCameras()
      setTimeout(enableTorch, 500)            // fallback if 'playing' didn't fire
    },30)
  },[populateCameras,enableTorch])

  /* ---------- saving ---------- */
  const savePhoto = useCallback((canvas, prefix)=>{
    canvas.toBlob(async (blob)=>{
      if(!blob){ showToast("Couldn't save photo"); return }
      const fname=`${prefix||'conductor'}_${stamp()}.jpg`
      const file=new File([blob],fname,{type:'image/jpeg'})
      if(navigator.canShare && navigator.canShare({files:[file]})){
        try{ await navigator.share({files:[file],title:fname}); showToast('Photo saved'); return }
        catch(e){ if(e && e.name==='AbortError') return }
      }
      const url=URL.createObjectURL(blob); const a=document.createElement('a')
      a.href=url; a.download=fname; document.body.appendChild(a); a.click(); a.remove()
      setTimeout(()=>URL.revokeObjectURL(url),5000); showToast('Photo saved to your device')
    },'image/jpeg',0.92)
  },[showToast])

  /* ---------- analysis ---------- */
  const finalize = useCallback((det)=>{
    let dia=det.dia
    const cb = Math.max(50, calBar||100)
    dia = dia * (cb/100)                       // print-scale correction from the calibration bar
    if(parallax){ const s=Math.max(60,standoff||250); dia=dia*(s-dia/2)/s }
    detRef.current=det; diaRef.current=dia
    const mat=det.matHint||material||'Aluminium'
    setMaterial(mat)
    setResult(computeMatch(dia,mat,det,strandInfo))
    setScreen('result')
  },[parallax,standoff,calBar,material,strandInfo])

  const runAuto = useCallback((mk)=>{
    const shot=shotRef.current
    let det=null; try{ det=detectConductor(shot,mk) }catch{}
    if(det){ showToast('Conductor found & measured'); finalize(det); return true }
    return false
  },[finalize,showToast])

  const tryFullAuto = useCallback(()=>{
    const shot=shotRef.current
    let mk=null; try{ mk=autoMarkers(shot) }catch{}
    if(mk && mk.length===4){
      setMarkers(mk)
      if(runAuto(mk)) return
      setPhase('edges'); setEdges([]); setMaterial(null)
      setInstr({warn:true,text:"Found the card, but couldn't locate the conductor (lighting/contrast). Tap its two edges, or Undo to fix the markers."})
      setScreen('measure'); return
    }
    setMarkers([]); setPhase('markers')
    setInstr({warn:true,text:'Couldn\u2019t find the card markers automatically. Tap the four marker centres \u2014 the conductor is then measured automatically.'})
    setScreen('measure')
  },[runAuto])

  /* ---------- capture ---------- */
  const capture = useCallback(()=>{
    const v=videoRef.current; if(!v || !v.videoWidth) return
    const shot=shotRef.current; shot.width=v.videoWidth; shot.height=v.videoHeight
    shot.getContext('2d').drawImage(v,0,0,shot.width,shot.height)
    if(streamRef.current){ streamRef.current.getTracks().forEach(t=>t.stop()); streamRef.current=null; trackRef.current=null }
    setMarkers([]); setEdges([]); setMaterial(null); setPhase('markers'); setResult(null)
    setScreen('measure')
    savePhoto(shot,'conductor')
    if(strandMode){
      // strand counting mode: user taps the centre of the conductor cross-section
      setInstr({text:'Tap the CENTRE of the conductor cross-section. The app will count the strands.', warn:false})
    } else {
      setTimeout(tryFullAuto,60)
    }
  },[savePhoto,tryFullAuto])

  /* ---------- measure-screen taps & drawing ---------- */
  const onTap = useCallback((ev)=>{
    const cv=measRef.current, shot=shotRef.current; if(!cv||!shot) return
    setInstr({text:'',warn:false})
    const r=cv.getBoundingClientRect()
    const x=(ev.clientX-r.left)*(shot.width/r.width)
    const y=(ev.clientY-r.top)*(shot.height/r.height)
    if(strandMode){
      // strand counting: run counter at the tapped centre
      const cropR=Math.min(shot.width,shot.height)*0.25; // crop ~quarter of shorter dim
      const si=countStrands(shot, x, y, cropR);
      setStrandMode(false);
      if(si){ setStrandInfo(si); showToast(si.count+' strands detected → '+si.construction);
        // re-compute match with strand info, return to result
        if(diaRef.current>0) setResult(computeMatch(diaRef.current, material||'Aluminium', detRef.current, si));
        setScreen('result'); }
      else { showToast("Couldn't count strands — try a clearer close-up of the cut end"); setScreen('result'); }
      return;
    }
    if(phase==='markers'){
      if(markers.length<4) setMarkers([...markers,{x,y}])
    } else {
      if(edges.length<2){ const ne=[...edges,{x,y}]; setEdges(ne)
        if(ne.length===2){ const m=materialFromEdges(shot,ne); setMaterial(m.material) } }
    }
  },[phase,markers,edges,strandMode,material,showToast])

  // draw shot + dots whenever measure state changes
  useEffect(()=>{
    if(screen!=='measure') return
    const cv=measRef.current, shot=shotRef.current; if(!cv||!shot) return
    cv.width=shot.width; cv.height=shot.height
    const x=cv.getContext('2d'); x.drawImage(shot,0,0)
    // dots are drawn as DOM overlay below; just keep the image here
  },[screen,markers,edges])

  // draw result overlay
  useEffect(()=>{
    if(screen!=='result' || !result) return
    const cv=resRef.current, shot=shotRef.current; if(!cv||!shot) return
    cv.width=shot.width; cv.height=shot.height
    drawOverlay(cv.getContext('2d'), shot, detRef.current, diaRef.current, markers, null)
  },[screen,result,markers])

  const undo = ()=>{
    setInstr({text:'',warn:false})
    if(phase==='edges'){ if(edges.length){ setEdges(edges.slice(0,-1)); setMaterial(null) } else setPhase('markers') }
    else { if(markers.length) setMarkers(markers.slice(0,-1)) }
  }
  const nextAction = ()=>{
    if(phase==='markers'){ if(markers.length===4){ if(!runAuto(markers)){ setPhase('edges'); setEdges([]); setMaterial(null)
      setInstr({warn:true,text:'Couldn\u2019t locate the conductor automatically \u2014 tap its two edges manually.'}) } } }
    else { if(edges.length===2 && material){
      const H=homography(markers,CARD), a=applyH(H,edges[0]), b=applyH(H,edges[1])
      finalize({ dia:Math.hypot(a.x-b.x,a.y-b.y), matHint:material, calA:edges[0], calB:edges[1], topPts:null }) } }
  }
  const overrideMaterial = (m)=>{ setMaterial(m); setResult(computeMatch(diaRef.current,m,detRef.current,strandInfo)) }
  const saveResult = ()=>{
    const shot=shotRef.current; const c=document.createElement('canvas'); c.width=shot.width; c.height=shot.height
    const banner = result ? `${result.best.name==='\u2014'?result.best.cons:result.best.name}  \u00b7  ${result.best.type}  \u00b7  ${result.best.csa} mm\u00b2  \u00b7  ${result.label} confidence` : ''
    drawOverlay(c.getContext('2d'), shot, detRef.current, diaRef.current, markers, banner)
    savePhoto(c,'conductor_result')
  }
  const installApp = async ()=>{ const p=promptRef.current; if(!p) return; p.prompt(); await p.userChoice; promptRef.current=null; setCanInstall(false) }

  // marker/edge instruction text for the measure screen
  const measInstr = ()=>{
    if(instr.text) return instr
    if(phase==='markers'){ const n=markers.length
      return { warn:false, text: n<4
        ? `Tap the centre of the ${MARKER_PROMPTS[n]} (${n+1} of 4). The conductor is then measured automatically.`
        : 'Four markers set. Tap ANALYSE to measure the conductor.' } }
    const n=edges.length
    return { warn:false, text: n<2 ? `Tap the two opposite edges of the conductor (${n+1} of 2).` : 'Edges set. Confirm material, then COMPUTE.' }
  }
  const iv = measInstr()
  const chip = m => m==='Copper' ? 'cu' : 'al'
  const shotScale = ()=>{ const cv=measRef.current; const shot=shotRef.current
    if(!cv||!shot) return 1; const r=cv.getBoundingClientRect(); return r.width/shot.width }

  return (
    <>
      <header>
        <svg className="logo" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="#e5007d" strokeWidth="2"/><circle cx="12" cy="12" r="3.4" fill="#19d3a2"/><path d="M12 1v3M12 20v3M1 12h3M20 12h3" stroke="#19d3a2" strokeWidth="2"/></svg>
        <div><h1>Conductor Gauge</h1><div className="sub">camera sizing</div></div>
      </header>

      <main>
        {screen==='intro' && (
          <>
            <div className="card">
              <h2>What this does</h2>
              <p>Identifies a stranded conductor from a photo, by measuring its diameter against the printed <strong>marker card</strong> and reading its colour. Print the card at 100%, lay the conductor along the clear channel, and shoot from directly above with the whole card in frame.</p>
              <button className="btn" onClick={()=>startCamera()}>Start camera</button>
            </div>
            {canInstall && <button className="btn ghost" onClick={installApp}>⤓ Install app</button>}
            <div className="note warn">Decision-support prototype. Confirm a critical size with calipers or the printed cable marking before relying on it.</div>
          </>
        )}

        {screen==='camera' && (
          <>
            <div className="stage" style={{position:'relative'}}>
              <video ref={videoRef} playsInline autoPlay muted/>
              <canvas ref={overlayRef} style={{position:'absolute',top:0,left:0,width:'100%',height:'100%',pointerEvents:'none'}}/>
              <button className={'flashbtn'+(torch.on?' on':'')} onClick={()=>tryTorch(!torch.on)}>
                <span>⚡</span><span>{torch.on?'Flash ON':'Flash'}</span>
              </button>
              {liveMatch ? (
                <div className="hud" style={{textAlign:'center'}}>
                  <b style={{fontSize:18,color:'#e5007d'}}>{liveMatch.dia.toFixed(1)} mm</b>
                  <span style={{margin:'0 8px',color:'#19d3a2'}}>&rarr;</span>
                  <b style={{color:'#19d3a2'}}>{liveMatch.name}</b>
                  <span style={{marginLeft:6,fontSize:10,opacity:0.7}}>{liveMatch.type}</span>
                  <span className={'pill '+(liveMatch.conf)} style={{marginLeft:8,fontSize:9,padding:'3px 7px'}}>{liveMatch.label}</span>
                </div>
              ) : (
                <div className="hud">Fit the <b>whole card</b> in frame &middot; conductor in the clear channel</div>
              )}
            </div>
            <div className="cambar">
              <label>Cam</label>
              <select value={camId} onChange={e=>{ setCamId(e.target.value); startCamera(e.target.value) }}>
                {cameras.length===0 && <option>Default camera</option>}
                {cameras.map(c=><option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </div>
            <button className="btn" onClick={capture}>📸 Take photo &amp; analyse</button>
            {camNote && <div className="note warn">{camNote}</div>}
          </>
        )}

        {screen==='measure' && (
          <>
            <div className="step-tags">
              <div className={'tag'+(phase==='markers'?' active':(markers.length===4?' done':''))}>1 · Card</div>
              <div className={'tag'+(phase==='edges'?' active':(edges.length===2?' done':''))}>2 · Conductor</div>
              <div className="tag">3 · Result</div>
            </div>
            <div className="stage">
              <canvas ref={measRef} className="tap" onClick={onTap}/>
              <div className="overlay">
                {markers.map((p,i)=><div key={'m'+i} className="dot" style={{left:p.x*shotScale()+'px', top:p.y*shotScale()+'px'}}/>)}
                {edges.map((p,i)=><div key={'e'+i} className="dot edge" style={{left:p.x*shotScale()+'px', top:p.y*shotScale()+'px'}}/>)}
              </div>
            </div>
            <div className={'note'+(iv.warn?' warn':'')}>{iv.text}</div>
            <div className="row">
              <button className="btn ghost mini" onClick={undo}
                disabled={phase==='markers' && markers.length===0}>Undo</button>
              <button className="btn ghost mini" onClick={tryFullAuto}>Auto-find</button>
            </div>
            {phase==='edges' && edges.length===2 && (
              <div className="card">
                <h2>Material</h2>
                <div className="seg">
                  {['Copper','Aluminium'].map(m=>
                    <button key={m} className={material===m?'on':''} onClick={()=>setMaterial(m)}>{m}</button>)}
                </div>
              </div>
            )}
            <button className="btn" onClick={nextAction}
              disabled={ phase==='markers' ? markers.length!==4 : (edges.length!==2 || !material) }>
              { phase==='markers' ? 'Analyse conductor →' : 'Compute' }
            </button>
            <button className="btn ghost" onClick={()=>startCamera()}>Retake photo</button>
            <details>
              <summary>Advanced · parallax &amp; scale</summary>
              <div className="field"><label>Measured calibration-bar length (mm)</label>
                <input type="number" value={calBar} min={50} step={0.5} onChange={e=>setCalBar(parseFloat(e.target.value)||100)}/></div>
              <p style={{fontSize:11}}>Measure the printed 100&nbsp;mm bar with a ruler and enter its actual length. Corrects for printers that scale the page (the usual cause of an over-sized reading).</p>
              <div className="field"><label>Camera standoff (mm)</label>
                <input type="number" value={standoff} min={60} step={10} onChange={e=>setStandoff(parseFloat(e.target.value)||250)}/></div>
              <div className="field"><label>Correct for conductor sitting above paper</label>
                <input type="checkbox" checked={parallax} onChange={e=>setParallax(e.target.checked)}/></div>
              <p style={{fontSize:11}}>The conductor's top sits ~one radius above the marker plane, so it looks slightly larger. This subtracts that bias.</p>
            </details>
          </>
        )}

        {screen==='result' && result && (
          <>
            <div className="stage"><canvas ref={resRef}/></div>
            <div className="card">
              <h2>Measured diameter</h2>
              <div className="readout">{result.dia.toFixed(2)}<small> mm</small></div>
            </div>
            <div className="card">
              <h2>Best match</h2>
              <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:6,flexWrap:'wrap'}}>
                <span className="matchname">{result.best.name==='—'?result.best.cons:result.best.name}</span>
                <span className={'pill '+result.conf}>{result.label} confidence</span>
                {result.best.est && <span className="pill med" style={{fontSize:9}}>Ø estimated</span>}
              </div>
              <div className="kv"><span>Construction</span><span className="mono">{result.best.type}{result.best.cons && result.best.cons!==result.best.name ? '  ·  '+result.best.cons : ''}</span></div>
              <div className="kv"><span>Material</span><span className="mono"><span className={'matchip '+chip(result.best.mat)}/>{result.best.mat}</span></div>
              <div className="kv"><span>Cross-sectional area</span><span className="mono">{result.best.csa} mm²</span></div>
              <div className="kv"><span>Nominal Ø / measured</span><span className="mono">{result.best.dia.toFixed(2)}{result.best.est?' (est)':''} / {result.dia.toFixed(2)} mm</span></div>
              <div style={{marginTop:12}}>
                <div className="sub" style={{fontSize:10,color:'var(--dim)',letterSpacing:'.12em',textTransform:'uppercase',marginBottom:6}}>Material wrong? Override:</div>
                <div className="seg">
                  {['Copper','Aluminium'].map(m=>
                    <button key={m} className={result.material===m?'on':''} onClick={()=>overrideMaterial(m)}>{m}</button>)}
                </div>
              </div>
            </div>
            <div className="card">
              <h2>Candidates (same material)</h2>
              {result.cands.map((c,i)=>(
                <div key={i} className={'cand'+(i===0?' top':'')}>
                  <span className="nm"><span className={'matchip '+chip(c.mat)}/>{c.name==='—'?(c.type+' '+c.cons):(c.name+' · '+c.type)}</span>
                  <span className="d">Ø{c.dia.toFixed(2)}{c.est?'*':''} · Δ{c.err.toFixed(2)} mm · {c.csa}mm²</span>
                </div>
              ))}
            </div>
            <div className={'note'+(result.conf==='good'?'':' warn')}>
              {result.src}{' '}
              {result.conf==='good' ? 'Clear match — well clear of the next size. Still worth a caliper check for safety-critical work.'
               : result.conf==='med' ? `Neighbouring size is close (Δ ${result.margin.toFixed(2)} mm). Re-shoot squarer / with more zoom, or confirm with calipers.`
               : 'Low confidence — sits between sizes or detection was noisy. Re-shoot flatter with flash on, and verify with calipers.'}
              {result.best.est && <> <b>This conductor’s reference Ø is estimated from CSA</b> — confirm against the datasheet.</>}
            </div>
            {/* ---- CONFIRM / CORRECT identification (learns for future matches) ---- */}
            <div className="card">
              <h2>Confirm identification</h2>
              <p>Confirming builds a verified diameter database from your real conductors — future matches get more accurate.</p>
              <button className="btn" style={{marginBottom:10}} onClick={()=>{
                const nm=result.best.name==='—'?result.best.cons:result.best.name
                confirmMeasurement(nm, result.dia)
                showToast('Confirmed! '+nm+' diameter stored for future matches.') }}>
                ✓ This is {result.best.name==='—'?result.best.cons:result.best.name}
              </button>
              <p style={{fontSize:12,color:'var(--dim)'}}>Wrong? Select the correct conductor:</p>
              <select style={{width:'100%',padding:10,borderRadius:10,background:'var(--panel2)',color:'var(--ink)',border:'1px solid var(--line)',fontFamily:'inherit',fontSize:13}}
                onChange={e=>{ if(e.target.value){
                  confirmMeasurement(e.target.value, result.dia);
                  showToast('Corrected → stored under '+e.target.value);
                  // re-match with updated verified data
                  setResult(computeMatch(diaRef.current,result.material,detRef.current,strandInfo));
                  e.target.value=''; } }}>
                <option value="">— select correct conductor —</option>
                {TABLE.map(c=>{
                  const nm=c.name==='—'?c.cons:c.name;
                  return <option key={nm} value={nm}>{c.name==='—'?(c.type+' '+c.cons):(c.name+' · '+c.type+' · '+c.csa+'mm²')}</option>
                })}
              </select>
            </div>
            {/* ---- STRAND COUNT (narrow the match from a cut-end photo) ---- */}
            <div className="card">
              <h2>Count strands (optional)</h2>
              {strandInfo ? (
                <div className="note" style={{borderColor:'var(--accent2)'}}>
                  Counted <b>{strandInfo.count} strands</b> → {strandInfo.construction}.
                  {strandInfo.hasSteel && ' Steel core detected (ACSR).'}
                  <br/><button className="btn ghost mini" style={{marginTop:8}} onClick={()=>{setStrandInfo(null);
                    setResult(computeMatch(diaRef.current,result.material,detRef.current,null))}}>Clear strand count</button>
                </div>
              ) : (
                <p>Photographing the cut end and counting strands dramatically narrows the match (6/1 → ACSR, 7-wire → AAC/Cu, 19-wire, 37-wire).</p>
              )}
              <button className="btn ghost" style={{marginTop:6}} onClick={async ()=>{
                // Quick strand-count: open camera, take photo, user taps centre
                showToast('Take a close-up of the cut end, then tap the centre of the conductor')
                await startCamera()
                // The capture flow will run; when the user captures, we handle strand counting
                // by setting a flag. After capture, they tap the conductor centre on the measure screen.
                setStrandMode(true)
              }}>📐 {strandInfo ? 'Re-count strands' : 'Count strands (photo the cut end)'}</button>
            </div>
            <button className="btn" onClick={saveResult}>💾 Save photo with result</button>
            <div className="row">
              <button className="btn ghost" onClick={()=>{ setScreen('measure'); setMarkers([]); setEdges([]); setMaterial(null); setPhase('markers'); setTimeout(tryFullAuto,40) }}>Measure again</button>
              <button className="btn ghost" onClick={()=>startCamera()}>New photo</button>
            </div>
          </>
        )}
      </main>

      <footer>
        Conductor Gauge · estimates only · verify before use.<br/>
        Diameters for named aluminium conductors are estimated from CSA — refine with datasheet values.
      </footer>

      <div className={'toast'+(toast?' show':'')}>{toast}</div>
    </>
  )
}