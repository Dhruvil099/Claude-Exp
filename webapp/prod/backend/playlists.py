"""Build master + variant .m3u8 strings — EXACT Spayee layout.

  master  -> #EXT-X-MEDIA audio group + one #EXT-X-STREAM-INF per video variant,
             variant URIs RELATIVE ("hls_1M_.m3u8") so they resolve against the
             /u/<token>/videos/<id>/index.m3u8 request URL.
  variant -> header + #EXT-X-KEY:METHOD=AES-128,URI="k/timestamp",IV=0x<iv>
             + one #EXTINF + RELATIVE .ts segment name per segment + #EXT-X-ENDLIST
             (e.g. "hls_1M_000.ts" — the backend proxies these to Convex storage,
             so the client never sees the storage URL: exactly like qcdn.)
"""
from __future__ import annotations

import math
from typing import Any

AUDIO_GROUP_ID = "audio-0"


def segment_name(rendition_name: str, index: int) -> str:
    """"hls_1M_", 3 -> "hls_1M_003.ts" (Spayee-style zero-padded segment name)."""
    return f"{rendition_name}{index:03d}.ts"


def _key_uri(key_variant: str) -> str:
    """Relative KEY URI. Default -> "k/timestamp"; variant -> "k/timestamp/<v>"."""
    key_variant = (key_variant or "").strip()
    return "k/timestamp" if not key_variant else f"k/timestamp/{key_variant}"


def build_master(renditions: list[dict[str, Any]]) -> str:
    """Master playlist: audio media line + video STREAM-INF entries (relative URIs)."""
    lines = ["#EXTM3U", "#EXT-X-VERSION:3"]

    audio = next((r for r in renditions if r.get("isAudio")), None)
    if audio is not None:
        group = audio.get("groupId") or AUDIO_GROUP_ID
        lines.append(
            f'#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="{group}",NAME="eng",'
            f'LANGUAGE="eng",DEFAULT=YES,AUTOSELECT=YES,'
            f'URI="{audio["name"]}.m3u8"'
        )

    videos = [r for r in renditions if not r.get("isAudio")]
    videos.sort(key=lambda r: r.get("bandwidth", 0))
    for r in videos:
        attrs = [f'AUDIO="{AUDIO_GROUP_ID}"', f'BANDWIDTH={int(r.get("bandwidth", 0))}']
        if r.get("codecs"):
            attrs.append(f'CODECS="{r["codecs"]}"')
        if r.get("resolution"):
            attrs.append(f'RESOLUTION={r["resolution"]}')
        lines.append("#EXT-X-STREAM-INF:" + ",".join(attrs))
        lines.append(f'{r["name"]}.m3u8')

    return "\n".join(lines) + "\n"


def build_variant(rendition: dict[str, Any], iv_hex: str, key_variant: str) -> str:
    """Variant playlist: EXT-X-KEY + relative .ts segment names (proxied by the backend)."""
    segments = rendition.get("segments", [])
    max_dur = max((float(s.get("duration", 0)) for s in segments), default=0.0)
    target = max(1, math.ceil(max_dur))
    name = rendition["name"]

    lines = [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        f"#EXT-X-TARGETDURATION:{target}",
        "#EXT-X-MEDIA-SEQUENCE:0",
        # (Spayee variant playlists do NOT emit #EXT-X-PLAYLIST-TYPE.)
        f'#EXT-X-KEY:METHOD=AES-128,URI="{_key_uri(key_variant)}",IV=0x{iv_hex}',
    ]
    for i, s in enumerate(segments):
        lines.append(f'#EXTINF:{float(s.get("duration", 0)):.6f},')
        lines.append(segment_name(name, i))   # relative .ts name, e.g. hls_1M_000.ts
    lines.append("#EXT-X-ENDLIST")

    return "\n".join(lines) + "\n"
