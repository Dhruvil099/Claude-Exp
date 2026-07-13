"""VideoHub FastAPI backend — EXACT Spayee scheme.

  GET  /                       -> health
  POST /process  (X-Admin-Secret) -> 202 + async pipeline

Everything below sits behind the Spayee-style path + per-user stream token:
  PREFIX = /spees/w/o/{org}/v/{vid}/u/{uid}/t/{token}/p/assets/videos/{org2}/{y}/{m}/{d}/{vid2}
  GET  PREFIX/index.m3u8                 -> master playlist
  GET  PREFIX/{rendition}.m3u8           -> variant playlist (+ EXT-X-KEY)
  GET  PREFIX/{name}.ts                  -> encrypted segment (proxied from Convex storage)
  GET  PREFIX/k/timestamp[/{variant}]    -> freshly randomized wrapped-key blob

apkId + IV are GLOBAL constants (env APK_ID / CONTENT_IV) — same for every video/user,
exactly like Spayee. Only the content key is per-video.
"""
from __future__ import annotations

import os
import re

import httpx
from fastapi import BackgroundTasks, FastAPI, Header, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import convex_client
import drm
from keywrap import wrap
from playlists import build_master, build_variant
from processing import process_video

ADMIN_SHARED_SECRET = os.environ.get("ADMIN_SHARED_SECRET", "")
FRONTEND_ORIGIN = os.environ.get("FRONTEND_ORIGIN", "*")
APK_ID = os.environ.get("APK_ID", "")  # global platform apkId (also NEXT_PUBLIC_APK_ID)

M3U8_MEDIA_TYPE = "application/vnd.apple.mpegurl"
TS_MEDIA_TYPE = "video/mp2t"
_SEG_RE = re.compile(r"^(.*_)(\d{3})$")  # "hls_1M_003" -> ("hls_1M_", "003")

# Spayee path shape. {org},{uid},{y},{m},{d} are cosmetic; auth is the token, lookup is {vid}.
PREFIX = (
    "/spees/w/o/{org}/v/{vid}/u/{uid}/t/{token}"
    "/p/assets/videos/{org2}/{y}/{m}/{d}/{vid2}"
)

app = FastAPI(title="VideoHub Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_ORIGIN] if FRONTEND_ORIGIN != "*" else ["*"],
    allow_credentials=FRONTEND_ORIGIN != "*",
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


def _require_admin(x_admin_secret: str | None) -> None:
    if not ADMIN_SHARED_SECRET or x_admin_secret != ADMIN_SHARED_SECRET:
        raise HTTPException(status_code=401, detail="invalid admin secret")


async def _require_token(token: str, video_id: str) -> None:
    """Validate the opaque per-user stream token via Convex lookup (Spayee t/<token>)."""
    if not await convex_client.validate_stream_token(token, video_id):
        raise HTTPException(status_code=403, detail="invalid or expired stream token")


class ProcessRequest(BaseModel):
    videoId: str
    rawUrl: str


@app.get("/")
async def health() -> dict[str, bool]:
    return {"ok": True}


class DrmTokenRequest(BaseModel):
    videoId: str
    userId: str
    drmType: str  # "Widevine" | "PlayReady" | "FairPlay"


@app.post("/drm/token")
async def drm_token(
    body: DrmTokenRequest,
    x_admin_secret: str | None = Header(default=None, alias="X-Admin-Secret"),
) -> dict[str, str]:
    """Mint a PallyCon license token for the real-DRM tier (SCAFFOLD — needs creds)."""
    from datetime import datetime, timezone

    _require_admin(x_admin_secret)
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    token = drm.make_license_token(
        drm_type=body.drmType, user_id=body.userId, content_id=body.videoId, timestamp=ts
    )
    return {"token": token, "licenseUrl": drm.LICENSE_SERVER, "siteId": drm.PALLYCON_SITE_ID}


@app.post("/process", status_code=202)
async def process(
    body: ProcessRequest,
    background_tasks: BackgroundTasks,
    x_admin_secret: str | None = Header(default=None, alias="X-Admin-Secret"),
) -> dict[str, bool]:
    _require_admin(x_admin_secret)
    background_tasks.add_task(process_video, body.videoId, body.rawUrl)
    return {"accepted": True}


# ----------------------------- tokenized stream routes -----------------------
# NOTE: /index.m3u8 and /k/timestamp are declared BEFORE /{name}.m3u8 so the
# literal routes win over the wildcard rendition route.

# All Spayee path segments are declared explicitly (FastAPI injects path params by
# name). org/uid/y/m/d/org2/vid2 are cosmetic; auth is `token`, lookup key is `vid`.

@app.get(PREFIX + "/index.m3u8")
async def master(org: str, vid: str, uid: str, token: str,
                 org2: str, y: str, m: str, d: str, vid2: str) -> Response:
    await _require_token(token, vid)
    video = await convex_client.get_video(vid)
    return Response(content=build_master(video.get("renditions", []) or []),
                    media_type=M3U8_MEDIA_TYPE)


@app.get(PREFIX + "/k/timestamp")
async def wrapped_key_default(org: str, vid: str, uid: str, token: str,
                              org2: str, y: str, m: str, d: str, vid2: str) -> Response:
    return await _wrapped_key(token, vid, "")


@app.get(PREFIX + "/k/timestamp/{variant}")
async def wrapped_key_variant(org: str, vid: str, uid: str, token: str, variant: str,
                              org2: str, y: str, m: str, d: str, vid2: str) -> Response:
    return await _wrapped_key(token, vid, variant)


@app.get(PREFIX + "/{name}.m3u8")
async def variant_playlist(org: str, vid: str, uid: str, token: str, name: str,
                           org2: str, y: str, m: str, d: str, vid2: str) -> Response:
    await _require_token(token, vid)
    video = await convex_client.get_video(vid)
    renditions = video.get("renditions", []) or []
    rendition = next((r for r in renditions if r.get("name") == name), None)
    if rendition is None:
        raise HTTPException(status_code=404, detail="rendition not found")
    return Response(
        content=build_variant(rendition, iv_hex=video.get("iv", ""),
                              key_variant=video.get("keyVariant", "")),
        media_type=M3U8_MEDIA_TYPE,
    )


@app.get(PREFIX + "/{seg}.ts")
async def segment(org: str, vid: str, uid: str, token: str, seg: str,
                  org2: str, y: str, m: str, d: str, vid2: str) -> Response:
    """Proxy an encrypted .ts segment from Convex storage (keeps the storage URL
    hidden behind the tokenized path — exactly like qcdn serving .ts directly)."""
    await _require_token(token, vid)
    m = _SEG_RE.match(seg)
    if not m:
        raise HTTPException(status_code=404, detail="bad segment name")
    rendition_name, idx = m.group(1), int(m.group(2))

    video = await convex_client.get_video(vid)
    rendition = next(
        (r for r in (video.get("renditions") or []) if r.get("name") == rendition_name), None
    )
    if rendition is None:
        raise HTTPException(status_code=404, detail="rendition not found")
    segments = rendition.get("segments", [])
    if idx >= len(segments):
        raise HTTPException(status_code=404, detail="segment index out of range")

    storage_url = segments[idx]["url"]
    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=30.0)) as client:
        r = await client.get(storage_url)
        r.raise_for_status()
        data = r.content
    return Response(content=data, media_type=TS_MEDIA_TYPE,
                    headers={"Cache-Control": "public, max-age=31536000"})


async def _wrapped_key(token: str, video_id: str, variant: str) -> Response:
    await _require_token(token, video_id)
    material = await convex_client.get_key_material(video_id)  # {contentKey, iv, keyVariant}
    content_key = bytes.fromhex(material["contentKey"])
    blob = wrap(variant, APK_ID, content_key)                  # global apkId
    return Response(content=blob, media_type="application/octet-stream",
                    headers={"Cache-Control": "no-store"})     # randomized per hit


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
