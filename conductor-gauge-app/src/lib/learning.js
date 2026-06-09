// Learning v2 — shared verified-conductor library.
//
// Every confirmation is (1) stored locally, (2) queued and synced to the
// Cloudflare Worker so ALL users benefit. On launch the app pulls the shared
// aggregate; matching then uses, in priority order:
//   server aggregate (community, n confirmations) → local confirmations → table value.
// Fully offline-tolerant: no network → local data only, queue flushes later.

export const WORKER_URL = '';   // ← set to your deployed Worker URL, e.g. 'https://conductor-gauge-api.you.workers.dev'
export const API_KEY    = '';   // ← same key as `wrangler secret put API_KEY`

const KEY   = 'conductor-gauge-verified';   // local confirmations (v1 format, kept)
const AGGK  = 'cg-server-aggregate';        // cached server aggregate
const QK    = 'cg-confirm-queue';           // unsent confirmations

const enabled = () => !!(WORKER_URL && API_KEY);

/* ---------------- local store (unchanged v1 behaviour) ---------------- */
export function loadVerified(){
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}
function save(db){ try { localStorage.setItem(KEY, JSON.stringify(db)); } catch {} }

export function confirmMeasurement(name, dia){
  const db = loadVerified();
  if(!db[name]) db[name] = { dias: [], avg: 0 };
  db[name].dias.push(Math.round(dia*100)/100);
  if(db[name].dias.length > 20) db[name].dias = db[name].dias.slice(-20);
  db[name].avg = db[name].dias.reduce((a,b)=>a+b,0) / db[name].dias.length;
  save(db);
  return db;
}

/* ---------------- server aggregate ---------------- */
let serverAgg = null;
try { serverAgg = JSON.parse(localStorage.getItem(AGGK)); } catch {}

export async function syncVerified(){
  if(!enabled()) return serverAgg;
  try{
    const r = await fetch(WORKER_URL + '/api/verified', { headers: { 'x-api-key': API_KEY } });
    if(r.ok){
      serverAgg = await r.json();
      try { localStorage.setItem(AGGK, JSON.stringify(serverAgg)); } catch {}
    }
  }catch{}
  flushQueue();               // good moment to retry unsent confirmations
  return serverAgg;
}

export function getServerAggregate(){ return serverAgg; }

/* ---------------- confirm + upload ---------------- */
function loadQueue(){ try { return JSON.parse(localStorage.getItem(QK)) || []; } catch { return []; } }
function saveQueue(q){ try { localStorage.setItem(QK, JSON.stringify(q)); } catch {} }

/* Downscale the capture to a ≤1280 px JPEG for upload */
export function shotToJpeg(canvas, maxDim = 1024, quality = 0.75){
  try{
    const sc = Math.min(1, maxDim / Math.max(canvas.width, canvas.height));
    const c = document.createElement('canvas');
    c.width = Math.round(canvas.width * sc); c.height = Math.round(canvas.height * sc);
    c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality);
  }catch{ return null; }
}

/* Record a confirmation: local immediately, then queue → server (with photo). */
export function confirmConductor(name, dia, features = {}, imageDataUrl = null){
  confirmMeasurement(name, dia);                       // local, instant
  if(!enabled()) return { queued: false, local: true };
  const q = loadQueue();
  q.push({ name, dia: +(+dia).toFixed(3), features, image: imageDataUrl, ts: Date.now() });
  if(q.length > 25){                                   // cap queue size; drop photos first
    q.forEach(e => { if(q.length > 25) delete e.image; });
    while(q.length > 40) q.shift();
  }
  saveQueue(q);
  flushQueue();
  return { queued: true, local: true };
}

let flushing = false;
export async function flushQueue(){
  if(!enabled() || flushing) return;
  flushing = true;
  try{
    let q = loadQueue();
    while(q.length){
      const e = q[0];
      try{
        const r = await fetch(WORKER_URL + '/api/confirm', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
          body: JSON.stringify(e),
        });
        if(!r.ok && r.status !== 400) throw new Error('http ' + r.status);
        // 400 = malformed entry: drop it rather than blocking the queue forever
      }catch{ break; }                                  // offline / server down → retry later
      q.shift(); saveQueue(q);
    }
  } finally { flushing = false; }
}

/* ---------------- table enhancement ---------------- */
export function applyVerified(table){
  const db = loadVerified();
  return table.map(c => {
    const nm = c.name === '\u2014' ? c.cons : c.name;
    // community data first (needs ≥2 confirmations to override the table)
    const s = serverAgg && (serverAgg[nm] || serverAgg[c.cons]);
    if(s && s.n >= 2){
      return { ...c, dia: s.mean, est: false, verified: true, verifiedCount: s.n, community: true };
    }
    // then this device's own confirmations
    const v = db[c.name] || db[c.cons];
    if(v && v.dias.length > 0){
      return { ...c, dia: v.avg, est: false, verified: true, verifiedCount: v.dias.length, community: false };
    }
    return { ...c, verified: false, verifiedCount: 0 };
  });
}

export function clearVerified(){ try { localStorage.removeItem(KEY); } catch {} }
export function exportVerified(){ return loadVerified(); }
