# Conductor Gauge — installable PWA

Camera-based electrical conductor identifier. Photographs a conductor lying on a
printed marker card, measures its overall diameter, reads its colour, and matches
it against the conductor list. Built as a **Progressive Web App** so it can be
installed to a phone home screen and run full-screen.

## Run locally
```bash
npm install
npm run dev          # opens a dev server (use --host to reach it from a phone)
```
The camera requires a **secure context** — `localhost` works for dev; on a real
phone you must serve over **HTTPS**.

## Build & deploy
```bash
npm run build        # outputs static files to dist/
npm run preview      # preview the production build
```
Deploy the `dist/` folder to any static HTTPS host (Netlify, Vercel, GitHub Pages,
Cloudflare Pages, or your own server). Once hosted over HTTPS:

- **Android / Chrome:** an "Install app" button appears (and the in-app one works);
  it installs to the home screen and runs standalone.
- **iPhone / Safari:** open the site, Share → **Add to Home Screen**. It launches
  full-screen with its own icon. Note: iOS Safari cannot control the camera flash
  from the web — use bright lighting (a native wrapper would unlock forced flash).

## How it works
1. Print `conductor_marker_card.pdf` at **100% / actual size**; verify the 100 mm
   calibration bar. Lay one conductor along the clear centre channel.
2. Take a photo with the whole card in frame, shot from directly above.
3. The app finds the four markers, computes the card geometry (homography),
   scans across the lane to find the conductor, measures its diameter, classifies
   material by colour, and matches the table — drawing the width on the image.

## Editing the conductor data
`src/lib/conductors.js` holds the table. Each row has `dia` (overall mm) and an
`est` flag. Rows with `est:true` have diameters **estimated from CSA** and should
be replaced with real datasheet/measured values (see `ConductorDiameters_template.xlsx`).
The copper and SCAC diameters are exact (computed from the strand code, where the
number after the slash is the single-strand diameter in inches).

## Project layout
```
src/
  App.jsx            UI + camera + flow (React)
  lib/vision.js      homography, marker detection, conductor detection, overlay
  lib/conductors.js  conductor lookup table
  styles.css
public/              PWA icons
vite.config.js       PWA manifest + service worker (vite-plugin-pwa)
```

## Accuracy notes
A decision-support tool — always confirm safety-critical sizes with calipers or
the printed cable marking. Best results: main rear lens, flash on (Android),
shoot ~25 cm away using zoom, card flat. The marker-measurement core is validated
to sub-0.1 mm on synthetic scenes; real-world accuracy depends on lighting,
flatness, and conductor/paper contrast (shiny aluminium under hard flash is the
hard case).
