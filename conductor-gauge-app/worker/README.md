# Conductor Gauge — shared learning API

A Cloudflare Worker that stores every confirmed conductor identification
(measurement + features + photo) so ALL users share one growing verified
library. The app fetches the library on launch and uses it for matching.

## Deploying via the Cloudflare dashboard (no CLI)

**1. Create the Worker**
- Dashboard → **Workers & Pages** → **Create** → **Create Worker**
- Name it `conductor-gauge-api` → **Deploy** (deploys the hello-world template)
- Click **Edit code**, delete the template, paste the entire contents of
  `worker.js`, then **Deploy**.

**2. Create the KV namespace**
- Dashboard → **Storage & Databases** → **KV** → **Create namespace**
- Name: `conductor-gauge-kv`

**3. Bind the namespace to the Worker** — the name must match the code EXACTLY:
- Worker → **Settings** → **Bindings** → **Add**
  - **KV namespace** → Variable name: `KV` → select `conductor-gauge-kv`

(Photos are stored in KV too — **no R2 needed**, everything runs on the free tier.
KV free tier = 1 GB and 1,000 writes/day ≈ 9,000 photos / 300 confirmations a day.)

**4. Set the API key**
- Worker → **Settings** → **Variables and Secrets** → **Add**
- Type: **Secret** → Name: `API_KEY` → Value: any long random string
  (e.g. from a password generator — save it, you need it in step 6)
- **Deploy** to apply.

**5. Find your Worker URL**
- On the Worker's overview page, e.g.
  `https://conductor-gauge-api.YOURNAME.workers.dev`

**6. Point the app at it**
- Edit `src/lib/learning.js` in the repo:
      WORKER_URL = 'https://conductor-gauge-api.YOURNAME.workers.dev'
      API_KEY    = '<the same secret from step 5>'
- Commit + push → Pages rebuilds.

**7. Quick test**
- Open `<worker-url>/api/verified` in a browser: you should see
  `{"error":"unauthorised"}` — that means the Worker is live and the key
  check works. (The app sends the key in a header; a bare browser doesn't.)
- After the first in-app confirmation, that same URL fetched with the key
  returns the conductor's aggregate.

## Endpoints
- GET  /api/verified          — per-conductor aggregate {n, mean, sd, layers}
- POST /api/confirm           — record a confirmation (+ optional JPEG)
- GET  /api/records?name=X    — raw records for one conductor
- GET  /api/image/<key>       — stored photo

## Honest notes
- `wrangler.toml` in this folder is only needed for CLI deploys — ignore it
  when using the dashboard.
- The API key ships inside the app bundle: it deters casual misuse but is not
  real security. Fine for an internal Westpower tool; if it ever goes public,
  put Cloudflare Access in front of the Worker.
- Aggregate updates use read-modify-write on a single KV key; at field-crew
  traffic levels this is fine. If usage grows hugely, migrate to D1.
- The photo library is the training set for a future ML classifier — every
  confirmation makes that future model better. Today's learning is statistical:
  verified mean diameters override table estimates for everyone.
