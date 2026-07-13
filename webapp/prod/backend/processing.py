"""Async video processing pipeline — ports hls_clone/package.py to the cloud.

For each /process job:
  1. download rawUrl (httpx stream) to a temp file
  2. ffmpeg -> 3 renditions (hls_1M_ 1280x720, hls_500k_ 852x480, hls_audio_)
  3. AES-128-CBC encrypt every .ts segment (single content key K + fixed IV + PKCS7)
     (apkId is a GLOBAL constant, env APK_ID — not generated per video)
  4. upload each encrypted segment to Convex storage -> segment url
  5. assemble renditions[] and POST /saveVideoResult (status "ready")
On any failure: POST /saveVideoResult with status "failed".
"""
from __future__ import annotations

import asyncio
import os
import secrets
import shutil
import tempfile
from typing import Any

import httpx
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad

from convex_client import save_video_result, upload_bytes, file_url, invalidate_key_cache

# Keyframe alignment so segments cut cleanly every 2s (Spayee segments avg ~2.4s).
_KF = ["-force_key_frames", "expr:gte(t,n_forced*2)"]
_HLS_TIME = "2"

# (name, ffmpeg args, rendition metadata) for the three renditions.
_RENDITIONS: list[dict[str, Any]] = [
    {
        "name": "hls_1M_",
        "ff": ["-map", "0:v:0", "-an", "-c:v", "libx264", "-b:v", "1M", "-s", "1280x720"] + _KF,
        "isAudio": False,
        "bandwidth": 900000,
        "resolution": "1280x720",
        "codecs": "avc1.64001f,mp4a.40.2",
    },
    {
        "name": "hls_500k_",
        "ff": ["-map", "0:v:0", "-an", "-c:v", "libx264", "-b:v", "500k", "-s", "852x480"] + _KF,
        "isAudio": False,
        "bandwidth": 650000,
        "resolution": "852x480",
        "codecs": "avc1.64001f,mp4a.40.2",
    },
    {
        "name": "hls_audio_",
        "ff": ["-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", "96k"],
        "isAudio": True,
        "groupId": "audio-0",
        "bandwidth": 96000,
        "codecs": "mp4a.40.2",
    },
]


# Global constant IV, shared by every video — exactly like Spayee (which used the
# same 0x496daa1c... IV in every playlist). apkId is likewise global (env APK_ID).
_CONTENT_IV = os.environ.get("CONTENT_IV", "496daa1c6914000e408c65cead91fc29")


def _gen_key_material() -> tuple[bytes, bytes]:
    """Return (K, IV): a fresh per-video content key + the GLOBAL constant IV."""
    return secrets.token_bytes(16), bytes.fromhex(_CONTENT_IV)


async def _download(raw_url: str, dest_path: str) -> None:
    """Stream the raw upload to a local file."""
    timeout = httpx.Timeout(300.0, connect=30.0)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        async with client.stream("GET", raw_url) as resp:
            resp.raise_for_status()
            with open(dest_path, "wb") as f:
                async for chunk in resp.aiter_bytes(1 << 20):
                    f.write(chunk)


async def _run(cmd: list[str], cwd: str | None = None) -> None:
    """Run a subprocess, raising with stderr on non-zero exit."""
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=cwd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f"{cmd[0]} failed ({proc.returncode}): {stderr.decode(errors='replace')[-2000:]}")


async def _probe_duration(src: str) -> float:
    """ffprobe the source duration (seconds); 0.0 if unavailable."""
    proc = await asyncio.create_subprocess_exec(
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", src,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    out, _ = await proc.communicate()
    try:
        return float(out.decode().strip())
    except (ValueError, AttributeError):
        return 0.0


def _parse_playlist(m3u8_path: str) -> list[tuple[str, float]]:
    """Parse ffmpeg's variant playlist into ordered (segment_filename, duration)."""
    segs: list[tuple[str, float]] = []
    pending_dur = 0.0
    with open(m3u8_path) as f:
        for raw in f:
            line = raw.strip()
            if line.startswith("#EXTINF:"):
                # "#EXTINF:4.000000," -> 4.0
                pending_dur = float(line[len("#EXTINF:"):].split(",")[0])
            elif line and not line.startswith("#") and line.endswith(".ts"):
                segs.append((line, pending_dur))
                pending_dur = 0.0
    return segs


async def _render_one(
    src: str, work_root: str, spec: dict[str, Any], K: bytes, IV: bytes
) -> dict[str, Any]:
    """ffmpeg one rendition, encrypt+upload its segments, return the rendition dict."""
    name = spec["name"]
    tmp = os.path.join(work_root, f"_t_{name}")
    os.makedirs(tmp, exist_ok=True)

    await _run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", src, *spec["ff"],
         "-f", "hls", "-hls_time", _HLS_TIME, "-hls_playlist_type", "vod",
         "-hls_segment_filename", f"{name}%03d.ts", f"{name}.m3u8"],
        cwd=tmp,
    )

    seg_list = _parse_playlist(os.path.join(tmp, f"{name}.m3u8"))

    out_segments: list[dict[str, Any]] = []
    for seg_name, dur in seg_list:
        with open(os.path.join(tmp, seg_name), "rb") as f:
            data = f.read()
        # AES-128-CBC + PKCS7, single content key K + fixed IV (identical to package.py)
        ct = AES.new(K, AES.MODE_CBC, IV).encrypt(pad(data, 16))
        storage_id = await upload_bytes(ct, content_type="application/octet-stream")
        url = await file_url(storage_id)
        out_segments.append({"url": url, "duration": dur})

    rendition: dict[str, Any] = {
        "name": name,
        "isAudio": spec["isAudio"],
        "bandwidth": spec["bandwidth"],
        "codecs": spec["codecs"],
        "segments": out_segments,
    }
    if spec.get("groupId"):
        rendition["groupId"] = spec["groupId"]
    if spec.get("resolution"):
        rendition["resolution"] = spec["resolution"]
    return rendition


async def process_video(video_id: str, raw_url: str) -> None:
    """Full pipeline. Always reports a terminal status back to Convex."""
    work_root = tempfile.mkdtemp(prefix=f"vhub_{video_id}_")
    K, IV = _gen_key_material()
    try:
        src = os.path.join(work_root, "source.input")
        await _download(raw_url, src)

        duration = await _probe_duration(src)

        renditions: list[dict[str, Any]] = []
        for spec in _RENDITIONS:
            renditions.append(await _render_one(src, work_root, spec, K, IV))

        await save_video_result(
            video_id=video_id,
            contentKey=K.hex(),
            iv=IV.hex(),
            keyVariant="",
            duration=duration,
            renditions=renditions,
            status="ready",
        )
        # Fresh key material now lives in Convex; drop any stale cache entry.
        invalidate_key_cache(video_id)
    except Exception as exc:  # noqa: BLE001 - report every failure back to Convex
        try:
            await save_video_result(
                video_id=video_id,
                contentKey="",
                iv="",
                keyVariant="",
                duration=0,
                renditions=[],
                status="failed",
            )
        except Exception:  # noqa: BLE001 - best-effort failure report
            pass
        # Re-raise so the error is visible in server logs.
        raise RuntimeError(f"process_video({video_id}) failed: {exc}") from exc
    finally:
        shutil.rmtree(work_root, ignore_errors=True)
