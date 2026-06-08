import React, { useEffect, useRef, useState, useCallback } from 'react'
import { TABLE } from './lib/conductors.js'
import {
  CARD, MARKER_PROMPTS, homography, applyH,
  autoMarkers, detectConductor, materialFromEdges, drawOverlay
} from './lib/vision.js'

const stamp = () => { const d=new Date(), p=n=>String(n).padStart(2,'0')
  return d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+'_'+p(d.getHours())+p(d.getMinutes())+p(d.getSeconds()) }

function computeMatch(dia, material, det){
  const cands = TABLE.filter(c=>c.mat===material).map(c=>({ ...c, err:Math.abs(c.dia-dia) }))
    .sort((a,b)=>a.err-b.err)
  const best=cands[0], margin = cands[1] ? (cands[1].err-best.err) : 99
  let conf='low', label='Low'
  if(best.err<0.30 && margin>0.7){ conf='good'; label='High' }
  else if(best.err<0.6 && margin>0.35){ conf='med'; label='Medium' }
  const src = (det && det.topPts) ? `Measured automatically across ${det.nScans} scan lines.` : 'Measured from your two edge taps.'
  return { dia, best, cands:cands.slice(0,4), conf, label, margin, src, material }
}

export default function App(){
  const [screen,setScreen]   = useState('intro')   // intro | camera | measure | result
  const [phase,setPhase]     = useState('markers')  // manual fallback
  const [markers,setMarkers] = useState([])
  const [edges,setEdges]     = useState([])
  const [material,setMaterial] = useState(null)
  const [result,setResult]   = useState(null)
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

  if(!shotRef.current && typeof document!=='undefined') shotRef.current = document.createElement('canvas')

  const showToast = useCallback(msg=>{ setToast(msg); clearTimeout(toastT.current)
    toastT.current=setTimeout(()=>setToast(''),2400) },[])

  // install prompt capture
  useEffect(()=>{
    const h = e=>{ e.preventDefault(); promptRef.current=e; setCanInstall(true) }
    window.addEventListener('beforeinstallprompt',h)
    return ()=>window.removeEventListener('beforeinstallprompt',h)
  },[])

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
    setResult(computeMatch(dia,mat,det))
    setScreen('result')
  },[parallax,standoff,calBar,material])

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
    setTimeout(tryFullAuto,60)
  },[savePhoto,tryFullAuto])

  /* ---------- measure-screen taps & drawing ---------- */
  const onTap = useCallback((ev)=>{
    const cv=measRef.current, shot=shotRef.current; if(!cv||!shot) return
    setInstr({text:'',warn:false})
    const r=cv.getBoundingClientRect()
    const x=(ev.clientX-r.left)*(shot.width/r.width)
    const y=(ev.clientY-r.top)*(shot.height/r.height)
    if(phase==='markers'){ if(markers.length<4) setMarkers([...markers,{x,y}]) }
    else { if(edges.length<2){ const ne=[...edges,{x,y}]; setEdges(ne)
      if(ne.length===2){ const m=materialFromEdges(shot,ne); setMaterial(m.material) } } }
  },[phase,markers,edges])

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
  const overrideMaterial = (m)=>{ setMaterial(m); setResult(computeMatch(diaRef.current,m,detRef.current)) }
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
            <div className="stage">
              <video ref={videoRef} playsInline autoPlay muted/>
              <button className={'flashbtn'+(torch.on?' on':'')} onClick={()=>tryTorch(!torch.on)}>
                <span>⚡</span><span>{torch.on?'Flash ON':'Flash'}</span>
              </button>
              <div className="hud">Fit the <b>whole card</b> in frame &middot; conductor in the clear channel</div>
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