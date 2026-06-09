import React, { useEffect, useRef, useState, useCallback } from 'react'
import { TABLE } from './lib/conductors.js'
import { applyVerified, confirmMeasurement, loadVerified } from './lib/learning.js'
import {
  CARD, MARKER_PROMPTS, homography, applyH,
  autoMarkers, detectConductor, detectConductorLive, materialFromEdges, drawOverlay, countStrands
} from './lib/vision.js'

const stamp = () => { const d=new Date(), p=n=>String(n).padStart(2,'0')
  return d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+'_'+p(d.getHours())+p(d.getMinutes())+p(d.getSeconds()) }

function computeMatch(dia, material, det, strandInfo, manualStrands, stiffness){
  const enhanced = applyVerified(TABLE)
  let cands = enhanced.filter(c=>c.mat===material).map(c=>({ ...c, err:Math.abs(c.dia-dia) }))
  // Strand filter
  const sc = manualStrands || (strandInfo && strandInfo.count && String(strandInfo.count))
  const hasSt = manualStrands==='6/1' || (strandInfo && strandInfo.hasSteel && !manualStrands)
  if(sc){
    const f=cands.filter(c=>{
      const code=c.cons||'', type=c.type||''
      if(sc==='6/1'||hasSt) return type==='ACSR'
      if(sc==='7')  return code.startsWith('7/') || ['Namu','Kutu'].includes(c.name) || type==='SCAC'
      if(sc==='19') return code.startsWith('19/') || ['Rango','Weke','Helium','Iodine','Neon','Oxygen'].includes(c.name)
      if(sc==='37') return code.startsWith('37/')
      return true
    })
    if(f.length>0) cands=f
  }
  // Stiffness filter — hard filter if given
  if(stiffness){
    const sf=cands.filter(c=>c.stiffness===stiffness)
    if(sf.length>0) cands=sf
  }
  // Sort: by error first; on near-ties (<0.06mm) prefer the stiffness match
  // This prevents Namu (AAC) from always beating Squirrel (ACSR) when they share a diameter
  cands.sort((a,b)=>{
    const d=a.err-b.err
    if(Math.abs(d)<0.06 && stiffness){
      const aOk=a.stiffness===stiffness?0:1, bOk=b.stiffness===stiffness?0:1
      if(aOk!==bOk) return aOk-bOk
    }
    return d
  })
  const best=cands[0], margin=cands[1]?(cands[1].err-best.err):99
  // Detect ambiguous ties: same diameter, different conductor types (classic AAC vs ACSR)
  const TIE=0.06
  const tiedCands=cands.filter(c=>c.err<=best.err+TIE)
  const ambiguous = tiedCands.length>1 && !stiffness && !manualStrands &&
    new Set(tiedCands.map(c=>c.type)).size>1  // different types competing
  let conf='low', label='Low'
  if(ambiguous){ conf='low'; label='Ambiguous' }
  else if(best.err<0.30 && margin>0.7){ conf='good'; label='High' }
  else if(best.err<0.6 && margin>0.35){ conf='med'; label='Medium' }
  if(!ambiguous && best.verified && best.err<0.25){ conf='good'; label='High (verified)' }
  const src=(det&&det.topPts)?`Measured across ${det.nScans} scan lines.`:'Measured from edge taps.'
  return { dia, best, cands:cands.slice(0,5), conf, label, margin, src, material, ambiguous, tiedCands:tiedCands.slice(0,3) }
}


export default function App(){
  const [screen,setScreen]   = useState('intro')   // intro | camera | measure | result
  const [phase,setPhase]     = useState('markers')  // manual fallback
  const [markers,setMarkers] = useState([])
  const [edges,setEdges]     = useState([])
  const [material,setMaterial] = useState(null)
  const [result,setResult]   = useState(null)
  const [strandInfo,setStrandInfo] = useState(null)   // from end-on strand counting
  const [strandMode,setStrandMode] = useState(false)  // true = next capture is for strand counting
  const [manualStrands,setManualStrands] = useState(null) // user-selected strand count override
  const [stiffness,setStiffness] = useState(null)        // 'flexible' | 'medium' | 'stiff'
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
  const stabilityBuf = useRef([])  // last N live diameters for stability detection

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
  /* Video is hidden; each frame is drawn onto the visible canvas, then detection
     runs on the clean frame, then overlays are drawn on top. No z-index issues. */
  useEffect(()=>{
    if(screen!=='camera') { setLiveMatch(null); stabilityBuf.current=[]; return; }
    let running=true, busy=false;
    function loop(){ if(!running) return; if(!busy){ busy=true; try{frame();}catch(e){console.error('AR:',e);}finally{busy=false;} } requestAnimationFrame(loop); }
    function frame(){
      const v=videoRef.current, ov=overlayRef.current;
      if(!v||v.readyState<2||!ov) return;
      const vw=v.videoWidth, vh=v.videoHeight; if(!vw) return;
      const pw=640, ph=Math.round(640*vh/vw);
      if(ov.width!==pw||ov.height!==ph){ ov.width=pw; ov.height=ph; ov.style.aspectRatio=pw+'/'+ph; }
      const ox=ov.getContext('2d');
      // 1. draw the live video frame (clean)
      ox.drawImage(v,0,0,pw,ph);
      // 2. detect markers (autoMarkers copies to its own temp canvas internally)
      let mk=null; try{mk=autoMarkers(ov);}catch{}
      // 3. detect conductor if markers found (reads clean pixels before overlays)
      let det=null;
      if(mk&&mk.length===4){ try{det=detectConductorLive(ov,mk);}catch{} }
      // 4. draw overlays on top
      if(mk&&mk.length===4){
        ox.strokeStyle='#19d3a2'; ox.lineWidth=2;
        mk.forEach(m=>{ ox.beginPath(); ox.arc(m.x,m.y,8,0,7); ox.stroke(); });
        ox.beginPath(); mk.forEach((m,i)=>i?ox.lineTo(m.x,m.y):ox.moveTo(m.x,m.y));
        ox.closePath(); ox.strokeStyle='rgba(25,211,162,0.3)'; ox.lineWidth=1.5; ox.setLineDash([5,3]); ox.stroke(); ox.setLineDash([]);
        if(det){
          const Hi=det.Hinv;
          ox.lineWidth=2; ox.lineJoin='round'; ox.strokeStyle='#e5007d';
          [det.topPts,det.botPts].forEach(pts=>{ox.beginPath();pts.forEach((p,i)=>{const q=applyH(Hi,{x:p.x,y:p.y});i?ox.lineTo(q.x,q.y):ox.moveTo(q.x,q.y);});ox.stroke();});
          const A=det.calA,B=det.calB;
          ox.lineWidth=2.5; ox.beginPath(); ox.moveTo(A.x,A.y); ox.lineTo(B.x,B.y); ox.stroke();
          const fs=13, label=det.dia.toFixed(1)+' mm';
          ox.font='700 '+fs+'px monospace'; const tw=ox.measureText(label).width;
          const tx=(A.x+B.x)/2+6, ty=(A.y+B.y)/2;
          ox.fillStyle='rgba(8,11,14,0.82)'; ox.fillRect(tx-3,ty-fs*0.6,tw+6,fs*1.2);
          ox.fillStyle='#fff'; ox.textBaseline='middle'; ox.fillText(label,tx,ty);
        }
      } else {
        ox.font='600 14px sans-serif'; ox.fillStyle='rgba(25,211,162,0.85)'; ox.textAlign='center';
        ox.fillText('Point at the marker card',pw/2,ph-20); ox.textAlign='start';
      }
      // 5. throttled HUD + stability
      const now=Date.now();
      if(now-liveT.current<250) return;
      liveT.current=now;
      if(det){
        const cb=Math.max(50,calBar||100); let dia=det.dia*(cb/100);
        if(parallax){const s=Math.max(60,standoff||250); dia=dia*(s-dia/2)/s;}
        const buf=stabilityBuf.current; buf.push(dia); if(buf.length>8) buf.shift();
        let stable=false;
        if(buf.length>=5){ const avg=buf.reduce((a,b)=>a+b)/buf.length;
          const std=Math.sqrt(buf.reduce((a,b)=>a+(b-avg)**2,0)/buf.length); stable=std<0.18; }
        if(stable && !(liveMatch&&liveMatch.stable)) try{navigator.vibrate?.(30);}catch{}
        const m=computeMatch(dia,det.matHint,null,strandInfo,manualStrands,stiffness);
        setLiveMatch({dia,name:m.best.name==='\u2014'?m.best.cons:m.best.name,type:m.best.type,conf:m.conf,label:m.label,stable});
      } else { stabilityBuf.current=[]; setLiveMatch(null); }
    }
    const tid=setTimeout(loop,300);
    return ()=>{ running=false; clearTimeout(tid); };
  },[screen,calBar,parallax,standoff,strandInfo,liveMatch])

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

  // tap to focus
  const doFocus = useCallback(async ()=>{
    const track=trackRef.current; if(!track) return
    try{
      const caps=track.getCapabilities?track.getCapabilities():{};
      if(caps.focusMode && caps.focusMode.includes('single-shot')){
        await track.applyConstraints({focusMode:'single-shot'});
        showToast('Focusing...');
      } else if(caps.focusMode && caps.focusMode.includes('manual')){
        await track.applyConstraints({focusMode:'continuous'});
        showToast('Refocusing...');
      } else { showToast('Focus control not available in this browser'); }
    } catch{ showToast('Focus control not available'); }
  },[showToast])

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
    setResult(computeMatch(dia,mat,det,strandInfo,manualStrands,stiffness))
    setScreen('result')
  },[parallax,standoff,calBar,material,strandInfo,manualStrands,stiffness])

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
  const overrideMaterial = (m)=>{ setMaterial(m); setResult(computeMatch(diaRef.current,m,detRef.current,strandInfo,manualStrands,stiffness)) }
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
        <img src="./Primary-Logo-Light.svg" alt="Westpower" className="wp-logo-img" />
        <span className="conductor-sub">Conductor Gauge</span>
      </header>

      <main>
        {screen==='intro' && (
          <>
            <div className="card">
              <h2>What this does</h2>
              <p className="intro-lead">We keep the lights on.<br/>You keep the lines right.</p>
              <p>Lay the conductor on the <strong>marker card</strong>, point the camera, and the app measures its diameter and identifies it from the Westpower conductor database — live, on the card.</p>
              <p>Print the card at 100%, lay the conductor in the clear channel, and shoot with the whole card in frame.</p>
              <button className="btn" onClick={()=>startCamera()}>Get started</button>
            </div>
            {canInstall && <button className="btn ghost" onClick={installApp}>⤓ Install app</button>}
            <div className="note warn">Decision-support prototype. Confirm a critical size with calipers or the printed cable marking before relying on it.</div>
          </>
        )}

        {screen==='camera' && (
          <>
            {/* Video is hidden — frames drawn to the AR canvas instead, so overlays align perfectly */}
            <video ref={videoRef} playsInline autoPlay muted style={{position:'absolute',width:1,height:1,opacity:0,pointerEvents:'none'}}/>
            <div className="stage" style={{position:'relative'}}>
              <canvas ref={overlayRef} style={{display:'block',width:'100%'}}/>
              <button className={'cam-ctrl right'+(torch.on?' on':'')} onClick={()=>tryTorch(!torch.on)} style={{zIndex:3}}>
                <span>⚡</span><span>{torch.on?'Flash ON':'Flash'}</span>
              </button>
              <button className="cam-ctrl" onClick={doFocus} style={{left:10,right:'auto',zIndex:3}}>
                <span>🔍</span><span>Focus</span>
              </button>
              {liveMatch ? (
                <div className="hud" style={{textAlign:'center',zIndex:2}}>
                  <b style={{fontSize:18,color:'#e5007d'}}>{liveMatch.dia.toFixed(1)} mm</b>
                  <span style={{margin:'0 8px',color:'#19d3a2'}}>&rarr;</span>
                  <b style={{color:'#19d3a2'}}>{liveMatch.name}</b>
                  <span style={{marginLeft:6,fontSize:10,opacity:0.7}}>{liveMatch.type}</span>
                  <span className={'pill '+(liveMatch.conf)} style={{marginLeft:8,fontSize:9,padding:'3px 7px'}}>{liveMatch.label}</span>
                  {liveMatch.stable && <span className="pill good" style={{marginLeft:6,fontSize:9,padding:'3px 7px'}}>STABLE ✓</span>}
                </div>
              ) : (
                <div className="hud" style={{zIndex:2}}>Fit the <b>whole card</b> in frame &middot; conductor in the clear channel</div>
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
            {/* Ambiguity banner — shown when multiple conductor types share the same diameter */}
            {result.ambiguous && (
              <div style={{background:'rgba(255,112,49,.12)',border:'2px solid var(--accent)',borderRadius:14,padding:'16px 18px'}}>
                <div style={{fontFamily:'Poppins,sans-serif',fontWeight:700,fontSize:14,color:'var(--accent)',marginBottom:8}}>
                  ⚠ Multiple conductors match this diameter
                </div>
                <div style={{fontSize:13,color:'var(--ink)',marginBottom:12,lineHeight:1.5}}>
                  {result.tiedCands.map(c=>c.name==='\u2014'?c.cons:c.name).join(' and ')} all measure {result.dia.toFixed(2)} mm.
                  {' '}Use the <b>Stiffness</b> selector below to tell them apart.
                </div>
                <div style={{display:'flex',flexDirection:'column',gap:6}}>
                  {result.tiedCands.map((c,i)=>(
                    <div key={i} style={{background:'var(--panel2)',borderRadius:10,padding:'10px 14px',fontSize:13}}>
                      <b style={{color:'var(--ink)'}}>{c.name==='\u2014'?c.type+' '+c.cons:c.name}</b>
                      <span style={{color:'var(--dim)',marginLeft:8}}>{c.type} · {c.stiffness==='flexible'?'Flexible (bends easily)':c.stiffness==='stiff'?'Stiff (barely bends)':'Medium stiffness'}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="card">
              <h2>Measured diameter</h2>
              <div className="readout">{result.dia.toFixed(2)}<small> mm</small></div>
            </div>
            <div className="card">
              <h2>Best match</h2>
              <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:8,flexWrap:'wrap'}}>
                <span className="matchname">{result.best.name==='—'?result.best.cons:result.best.name}</span>
                <span className={'pill '+result.conf}>{result.label} confidence</span>
                {result.best.est && <span className="pill med" style={{fontSize:9}}>Ø estimated</span>}
              </div>
              {result.best.desc && (
                <div className="note" style={{marginBottom:14,borderColor:'var(--accent2)',background:'rgba(5,196,137,.07)'}}>
                  {result.best.desc}
                </div>
              )}
              <div className="kv"><span className="label">Construction</span><span className="value">{result.best.type}{result.best.cons&&result.best.cons!==result.best.name?'  ·  '+result.best.cons:''}</span></div>
              <div className="kv"><span className="label">Material</span><span className="value"><span className={'matchip '+chip(result.best.mat)}/>{result.best.mat}</span></div>
              <div className="kv"><span className="label">Cross-sectional area</span><span className="value">{result.best.csa} mm²</span></div>
              <div className="kv"><span className="label">Nominal Ø / measured</span><span className="value">{result.best.dia.toFixed(2)}{result.best.est?' (est)':''} / {result.dia.toFixed(2)} mm</span></div>
              <div style={{marginTop:14}}>
                <div style={{fontSize:10,color:'var(--dim)',letterSpacing:'.12em',textTransform:'uppercase',marginBottom:6,fontFamily:'Poppins,sans-serif',fontWeight:600}}>Material wrong? Override:</div>
                <div className="seg">
                  {['Copper','Aluminium'].map(m=>
                    <button key={m} className={result.material===m?'on':''} onClick={()=>overrideMaterial(m)}>{m}</button>)}
                </div>
              </div>
            </div>

            {/* ---- STIFFNESS FILTER ---- */}
            <div className="card">
              <h2>Stiffness</h2>
              <p style={{marginBottom:12}}>Flex the conductor by hand. Narrows the match between AAC, AAAC, and ACSR, which can look identical.</p>
              <div className="stiff-picker">
                {[
                  {v:'flexible',icon:'〰',title:'Flexible', hint:'Bends easily, droops under its weight. Typical of AAC (Namu, Kutu, Rango, Weke).'},
                  {v:'medium',  icon:'◡',title:'Medium',   hint:'Some resistance, partially holds shape. Typical of AAAC (Chlorine, Fluorine, Helium…).'},
                  {v:'stiff',   icon:'━',title:'Stiff',    hint:'Barely bends, stays straight. Typical of ACSR (steel core) and hard-drawn copper.'},
                ].map(({v,icon,title,hint})=>(
                  <button key={v} className={'stiff-btn'+(stiffness===v?' active':'')}
                    onClick={()=>{
                      const next=stiffness===v?null:v; setStiffness(next);
                      setResult(computeMatch(diaRef.current,result.material,detRef.current,strandInfo,manualStrands,next));
                    }}>
                    <span className="stiff-icon">{icon}</span>
                    <span className="stiff-text"><span className="stiff-title">{title}</span><span className="stiff-hint">{hint}</span></span>
                  </button>
                ))}
              </div>
            </div>

            {/* ---- CANDIDATES ---- */}
            <div className="card">
              <h2>All candidates{stiffness||manualStrands?' (filtered)':' (same material)'}</h2>
              {result.cands.map((c,i)=>(
                <div key={i} className={'cand'+(i===0?' top':'')}>
                  <div style={{flex:1}}>
                    <div className="nm"><span className={'matchip '+chip(c.mat)}/>{c.name==='—'?(c.type+' '+c.cons):(c.name+' · '+c.type)}</div>
                    <div className="d" style={{marginTop:2}}>Ø{c.dia.toFixed(2)}{c.est?'*':''} · Δ{c.err.toFixed(2)} mm · {c.csa} mm²</div>
                    {c.desc && <div style={{fontSize:11.5,color:'var(--dim)',marginTop:5,lineHeight:1.45}}>{c.desc}</div>}
                  </div>
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
            {/* ---- STRAND COUNT — manual override ---- */}
            <div className="card">
              <h2>Strand count</h2>
              <p style={{marginBottom:10}}>Count the strands by eye or from a cut end and select below — this narrows the match significantly.</p>
              <div className="seg strands">
                {[['?','Unknown'],['7','7-wire'],['6/1','6/1 ACSR'],['19','19-wire'],['37','37-wire']].map(([v,lbl])=>(
                  <button key={v} className={manualStrands===v?'on':''} onClick={()=>{
                    const next=manualStrands===v?null:v; setManualStrands(next);
                    setResult(computeMatch(diaRef.current,result.material,detRef.current,strandInfo,next));
                  }}>{lbl}</button>
                ))}
              </div>
              {manualStrands && manualStrands!=='?' && (
                <p style={{marginTop:8,fontSize:12}}>
                  {manualStrands==='6/1' && 'Filtering to ACSR conductors (6 Al strands + 1 steel core).'}
                  {manualStrands==='7'   && '7-wire: Cu HD, AAC (Namu/Kutu), or SCAC.'}
                  {manualStrands==='19'  && '19-wire: larger Cu HD, AAC (Rango/Weke), or AAAC.'}
                  {manualStrands==='37'  && '37-wire: Cu HD 37/.072 (95 mm²).'}
                </p>
              )}
            </div>
            {/* ---- CONFIRM / CORRECT identification ---- */}
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
              <select className="confirm-select"
                onChange={e=>{ if(e.target.value){
                  confirmMeasurement(e.target.value, result.dia);
                  showToast('Corrected → stored under '+e.target.value);
                  // re-match with updated verified data
                  setResult(computeMatch(diaRef.current,result.material,detRef.current,strandInfo,manualStrands,stiffness));
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
              <button className="btn ghost" onClick={()=>{ setScreen('measure'); setMarkers([]); setEdges([]); setMaterial(null); setPhase('markers'); setManualStrands(null); setStiffness(null); setTimeout(tryFullAuto,40) }}>Measure again</button>
              <button className="btn ghost" onClick={()=>startCamera()}>New photo</button>
            </div>
          </>
        )}
      </main>

      <footer>
        <span className="brand-foot">Westpower</span> Conductor Gauge · estimates only, verify before use.<br/>
        Named aluminium diameters estimated from CSA — confirm with datasheet.
      </footer>

      <div className={'toast'+(toast?' show':'')}>{toast}</div>
    </>
  )
}
