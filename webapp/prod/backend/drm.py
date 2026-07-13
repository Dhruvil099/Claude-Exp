"""Real-DRM tier (Widevine / PlayReady / FairPlay) via PallyCon / DoveRunner.

  ⚠️ SCAFFOLD — cannot run or be verified here. It requires:
    * a PallyCon (DoveRunner) Multi-DRM account: PALLYCON_SITE_ID + PALLYCON_ACCESS_KEY
    * Shaka Packager installed on the box (`packager` binary) for CENC packaging
    * DRM-capable client browsers (Safari/Edge/Chrome)

Two responsibilities:
  1. build_packager_cmd(): the Shaka Packager command that produces CENC (cbcs) fMP4
     + a DASH .mpd (Widevine/PlayReady) and HLS fMP4 (FairPlay), encrypted with a
     content key fetched from PallyCon KMS (or supplied raw).
  2. make_license_token(): the `pallycon-customdata-v2` token the player sends on every
     license request (see DrmPlayer.tsx / drmPlayer.js).

IMPORTANT: PallyCon's token algorithm is version-specific. The structure below follows
PallyCon's "Token-based Multi-DRM" v2 shape, but you MUST confirm the exact field order,
policy encryption, and hash input against PallyCon's current docs + official sample code,
then drop in your real SITE_ID / ACCESS_KEY. Getting any byte wrong => license errors.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
from typing import Any

from Crypto.Cipher import AES
from Crypto.Util.Padding import pad

PALLYCON_SITE_ID = os.environ.get("PALLYCON_SITE_ID", "")
PALLYCON_ACCESS_KEY = os.environ.get("PALLYCON_ACCESS_KEY", "")  # 32 bytes for AES-256
LICENSE_SERVER = "https://drm-license.doverunner.com/ri/licenseManager.do"
FAIRPLAY_CERT_URL = "https://drm-license.doverunner.com/ri/fpsKeyManager.do"

# A minimal default playback policy (tighten per your rules: rentals, HDCP, offline...).
DEFAULT_POLICY = {"policy_version": 2, "playback_policy": {"persistent": False}}


def make_license_token(
    *, drm_type: str, user_id: str, content_id: str, timestamp: str,
    policy: dict[str, Any] | None = None,
) -> str:
    """Build the base64 PallyCon customdata-v2 token. VERIFY against PallyCon docs.

    drm_type: "Widevine" | "PlayReady" | "FairPlay"
    timestamp: UTC "YYYY-MM-DDTHH:MM:SSZ" (pass in; do not call time here to keep pure)
    """
    if not PALLYCON_SITE_ID or not PALLYCON_ACCESS_KEY:
        raise RuntimeError("PALLYCON_SITE_ID / PALLYCON_ACCESS_KEY not configured")
    key = PALLYCON_ACCESS_KEY.encode()[:32].ljust(32, b"\0")

    policy_json = json.dumps(policy or DEFAULT_POLICY).encode()
    iv = hashlib.sha256((user_id + content_id + timestamp).encode()).digest()[:16]
    enc = AES.new(key, AES.MODE_CBC, iv).encrypt(pad(policy_json, 16))
    policy_b64 = base64.b64encode(iv + enc).decode()

    hash_input = (
        PALLYCON_ACCESS_KEY + drm_type + PALLYCON_SITE_ID + user_id
        + content_id + policy_b64 + timestamp
    ).encode()
    token_obj = {
        "drm_type": drm_type,
        "site_id": PALLYCON_SITE_ID,
        "user_id": user_id,
        "cid": content_id,
        "policy": policy_b64,
        "timestamp": timestamp,
        "hash": base64.b64encode(hashlib.sha256(hash_input).digest()).decode(),
        "response_format": "original",
        "key_rotation": False,
    }
    return base64.b64encode(json.dumps(token_obj).encode()).decode()


def build_packager_cmd(
    *, video_in: str, audio_in: str, out_dir: str,
    key_id_hex: str, key_hex: str,
) -> list[str]:
    """Shaka Packager command: CENC (cbcs) fMP4 + DASH .mpd + HLS fMP4.

    key_id_hex/key_hex come from PallyCon KMS (CPIX) or your own key server. cbcs is
    used because it covers FairPlay + Widevine/PlayReady from one packaging.
    """
    return [
        "packager",
        f"in={video_in},stream=video,init_segment={out_dir}/v_init.mp4,"
        f"segment_template={out_dir}/v_$Number$.m4s,drm_label=HD",
        f"in={audio_in},stream=audio,init_segment={out_dir}/a_init.mp4,"
        f"segment_template={out_dir}/a_$Number$.m4s,drm_label=AUDIO",
        "--enable_raw_key_encryption",
        "--protection_scheme", "cbcs",
        "--keys",
        f"label=HD:key_id={key_id_hex}:key={key_hex},"
        f"label=AUDIO:key_id={key_id_hex}:key={key_hex}",
        "--mpd_output", f"{out_dir}/playlist.mpd",
        "--hls_master_playlist_output", f"{out_dir}/master.m3u8",
    ]


def cert_url() -> str:
    return f"{FAIRPLAY_CERT_URL}?siteId={PALLYCON_SITE_ID}"
