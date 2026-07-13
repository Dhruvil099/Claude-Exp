// SOURCE for public/vh-hls-core.min.js — NOT shipped as-is. This is bundled
// (esbuild) + obfuscated (javascript-obfuscator) into the public/ file the player
// loads at runtime, so the AES-key-unwrap logic is not readable in the browser's
// Sources tab (parity with Spayee's obfuscated hls.min.js). Regenerate with:
//   tools/player-core/build.sh
//
// The two-stage AES-128-ECB unwrap is byte-for-byte identical to the logic that
// used to live inline in components/VideoPlayer.tsx. It reads the global apkId
// from window.apkId and exposes window.__vhUnwrap(blob, url) -> Uint8Array key.
import CryptoJS from "crypto-js";

const hex = (u8) => [...u8].map((x) => x.toString(16).padStart(2, "0")).join("");

// URI suffix after /timestamp/ -> [g_range, v_range]
const VARIANTS = {
  "": [[32, 48], [0, 16]],
  scw: [[32, 48], [0, 16]],
  w1q: [[0, 16], [32, 48]],
  sdq: [[32, 48], [8, 24]],
  aav: [[48, 64], [0, 16]],
  scs: [[48, 64], [16, 32]],
  sxc: [[0, 16], [48, 64]],
  q1wq: [[16, 32], [48, 64]],
};

const u8ToWA = (u8) => CryptoJS.enc.Hex.parse(hex(u8));

const waToU8 = (wa) => {
  const h = wa.toString(CryptoJS.enc.Hex);
  const u = new Uint8Array(h.length / 2);
  for (let i = 0; i < u.length; i++) u[i] = parseInt(h.substr(i * 2, 2), 16);
  return u;
};

function unwrapKey(blob, url) {
  const pp = url.includes("/k/timestamp/")
    ? url.split("/k/timestamp/")[1].replace(/\/$/, "")
    : "";
  const [g, v] = VARIANTS[pp] || VARIANTS[""];
  const cfg = { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.NoPadding };
  const stage1 = CryptoJS.enc.Hex.parse(
    window.apkId.substring(0, 16) + window.apkId.substring(48)
  );
  const inter = CryptoJS.AES.decrypt(
    { ciphertext: u8ToWA(blob.subarray(g[0], g[1])) },
    stage1,
    cfg
  );
  const realkey = CryptoJS.AES.decrypt(
    { ciphertext: u8ToWA(blob.subarray(v[0], v[1])) },
    inter,
    cfg
  );
  return waToU8(realkey);
}

window.__vhUnwrap = function (blob, url) {
  return unwrapKey(blob, url);
};
