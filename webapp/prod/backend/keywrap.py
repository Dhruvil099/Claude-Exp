"""AES key-wrap logic — ported EXACTLY from hls_clone/server.py.

Each call to `wrap()` produces a FRESHLY randomized blob whose two ciphertext
chunks unwrap (two AES-128-ECB passes) to the SAME constant content key, just
like the reference origin server. The player (crypto-js) reverses it:
    inter = AES_ECB_dec(blob[g], stage1key)
    key   = AES_ECB_dec(blob[v], inter)
"""
import secrets

from Crypto.Cipher import AES

# URI suffix after /k/timestamp/ -> (g_range, v_range)
#   g = range holding AES_ECB(stage1key, inter)  -> unwraps to `inter`
#   v = range holding AES_ECB(inter,     K)      -> unwraps to content key K
VARIANTS = {
    "":     ((32, 48), (0, 16)),   # default -> URI "k/timestamp"
    "scw":  ((32, 48), (0, 16)),
    "w1q":  ((0, 16),  (32, 48)),
    "sdq":  ((32, 48), (8, 24)),
    "aav":  ((48, 64), (0, 16)),
    "scs":  ((48, 64), (16, 32)),
    "sxc":  ((0, 16),  (48, 64)),
    "q1wq": ((16, 32), (48, 64)),
}


def _ecb_encrypt(key: bytes, pt: bytes) -> bytes:
    """Single-block AES-128-ECB encrypt (16-byte key + 16-byte plaintext)."""
    return AES.new(key, AES.MODE_ECB).encrypt(pt)


def wrap(pp: str, apkId: str, contentKey: bytes) -> bytes:
    """Build a wrapped-key blob for variant `pp`.

    Args:
        pp:         variant suffix ("" for the default "k/timestamp").
        apkId:      64-hex public per-video id; stage1key = hex(apkId[0:16]+apkId[48:64]).
        contentKey: raw 16-byte AES content key K.

    Returns the randomized blob (bytes). Remaining/unused bytes are printable
    ASCII decoy so the blob looks like an opaque token.
    """
    stage1key = bytes.fromhex(apkId[0:16] + apkId[48:64])
    (g0, g1), (v0, v1) = VARIANTS.get(pp, VARIANTS[""])
    size = max(g1, v1)
    inter = secrets.token_bytes(16)                     # fresh ephemeral each request
    blob = bytearray(size)
    blob[g0:g1] = _ecb_encrypt(stage1key, inter)        # -> unwraps to `inter`
    blob[v0:v1] = _ecb_encrypt(inter, contentKey)       # -> unwraps to content key K
    used = set(range(g0, g1)) | set(range(v0, v1))      # remaining bytes = printable decoy
    for i in range(size):
        if i not in used:
            blob[i] = 0x21 + secrets.randbelow(0x7e - 0x21)
    return bytes(blob)
