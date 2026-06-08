// Persists confirmed conductor identifications in localStorage.
// Each time a linesman confirms "this is Squirrel" with a measured diameter,
// we store it. Over time, the average of confirmed measurements replaces the
// table estimate for that conductor — building a verified diameter database.

const KEY = 'conductor-gauge-verified';

export function loadVerified(){
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; }
  catch{ return {}; }
}

function save(db){ try { localStorage.setItem(KEY, JSON.stringify(db)); } catch{} }

// Record a confirmed measurement: "this conductor (by name) measured dia mm"
export function confirmMeasurement(name, dia){
  const db = loadVerified();
  if(!db[name]) db[name] = { dias: [], avg: 0 };
  db[name].dias.push(Math.round(dia*100)/100);
  // keep last 20 measurements per conductor
  if(db[name].dias.length > 20) db[name].dias = db[name].dias.slice(-20);
  db[name].avg = db[name].dias.reduce((a,b)=>a+b,0) / db[name].dias.length;
  save(db);
  return db;
}

// Get the verified diameter for a conductor (or null if not yet confirmed)
export function getVerifiedDia(name){
  const db = loadVerified();
  if(db[name] && db[name].dias.length > 0) return db[name].avg;
  return null;
}

// Enhance a TABLE entry with verified diameter if available
export function applyVerified(table){
  const db = loadVerified();
  return table.map(c => {
    const v = db[c.name] || db[c.cons];   // match by name or construction code
    if(v && v.dias.length > 0){
      return { ...c, dia: v.avg, est: false, verified: true, verifiedCount: v.dias.length };
    }
    return { ...c, verified: false, verifiedCount: 0 };
  });
}

// Clear all verified data (reset)
export function clearVerified(){
  try { localStorage.removeItem(KEY); } catch{}
}

// Export raw data for backup
export function exportVerified(){
  return loadVerified();
}
