"""Async httpx helpers for the Convex HTTP actions (mounted on CONVEX_SITE_URL).

Every request carries the shared server-to-server auth header
    X-Admin-Secret: <ADMIN_SHARED_SECRET>

Endpoints (see SHARED CONTRACT):
    POST /generateUploadUrl  -> {uploadUrl}
    POST /fileUrl   {storageId} -> {url}
    POST /getKeyMaterial {videoId} -> {contentKey,iv,keyVariant}   (apkId is global)
    POST /getVideo  {videoId} -> {status,iv,keyVariant,duration,renditions}
    POST /saveVideoResult {...}  -> {ok:true}
"""
from __future__ import annotations

import os
from typing import Any

import httpx

CONVEX_SITE_URL = os.environ.get("CONVEX_SITE_URL", "").rstrip("/")
ADMIN_SHARED_SECRET = os.environ.get("ADMIN_SHARED_SECRET", "")

# Longer timeout: segment uploads and Convex actions can be slow under load.
_TIMEOUT = httpx.Timeout(120.0, connect=30.0)

# In-memory cache of key material keyed by videoId. Populated on first read and
# reused by the hot /k/timestamp path so every wrapped-key request avoids a
# round-trip to Convex. Values: {"apkId","contentKey","iv","keyVariant"}.
_key_cache: dict[str, dict[str, str]] = {}


def _headers() -> dict[str, str]:
    return {"X-Admin-Secret": ADMIN_SHARED_SECRET}


def _base() -> str:
    if not CONVEX_SITE_URL:
        raise RuntimeError("CONVEX_SITE_URL env var is not set")
    return CONVEX_SITE_URL


async def generate_upload_url() -> str:
    """POST /generateUploadUrl -> short-lived Convex storage upload URL."""
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        r = await client.post(f"{_base()}/generateUploadUrl", headers=_headers())
        r.raise_for_status()
        return r.json()["uploadUrl"]


async def upload_bytes(data: bytes, content_type: str = "application/octet-stream") -> str:
    """Upload raw bytes to Convex storage and return the resulting storageId.

    Flow: get a fresh upload URL, POST the bytes to it, read {storageId} back.
    """
    upload_url = await generate_upload_url()
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        r = await client.post(
            upload_url,
            content=data,
            headers={"Content-Type": content_type},
        )
        r.raise_for_status()
        return r.json()["storageId"]


async def file_url(storage_id: str) -> str:
    """POST /fileUrl {storageId} -> public Convex storage URL for the object."""
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        r = await client.post(
            f"{_base()}/fileUrl",
            headers=_headers(),
            json={"storageId": storage_id},
        )
        r.raise_for_status()
        return r.json()["url"]


async def get_key_material(video_id: str) -> dict[str, str]:
    """POST /getKeyMaterial {videoId} -> {contentKey,iv,keyVariant} (cached).

    apkId is NOT here — it is a single global constant (env APK_ID). The result is
    cached in-process; the wrapped-key endpoint calls this on every hit.
    """
    cached = _key_cache.get(video_id)
    if cached is not None:
        return cached
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        r = await client.post(
            f"{_base()}/getKeyMaterial",
            headers=_headers(),
            json={"videoId": video_id},
        )
        r.raise_for_status()
        data = r.json()
    material = {
        "contentKey": data["contentKey"],
        "iv": data["iv"],
        "keyVariant": data.get("keyVariant", ""),
    }
    _key_cache[video_id] = material
    return material


def invalidate_key_cache(video_id: str) -> None:
    """Drop a cached key-material entry (e.g. after reprocessing a video)."""
    _key_cache.pop(video_id, None)


# Cache of validated opaque stream tokens: token -> {"videoId","email","expiresAt"(ms)}.
_token_cache: dict[str, dict[str, Any]] = {}


async def validate_stream_token(token: str, video_id: str) -> bool:
    """POST /validateStreamToken {token, videoId} -> ok? (cached until the token expires).

    Spayee's t/<token> is opaque, so validity is a server-side lookup, not a
    signature check. We cache positive results in-process so the hot segment path
    stays off the network after the first hit within a session.
    """
    import time

    now_ms = time.time() * 1000
    cached = _token_cache.get(token)
    if cached and cached["videoId"] == video_id and cached["expiresAt"] > now_ms:
        return True
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        r = await client.post(
            f"{_base()}/validateStreamToken",
            headers=_headers(),
            json={"token": token, "videoId": video_id},
        )
        r.raise_for_status()
        data = r.json()
    if data.get("ok"):
        _token_cache[token] = {
            "videoId": video_id,
            "email": data.get("email", ""),
            "expiresAt": data.get("expiresAt", 0),
        }
        return True
    return False


async def get_video(video_id: str) -> dict[str, Any]:
    """POST /getVideo {videoId} -> the video doc WITHOUT the secret contentKey.

    Needed by the master/variant playlist + segment-proxy endpoints, which must
    emit/resolve segment URLs + durations (renditions), the fixed IV, and
    keyVariant. This companion HTTP action returns:
        {status, iv, keyVariant, duration, renditions}
    (contentKey MUST NOT be included — the wrap key comes from getKeyMaterial;
     apkId is a global constant, not per-video.)
    """
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        r = await client.post(
            f"{_base()}/getVideo",
            headers=_headers(),
            json={"videoId": video_id},
        )
        r.raise_for_status()
        return r.json()


async def save_video_result(
    *,
    video_id: str,
    contentKey: str,
    iv: str,
    keyVariant: str,
    duration: float,
    renditions: list[dict[str, Any]],
    status: str,
) -> dict[str, Any]:
    """POST /saveVideoResult — patch the videos doc with final results/status."""
    payload = {
        "videoId": video_id,
        "contentKey": contentKey,
        "iv": iv,
        "keyVariant": keyVariant,
        "duration": duration,
        "renditions": renditions,
        "status": status,
    }
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        r = await client.post(
            f"{_base()}/saveVideoResult",
            headers=_headers(),
            json=payload,
        )
        r.raise_for_status()
        return r.json()
