# VideoHub — Architecture

This document describes the two runtime flows (**upload/processing** and **playback**), the
**two-tier trust model**, why the `contentKey` never leaves the server, and a summary of the
**wrapped-key** procedure. All endpoint paths, env var names, the `X-Admin-Secret` header, and
field names match the shared contract in [README.md](README.md).

---

## Components

- **Frontend** — Next.js 14 App Router (TypeScript), hosted on Vercel. Talks to Convex
  (`api.videos.*` + Convex Auth Google) and streams HLS from the backend.
- **Convex** — DB (`videos` table + auth tables), file storage (encrypted segments and the raw
  upload), client functions, and HTTP actions on the `*.convex.site` origin.
- **Backend** — FastAPI on Render (Docker + ffmpeg). Transcodes + encrypts on `/process`,
  serves HLS playlists, and serves the freshly-wrapped key blob on `/k/timestamp`.

---

## The `videos` data model (trust boundary)

```
videos: {
  title, description,
  status: "processing" | "ready" | "failed",
  apkId: string,        // 64 hex — PUBLIC, baked into the player
  contentKey: string,   // 32 hex — SECRET, server-side only
  iv: string,           // 32 hex
  keyVariant: string,   // "" default
  duration: number,
  renditions: [ { name, isAudio, groupId?, bandwidth, resolution?, codecs,
                  segments: [ { url, duration } ] } ],
  createdBy, createdAt,
}
```

The single most important rule: **`contentKey` is secret.** The public query
`api.videos.get` returns `{_id,title,description,status,apkId,iv,keyVariant,duration,masterUrl}`
and deliberately **omits `contentKey`**. The key material is read server-side only, via the
Convex HTTP action `POST /getKeyMaterial` (guarded by `X-Admin-Secret`), which the backend calls
and caches in memory.

---

## Flow 1 — Upload & processing (admin only)

```
Admin browser            Convex                         Backend (FastAPI)         Convex storage
─────────────            ──────                         ─────────────────         ──────────────
 isAdmin() ───────────►  email==ADMIN_EMAIL? ──► true
 generateRawUploadUrl ►  storage.generateUploadUrl ──► uploadUrl
 PUT raw file ─────────────────────────────────────────────────────────────────► (raw stored)
 createVideo(rawStorageId,title,description)
        │
        ├─ insert videos {status:"processing", apkId:"", contentKey:"", iv:"",
        │                  keyVariant:"", renditions:[], createdBy, createdAt}
        ├─ storage.getUrl(rawStorageId) ─► rawUrl
        └─ POST {BACKEND_URL}/process
              header X-Admin-Secret, body {videoId, rawUrl}  ──────────────►  202 Accepted
                                                                              (BackgroundTasks)
                                                                                   │
   download rawUrl ◄──────────────────────────────────────────────────────────────┤
   ffmpeg → 3 renditions:                                                          │
     hls_1M_   1280x720   (video)                                                  │
     hls_500k_ 852x480    (video)                                                  │
     hls_audio_           (audio-only, groupId "audio-0")                          │
   generate contentKey (random 16B) + fixed IV + apkId (64 hex; see below)         │
   for each segment: AES-128-CBC encrypt (PKCS7)                                   │
     POST {CONVEX_SITE_URL}/generateUploadUrl ─► uploadUrl                         │
     PUT encrypted bytes ───────────────────────────────────────────────────────► (seg stored)
     POST {CONVEX_SITE_URL}/fileUrl {storageId} ─► url  ◄──────────────────────────┤
   build renditions[]                                                              │
   POST {CONVEX_SITE_URL}/saveVideoResult                                          │
     {videoId, apkId, contentKey, iv, keyVariant:"", duration, renditions,         │
      status:"ready"}  ──► patch videos doc  ◄──────────────────────────────────────┘
   (on any error → saveVideoResult {status:"failed"})
```

Notes:
- `/process` returns **202 immediately** and does the heavy work in `BackgroundTasks`
  (fire-and-forget from Convex's point of view).
- Every server-to-server call carries `X-Admin-Secret`. The Convex HTTP actions on
  `*.convex.site` reject requests without the matching secret.
- `apkId` is a 64-hex string constructed so that `bytes.fromhex(apkId[0:16] + apkId[48:64])`
  is the 16-byte **stage-1 key** used by the wrap/unwrap (see Flow 2).

---

## Flow 2 — Playback (any signed-in viewer, free)

```
Viewer browser (hls.js + WrappedKeyLoader)        Convex                Backend
──────────────────────────────────────────        ──────                ───────
 list() ─────────────────────────────────────►  signed-in? ─► [videos]
 get(id) ────────────────────────────────────►  signed-in? ─► {apkId, iv, keyVariant,
                                                                masterUrl, ...} (NO contentKey)
 window.apkId = apkId
 hls.loadSource(masterUrl)   masterUrl = NEXT_PUBLIC_BACKEND_URL + "/videos/"+id+"/index.m3u8"
        │
        ├─ GET /videos/{id}/index.m3u8 ──────────────────────────────────────────► master playlist
        │      #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-0",URI="hls_audio_.m3u8"
        │      #EXT-X-STREAM-INF:AUDIO="audio-0",BANDWIDTH,RESOLUTION,CODECS
        │        hls_500k_.m3u8 / hls_1M_.m3u8   (RELATIVE variant URIs)
        │
        ├─ GET /videos/{id}/{rendition}.m3u8 ────────────────────────────────────► variant playlist
        │      #EXT-X-KEY:METHOD=AES-128,URI="k/timestamp",IV=0x<iv>
        │      #EXTINF + absolute Convex-storage segment URL per segment + #EXT-X-ENDLIST
        │
        ├─ GET <Convex storage URL> ─────────────────────────────────────────────► encrypted .ts
        │
        └─ context.url includes "/k/timestamp"  → WrappedKeyLoader intercepts:
              GET /videos/{id}/k/timestamp[/{variant}] ─────────────────────────► wrapped blob
                     (backend reads key material via /getKeyMaterial, caches it,
                      returns a FRESHLY randomized blob each request)
              unwrap with window.apkId (two AES-128-ECB passes) → 16-byte key
              hand key to hls.js → decrypt segments → play
```

The player shows *"Video not available for download — streaming only"*, disables right-click on
the `<video>` element, and exposes no download controls. Playback is free — there is no payment
anywhere in the system.

---

## Two-tier trust model

**Tier 1 — the public/browser side (untrusted).** Ships only what a player strictly needs:
- `apkId` (public, per-video) baked into `window.apkId`.
- `iv` and `keyVariant` (needed to form the `#EXT-X-KEY` line / select the wrap variant).
- Playlists and encrypted segment URLs.

Crucially, the browser **never** receives `contentKey`. What it does receive from `/k/timestamp`
is a *wrapped* blob that only yields the key after two AES-ECB unwrap passes keyed by a value
**derived from `apkId`** — and even then the blob is re-randomized on every request, so a captured
blob is not a stable secret.

**Tier 2 — the server side (trusted).** `contentKey` exists in exactly two trusted places:
1. **Convex DB** — written once by `saveVideoResult`, read back only by `getKeyMaterial`.
2. **Backend memory** — fetched via `getKeyMaterial` (with `X-Admin-Secret`) and cached to wrap
   keys on demand.

Both server-to-server hops require the `X-Admin-Secret` header, and the public Convex query
`get` structurally cannot leak `contentKey` because it never selects that field.

### Why `contentKey` stays server-side
- **HLS AES-128 requires the player to obtain the decryption key**, but handing the raw key to
  the browser makes ripping trivial (any `curl` of the key URI + segments reconstructs the video).
- By moving the raw key server-side and only serving a **wrapped, per-request-randomized** blob
  through the standard `#EXT-X-KEY` URI, the key never appears verbatim on the wire or in the DB
  response, and the unwrap requires the `apkId`-derived stage-1 key plus the exact two-stage ECB
  procedure — raising the bar well above "copy the key file."
- Public queries omit the field so an authenticated but non-admin user cannot read it either.

---

## Wrapped-key procedure (summary)

Ported verbatim from `hls_clone/server.py` (wrap) and `hls_clone/www/player.html` (unwrap). The
blob carries two ciphertext chunks at variant-specific byte ranges; the rest is printable-ASCII
decoy.

**Stage-1 key (shared by both sides):**
```
stage1key = bytes.fromhex(apkId[0:16] + apkId[48:64])   // 16 bytes
```

**Variants** `(g = stage-1 ciphertext range, v = stage-2 ciphertext range)`:

| variant   | g range   | v range   |
|-----------|-----------|-----------|
| `""`/`scw`| `[32:48]` | `[0:16]`  |
| `w1q`     | `[0:16]`  | `[32:48]` |
| `sdq`     | `[32:48]` | `[8:24]`  |
| `aav`     | `[48:64]` | `[0:16]`  |
| `scs`     | `[48:64]` | `[16:32]` |
| `sxc`     | `[0:16]`  | `[48:64]` |
| `q1wq`    | `[16:32]` | `[48:64]` |

**Wrap (backend, per request):**
```
inter      = random 16 bytes                         // fresh every request
blob[g]    = AES_ECB_encrypt(stage1key, inter)       // unwraps back to inter
blob[v]    = AES_ECB_encrypt(inter,    contentKey)   // unwraps to the content key
blob[rest] = printable-ASCII decoy
blob size  = max(g_end, v_end)
```

**Unwrap (player, crypto-js, ECB + NoPadding + Hex):**
```
inter = AES_ECB_decrypt(blob[g], stage1key)
key   = AES_ECB_decrypt(blob[v], inter)              // 16-byte AES-128 content key
```

Because `inter` is random per request, the two ciphertext chunks differ every time even though
they always unwrap to the same constant `contentKey`. The `WrappedKeyLoader` (a subclass of
`Hls.DefaultConfig.loader`) detects `/k/timestamp` in `context.url`, fetches the blob, runs the
two decrypts using `window.apkId`, and returns the 16-byte key to hls.js — mirroring
`hls_clone/www/player.html` (VARIANTS map + `u8ToWA`/`waToU8` + `unwrapKey` + `WrappedKeyLoader`).
