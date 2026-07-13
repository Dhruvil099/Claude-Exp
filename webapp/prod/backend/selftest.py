#!/usr/bin/env python3
"""Offline crypto self-test — proves the port before deploy (no network/ffmpeg).

For every VARIANT:
  1. GLOBAL apkId + per-video content key + GLOBAL IV
  2. AES-128-CBC + PKCS7 encrypt a tiny fake TS buffer (starts with 0x47 sync)
  3. wrap() the key into a blob
  4. UNWRAP with the same two-stage AES-ECB math the crypto-js player uses
  5. assert recovered key == content key AND the decrypt yields the 0x47 TS sync

(The stream token is now an opaque 32-hex value validated by a Convex DB lookup,
so it is exercised by the /validateStreamToken integration, not this offline test.)

Run:  python3 selftest.py
"""
import os
import secrets
import sys

from Crypto.Cipher import AES
from Crypto.Util.Padding import pad, unpad

from keywrap import VARIANTS, wrap

# GLOBAL constants (env APK_ID / CONTENT_IV), same for every video/user.
_CONTENT_IV = bytes.fromhex(os.environ.get("CONTENT_IV", "496daa1c6914000e408c65cead91fc29"))


def _make_global_apkid():
    stage1key = secrets.token_bytes(16)
    s = stage1key.hex()
    filler = secrets.token_bytes(16).hex()
    return s[:16] + filler + s[16:]


def _unwrap(blob: bytes, apkId: str, variant: str) -> bytes:
    """Reverse wrap() with the player's two AES-128-ECB decrypt passes."""
    stage1key = bytes.fromhex(apkId[0:16] + apkId[48:64])
    (g0, g1), (v0, v1) = VARIANTS[variant]
    inter = AES.new(stage1key, AES.MODE_ECB).decrypt(blob[g0:g1])
    return AES.new(inter, AES.MODE_ECB).decrypt(blob[v0:v1])


def main() -> int:
    apkId = _make_global_apkid()          # one constant for every video/user
    IV = _CONTENT_IV                       # global IV, like Spayee
    plaintext = bytes([0x47]) + secrets.token_bytes(187)  # fake TS packet (0x47 sync)

    for variant in VARIANTS:
        K = secrets.token_bytes(16)        # per-video content key
        ct = AES.new(K, AES.MODE_CBC, IV).encrypt(pad(plaintext, 16))
        blob = wrap(variant, apkId, K)
        recovered = _unwrap(blob, apkId, variant)
        assert recovered == K, f"[{variant or 'default'}] key mismatch"
        pt = unpad(AES.new(recovered, AES.MODE_CBC, IV).decrypt(ct), 16)
        assert pt == plaintext, f"[{variant or 'default'}] plaintext mismatch"
        assert pt[0] == 0x47, f"[{variant or 'default'}] missing TS sync 0x47"
        print(f"OK  variant={variant or '(default)':9}  key+decrypt verified")

    print("\nALL VARIANTS PASSED — crypto port is correct.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
