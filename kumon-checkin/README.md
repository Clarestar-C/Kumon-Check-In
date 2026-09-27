# Kumon Student Check-In

A student check-in / check-out web app for a Kumon centre, built with
React + Vite. Every staff device sees the **same roster live** — check a
student in on one phone and it appears on every other device within a
second (Firebase Realtime Database). The app still works with no internet
connection: it keeps a copy on the device and syncs automatically when
you're back online.

## How it works

- **Day tabs (Mon / Thu / Sat)** — Kumon's open days. Each day has its own
  roster. The tab for today opens automatically.
- **Walk-in student button** — the single arrival action on each day tab.
  Tap it, type a name, and matching students appear with their levels and
  days — one tap checks them in (adding today to their days if needed).
  Someone brand new? "Add as new walk-in" creates them with Math/Reading
  levels and checks them in on the spot. All times are recorded and shown
  in **Eastern Time**.
- **Subject levels on every time card** — each card shows tappable
  **Math · X** and **Reading · Y** pills (Kumon levels 7A–O, or — when not
  set). Tap a pill to change that student's level instantly — no popup,
  one tap to set, one tap to fix.
- **Per-student timers (SCT)** — every student has a preset session length
  (their Standard Completion Time), picked from a dropdown list
  (15 / 30 / 45 / 60 / 90 / 120 min). The card counts down while they're in.
- **Soft wrap-up notification** — the moment a timer runs out, the student's
  card gently lights up amber and a banner appears at the top.
- **Sync status** — a small "Live sync" indicator under the centre name
  shows whether the device is connected. If it says Offline, the app keeps
  working from the on-device copy and syncs later.
- **Settings (gear tab)** —
  - change the default session length (confirmation popup),
  - add students with their days, Math/Reading levels + SCT preset,
  - edit a student's days, levels or preset time (confirmation popup on
    time change),
  - remove students (confirmation popup),
  - rename the centre, export attendance to CSV (now includes Math and
    Reading level columns), delete all data (on all synced devices).

Data syncs through Firebase (see "Cloud sync setup" below). The on-device
copy in localStorage acts as an instant cache and offline fallback — taps
always feel instant, and syncing happens quietly in the background.

## Project layout (for VS Code)

```
kumon-checkin/
├── index.html              # page shell: title, manifest + icon links
├── vite.config.js          # build config (relative paths for GitHub Pages)
├── package.json            # dependencies + npm scripts
├── public/
│   ├── sw.js               # service worker: caches the app shell offline
│   ├── manifest.webmanifest# "install to home screen" metadata
│   └── icon.svg            # app icon
├── src/
│   ├── main.jsx            # entry point: renders App, registers sw.js
│   ├── App.jsx             # all UI + check-in logic + timers + sync
│   ├── firebase.js         # Firebase config + sign-in + database refs
│   └── styles.css          # all styling
└── .github/workflows/deploy.yml  # auto-deploy to GitHub Pages
```

## Cloud sync setup (one time, ~5 minutes)

The app shares one Firebase Realtime Database between all devices.

1. Go to [console.firebase.google.com](https://console.firebase.google.com)
   and create a project (any name; skip Analytics).
2. **Build → Realtime Database → Create database.** Choose the default
   region (**us-central1**) and start in **locked mode**.
3. **Build → Authentication → Sign-in method** → enable **Anonymous**
   (this happens invisibly in the app — staff never log in; it just keeps
   strangers out).
4. **Realtime Database → Rules** → replace the rules with:
   ```json
   {
     "rules": {
       "state": { ".read": "auth != null", ".write": "auth != null" }
     }
   }
   ```
   then **Publish**.
5. If you change regions or projects later, update the values in
   `src/firebase.js`.

The free Spark plan (no credit card) covers this easily: 1 GB stored,
10 GB/month transferred, 100 devices connected at once. A centre's roster
is only kilobytes.

## Run it locally

```bash
npm install
npm run dev
```

Then open the printed local URL (usually http://localhost:5173).

## Deploy through GitHub (GitHub Pages)

1. Create a new repository on GitHub (e.g. `kumon-checkin`) — **do not**
   initialise it with a README; this folder already has everything.
2. From this folder:
   ```bash
   git init
   git add .
   git commit -m "Kumon check-in app"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/kumon-checkin.git
   git push -u origin main
   ```
3. On GitHub, go to **Settings → Pages** and set **Source** to
   **GitHub Actions**.
4. Every push to `main` now builds and deploys automatically via
   `.github/workflows/deploy.yml`. Your app will be live at
   `https://YOUR-USERNAME.github.io/kumon-checkin/`.

Open that URL on every staff phone/tablet — they all share the same live
roster, no accounts needed.

## Use it offline on a phone or tablet

1. Open the deployed URL once while online (this caches the app shell).
2. Use the browser menu → **Add to Home Screen** (Chrome/Android) or
   **Share → Add to Home Screen** (Safari/iOS).
3. From then on it launches full-screen. Check-ins keep working with no
   connection and sync when you're back online.
