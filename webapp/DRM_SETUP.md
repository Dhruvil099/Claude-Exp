# Real-DRM tier (Widevine / PlayReady / FairPlay)

This is the **only** tier that actually stops a technical downloader: the content key
lives in the browser/OS **CDM**, never in reachable JS, so there is no `apkId` to read
and no key to unwrap. It is a **separate pipeline** from the AES-128 tier and is a
**scaffold** — it requires third-party accounts + tools and **cannot be run or tested
locally**. It is ported faithfully from Spayee's own `drmPlayer.js` (see `47.md`), which
uses **PallyCon / DoveRunner** Multi-DRM.

## What you must provide

| Requirement | Why |
|---|---|
| **PallyCon (DoveRunner) account** — `PALLYCON_SITE_ID`, `PALLYCON_ACCESS_KEY` | License server + KMS keys. Spayee uses `drm-license.doverunner.com`. |
| **Shaka Packager** (`packager` binary) on the backend | Produces CENC (`cbcs`) fMP4 + DASH `.mpd` + HLS fMP4. |
| **`shaka-player`** in the frontend (`npm i shaka-player`) | The DRM playback engine (`DrmPlayer.tsx` imports it dynamically). |
| **DRM-capable browsers** | FairPlay→Safari (Mac/iOS), PlayReady→Edge (Windows), Widevine→Chrome/Firefox. Won't work in others. |

## Pieces already scaffolded

| File | Role |
|---|---|
| `frontend/components/DrmPlayer.tsx` | Shaka player + PallyCon license filters + browser gating (port of `drmPlayer.js`). |
| `backend/drm.py` | `make_license_token()` (PallyCon `pallycon-customdata-v2`) + `build_packager_cmd()` (Shaka Packager). |
| `backend/main.py` → `POST /drm/token` | Mints the license token (X-Admin-Secret gated). |
| `frontend/convex/videos.ts` → `getDrmToken` action | Frontend calls this; it hits `/drm/token`; returns `{token, licenseUrl, siteId, manifestUrl}`. |
| `videos` schema | `drmEnabled`, `drmManifestUrl` fields. |

## Flow

```
admin uploads ─► ffmpeg to fMP4 ─► Shaka Packager (cbcs, PallyCon KMS key) ─► DASH .mpd + HLS fMP4
                                                        │ store manifest in Convex storage; set video.drmEnabled=true, drmManifestUrl
viewer opens ─► DrmPlayer detects DRM type (browser) ─► getDrmToken(videoId, drmType)
             ─► backend /drm/token → PallyCon token ─► Shaka loads manifest, sends token on each license request
             ─► CDM decrypts in hardware/software; keys never touch JS
```

## Steps to make it real

1. **PallyCon**: create a site, get `SITE_ID` + `ACCESS_KEY`; set them on the backend
   (`PALLYCON_SITE_ID`, `PALLYCON_ACCESS_KEY`). Confirm the **token spec** against
   PallyCon's current "Token-based Multi-DRM" docs + sample code and reconcile
   `drm.make_license_token()` (field order / policy encryption / hash input are
   version-specific — a mismatch yields license errors).
2. **Packaging**: in `processing.py`, when `drmEnabled`, transcode to fMP4 and run
   `drm.build_packager_cmd(...)` with a content key from PallyCon KMS (CPIX) or your key
   server. Upload the `.mpd` / HLS-fMP4 + segments to Convex storage; save
   `drmManifestUrl` + `drmEnabled=true` via `saveVideoResult`.
3. **Player wiring**: in `app/videos/[id]/page.tsx`, branch on `video.drmEnabled` —
   render `DrmPlayer` (call `getDrmToken` with the browser-detected `drmType`) instead of
   `VideoPlayer`. `npm i shaka-player`.
4. **Serve manifests/segments** behind the same tokenized `/u/.../t/<token>/` path if you
   want the per-user URL layer here too (optional — DRM already protects the keys).

## Honest expectations

- **Browser coverage is not universal** — no single DRM covers every browser; you route by
  DRM type. Some users (e.g. Linux/Firefox without Widevine, old browsers) may be blocked.
- **HD/hardware paths** may require hardware-backed CDMs and HDCP; SW robustness is the safe default.
- This still can't stop analog capture (a camera pointed at the screen) — nothing can — but
  it does stop file-level ripping, which the AES tier cannot.
