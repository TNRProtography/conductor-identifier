// Conductor Gauge — shared learning API (Cloudflare Worker)
//
// Storage (FREE TIER ONLY — no R2 required):
//   KV  (binding: KV)  — confirmation records, rolling aggregate, AND photos
//   KV free tier: 1 GB storage, 1k writes/day → ~9,000 photos at ~100 KB each,
//   ~300 confirmations/day. Plenty for a field crew.
//
// Endpoints (all require header  x-api-key: <API_KEY secret>):
//   GET  /api/verified           → aggregate per conductor:
//                                  { "Squirrel": {n, mean, sd, layers:{o6:12}, lastTs}, ... }
//   POST /api/confirm            → body JSON:
//                                  { name, dia, features?:{layer,ridge,strandW,layPeriod,
//                                    material,stiffness,manualStrands,covered,tilt,bow},
//                                    image?: "data:image/jpeg;base64,..." }
//   GET  /api/records?name=X     → raw records for one conductor (audit/export)
//   GET  /api/image/<key>        → stored photo (for review tooling)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type,x-api-key',
};
const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', ...CORS } });

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);

    // auth — shared key (internal tool)
    if (req.headers.get('x-api-key') !== env.API_KEY)
      return json({ error: 'unauthorised' }, 401);

    try {
      /* ---------- GET /api/verified — the shared library ---------- */
      if (url.pathname === '/api/verified' && req.method === 'GET') {
        const agg = (await env.KV.get('aggregate', 'json')) || {};
        const out = {};
        for (const [name, a] of Object.entries(agg)) {
          const mean = a.n ? a.sum / a.n : 0;
          const sd = a.n > 1 ? Math.sqrt(Math.max(0, a.sum2 / a.n - mean * mean)) : 0;
          out[name] = { n: a.n, mean: +mean.toFixed(3), sd: +sd.toFixed(3), layers: a.layers || {}, lastTs: a.lastTs || null };
        }
        return json(out);
      }

      /* ---------- POST /api/confirm — record a verified identification ---------- */
      if (url.pathname === '/api/confirm' && req.method === 'POST') {
        const body = await req.json();
        const name = String(body.name || '').slice(0, 60);
        const dia = Number(body.dia);
        if (!name || !isFinite(dia) || dia < 0.5 || dia > 40)
          return json({ error: 'invalid name/dia' }, 400);

        const id = crypto.randomUUID();
        const ts = Date.now();

        // photo → KV as binary (optional, JPEG data URL, capped at ~1.5 MB)
        let imgKey = null;
        if (typeof body.image === 'string' && body.image.startsWith('data:image/jpeg;base64,')) {
          const b64 = body.image.slice('data:image/jpeg;base64,'.length);
          if (b64.length < 2_100_000) {
            const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
            imgKey = `img:${name}:${ts}-${id}`;
            await env.KV.put(imgKey, bytes.buffer);
          }
        }

        const rec = {
          id, ts, name, dia: +dia.toFixed(3),
          features: body.features && typeof body.features === 'object' ? body.features : {},
          imgKey,
        };
        await env.KV.put(`rec:${name}:${ts}-${id}`, JSON.stringify(rec));

        // rolling aggregate (low traffic → read-modify-write is acceptable)
        const agg = (await env.KV.get('aggregate', 'json')) || {};
        const a = agg[name] || { n: 0, sum: 0, sum2: 0, layers: {} };
        a.n += 1; a.sum += rec.dia; a.sum2 += rec.dia * rec.dia; a.lastTs = ts;
        const layer = rec.features.layer;
        if (layer) a.layers[layer] = (a.layers[layer] || 0) + 1;
        agg[name] = a;
        await env.KV.put('aggregate', JSON.stringify(agg));

        return json({ ok: true, id, imgStored: !!imgKey });
      }

      /* ---------- GET /api/records?name=X — raw records for audit ---------- */
      if (url.pathname === '/api/records' && req.method === 'GET') {
        const name = url.searchParams.get('name') || '';
        const list = await env.KV.list({ prefix: `rec:${name}:`, limit: 200 });
        const recs = await Promise.all(list.keys.map(k => env.KV.get(k.name, 'json')));
        return json(recs.filter(Boolean));
      }

      /* ---------- GET /api/image/<key> ---------- */
      if (url.pathname.startsWith('/api/image/') && req.method === 'GET') {
        const key = decodeURIComponent(url.pathname.slice('/api/image/'.length));
        if (!key.startsWith('img:')) return json({ error: 'bad key' }, 400);
        const buf = await env.KV.get(key, 'arrayBuffer');
        if (!buf) return json({ error: 'not found' }, 404);
        return new Response(buf, { headers: { 'content-type': 'image/jpeg', ...CORS } });
      }

      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: 'server', detail: String(e) }, 500);
    }
  },
};
