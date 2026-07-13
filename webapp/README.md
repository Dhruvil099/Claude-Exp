# VideoHub

A **free** video-course platform. One admin uploads videos (title + description);
any signed-in Google user can **watch** them for free. There are no downloads — the UI
shows *"Video not available for download — streaming only"* and playback uses the
protected-HLS scheme (AES-128 HLS + a wrapped-key endpoint) ported from
[`../hls_clone/`](../hls_clone/).

- **Admin (uploader):** `shahdhruvil1310@gmail.com`
- **Everyone else:** signs in with Google, watches for free.

---

## Architecture (at a glance)

```
                         ┌──────────────────────────────────────────────┐
                         │                 VIEWER (browser)              │
                         │  Next.js 14 App Router player (hls.js)        │
                         │  window.apkId + WrappedKeyLoader (crypto-js)  │
                         └───────────────┬──────────────────────┬───────┘
                                         │                      │
                    api.videos.* (query/ │ mutation)            │ HLS: master + variant
                    Convex Auth (Google) │                      │ playlists + /k/timestamp
                                         ▼                      ▼
   ┌───────────────────────────┐   ┌──────────────────────────────────────────┐
   │        CONVEX             │   │            BACKEND (FastAPI @ Render)      │
   │  DB (videos + auth)       │   │  GET  /videos/{id}/index.m3u8  (master)    │
   │  Storage (encrypted segs) │   │  GET  /videos/{id}/{rendition}.m3u8        │
   │  Client fns: list/get/    │   │  GET  /videos/{id}/k/timestamp[/{variant}] │
   │    isAdmin/createVideo/   │   │       -> freshly wrapped AES-128 key blob  │
   │    generateRawUploadUrl   │   │  POST /process (X-Admin-Secret)            │
   │                           │   │       download -> ffmpeg 3 renditions ->   │
   │  HTTP actions (*.convex.  │◄──┤       AES-128-CBC encrypt -> upload segs   │
   │  site, X-Admin-Secret):   │   │       -> saveVideoResult                   │
   │   /generateUploadUrl      │──►│  (ffmpeg required in the image)            │
   │   /fileUrl                │   └──────────────────────────────────────────┘
   │   /getKeyMaterial         │
   │   /saveVideoResult        │        contentKey (secret) lives ONLY in
   └───────────────────────────┘        Convex + backend memory — never sent
                                        to any browser. See ARCHITECTURE.md.
```

Three deploy targets:

| Part                | Stack                         | Hosting |
|---------------------|-------------------------------|---------|
| `frontend/`         | Next.js 14 App Router (TS)     | Vercel  |
| `backend/`          | FastAPI (Python)              | Render (Docker + ffmpeg) |
| `frontend/convex/`  | Convex (DB + storage + Auth)  | Convex cloud |

---

## Shared contract (must match across all parts)

- **Admin email:** `shahdhruvil1310@gmail.com`
- **Server-to-server header:** `X-Admin-Secret: <ADMIN_SHARED_SECRET>` (same value in
  Convex `ADMIN_SHARED_SECRET` and backend `ADMIN_SHARED_SECRET`).
- **`contentKey` is secret.** It is never returned by a public Convex query and never
  reaches the browser. See [ARCHITECTURE.md](ARCHITECTURE.md).
- **`apkId` is a single GLOBAL constant** (like Spayee's `window.apkId`), shared by the
  backend (`APK_ID`) and frontend (`NEXT_PUBLIC_APK_ID`) — NOT per-video.
- **Per-user stream token** (the Spayee `t/<token>` layer): Convex `getStreamToken` mints
  an **opaque 32-hex** token, stores it in `streamTokens`, and returns the tokenized master
  URL. The backend validates every request via the `X-Admin-Secret`-gated
  `/validateStreamToken` action (cached). Content key + IV + encrypted `.ts` are per-video
  and shared across users (segments encrypted once); the IV is a global constant.

### Stream URL scheme (exact Spayee)

```
/spees/w/o/<org>/v/<id>/u/<uid>/t/<token>/p/assets/videos/<org>/<Y>/<M>/<D>/<id>/index.m3u8   master
                                                            …/hls_1M_.m3u8     variant (EXT-X-KEY URI="k/timestamp", relative .ts)
                                                            …/hls_1M_000.ts    segment (proxied from Convex storage — URL hidden)
                                                            …/k/timestamp      wrapped key blob (randomized per hit)
```

### Environment variables (names are fixed — do not rename)

**Frontend (Vercel)** — see [`frontend/.env.local.example`](frontend/.env.local.example)
- `NEXT_PUBLIC_CONVEX_URL` — your Convex deployment URL (`https://<name>.convex.cloud`).
- `NEXT_PUBLIC_APK_ID` — the global 64-hex apkId (must equal backend `APK_ID`).

**Convex (dashboard)** — see [`convex-env.example.md`](convex-env.example.md)
- `ADMIN_EMAIL` = `shahdhruvil1310@gmail.com`
- `ADMIN_SHARED_SECRET` — shared secret (must equal the backend's).
- `BACKEND_URL` — backend public https URL (`createVideo` → `POST {BACKEND_URL}/process`; `getStreamToken` builds the tokenized master URL).
- `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` — Google OAuth client credentials.
- `SITE_URL` — the frontend's public origin (Convex Auth redirect base).
- `ORG_ID` — 24-hex org id for the Spayee-style stream path (cosmetic).

**Backend (Render)** — see [`backend/.env.example`](backend/.env.example)
- `CONVEX_SITE_URL` — the `*.convex.site` HTTP-actions origin (NOT `.convex.cloud`).
- `ADMIN_SHARED_SECRET` — shared secret (must equal Convex's).
- `APK_ID` — the global 64-hex apkId (must equal frontend `NEXT_PUBLIC_APK_ID`).
- `CONTENT_IV` — the global 32-hex content IV (like Spayee's `496daa1c…`).
- `FRONTEND_ORIGIN` — the frontend origin, for CORS.
- `PORT` — provided by Render at runtime.

> `APK_ID` == `NEXT_PUBLIC_APK_ID` must match. Stream tokens are opaque and DB-backed, so
> there is no stream-token secret to sync — only `ADMIN_SHARED_SECRET` gates the backend↔Convex calls.

---

## Setup

### 1) Convex (DB + storage + Auth)

```bash
cd frontend
npm install
npx convex dev        # first run: log in, create/select a deployment, writes NEXT_PUBLIC_CONVEX_URL to .env.local
```

Then in the **Convex dashboard → Settings → Environment Variables**, set every var listed
in [`convex-env.example.md`](convex-env.example.md):
`ADMIN_EMAIL`, `ADMIN_SHARED_SECRET`, `BACKEND_URL`, `AUTH_GOOGLE_ID`,
`AUTH_GOOGLE_SECRET`, `SITE_URL`.

**Wire Google OAuth (Convex Auth Google provider):**
1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials) create an
   **OAuth 2.0 Client ID** (type: *Web application*).
2. **Authorized redirect URIs** — add the Convex Auth callback for your deployment:
   - `https://<your-deployment>.convex.site/api/auth/callback/google`
3. Copy the client ID/secret into Convex env vars `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`.
4. Set `SITE_URL` to your frontend origin (e.g. `http://localhost:3000` for local dev,
   your Vercel URL in production). Convex Auth redirects back here after sign-in.

> The Convex Auth Google provider is configured in `frontend/convex/auth.ts` (owned by the
> Convex agent). It reads `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` from the environment.

### 2) Backend on Render (Docker + ffmpeg)

The backend transcodes with **ffmpeg**, so it ships as a Docker image (see `backend/Dockerfile`,
owned by the backend agent) that installs ffmpeg. Deploy via [`backend/render.yaml`](backend/render.yaml):

1. Push this repo to GitHub.
2. In Render, **New → Blueprint** and point it at the repo; Render reads `backend/render.yaml`
   and creates a Docker web service.
3. Set the env vars (marked `sync: false` in `render.yaml`, so you set them in the dashboard):
   `CONVEX_SITE_URL`, `ADMIN_SHARED_SECRET`, `PUBLIC_BACKEND_URL`, `FRONTEND_ORIGIN`.
   `PORT` is injected by Render.
4. After the first deploy, copy the service's public URL into:
   - backend `PUBLIC_BACKEND_URL`
   - Convex `BACKEND_URL`
   - frontend `NEXT_PUBLIC_BACKEND_URL`
5. Health check: `GET /` should return `{"ok": true}`.

### 3) Frontend on Vercel

1. **New Project → import the repo**, set the **root directory** to `frontend/`.
2. Set env vars ([`frontend/.env.local.example`](frontend/.env.local.example)):
   - `NEXT_PUBLIC_CONVEX_URL` — from `npx convex deploy` / the dashboard.
   - `NEXT_PUBLIC_BACKEND_URL` — the Render service URL.
3. For production Convex, run `npx convex deploy` (or connect Convex's Vercel integration) so
   the deployed functions and `NEXT_PUBLIC_CONVEX_URL` match the production deployment.
4. Add the Vercel domain to Google OAuth `SITE_URL` (Convex) if it differs from local.

---

## Local development

```bash
# terminal 1 — Convex (watches frontend/convex, keeps functions deployed)
cd frontend && npx convex dev

# terminal 2 — Next.js frontend
cd frontend && npm run dev            # http://localhost:3000

# terminal 3 — FastAPI backend (needs ffmpeg installed locally)
cd backend
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Local env files (copy the examples, drop the `.example` suffix):
- `frontend/.env.local`  ← `frontend/.env.local.example`
- `backend/.env`         ← `backend/.env.example`

For local dev set `NEXT_PUBLIC_BACKEND_URL=http://localhost:8000`, backend
`PUBLIC_BACKEND_URL=http://localhost:8000`, `FRONTEND_ORIGIN=http://localhost:3000`,
Convex `BACKEND_URL=http://localhost:8000`, `SITE_URL=http://localhost:3000`. Get
`CONVEX_SITE_URL` from the dashboard (the `*.convex.site` origin of your dev deployment).

> ffmpeg must be on your PATH for `/process` to work locally
> (`brew install ffmpeg` / `apt-get install ffmpeg`).

---

## How it works day-to-day

### Admin uploads a video (only `shahdhruvil1310@gmail.com`)
1. Sign in with Google as the admin. The UI shows an admin upload form because
   `api.videos.isAdmin` returns `true` (identity email == `ADMIN_EMAIL`).
2. Pick a file + enter title/description. The frontend calls
   `api.videos.generateRawUploadUrl` (admin-only), uploads the raw file to Convex storage,
   then calls `api.videos.createVideo({rawStorageId, title, description})`.
3. `createVideo` inserts a `videos` doc with `status:"processing"` and fires
   `POST {BACKEND_URL}/process` (header `X-Admin-Secret`, body `{videoId, rawUrl}`).
4. The backend transcodes into 3 renditions (720p `hls_1M_`, 480p `hls_500k_`, audio-only
   `hls_audio_`), AES-128-CBC encrypts every segment with one random `contentKey` + fixed IV,
   uploads encrypted segments to Convex storage, then calls `saveVideoResult` with
   `status:"ready"` (or `"failed"` on error).

### A viewer watches (any signed-in Google user, free)
1. Sign in with Google. `api.videos.list` returns ready videos.
2. Open one: `api.videos.get(id)` returns `apkId` + `masterUrl`
   (`NEXT_PUBLIC_BACKEND_URL + "/videos/" + id + "/index.m3u8"`) — **never** `contentKey`.
3. The player sets `window.apkId`, hls.js loads the master, and a custom `WrappedKeyLoader`
   fetches `/k/timestamp`, unwraps the two-stage AES-128-ECB blob with `crypto-js`, and hands
   hls.js the 16-byte key. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full flow.
4. Under the player: *"Video not available for download — streaming only."* Right-click on the
   `<video>` is disabled; there are no download controls. Watching is free.

---

## Repo layout

```
webapp/
├── README.md                      ← you are here
├── ARCHITECTURE.md                ← upload + playback flows, trust model, key-wrap summary
├── .gitignore
├── convex-env.example.md          ← Convex dashboard env vars
├── frontend/                      ← Next.js 14 (Vercel) + convex/ (Convex functions + Auth)
│   └── .env.local.example
└── backend/                       ← FastAPI (Render, Docker + ffmpeg)
    ├── .env.example
    └── render.yaml
```
