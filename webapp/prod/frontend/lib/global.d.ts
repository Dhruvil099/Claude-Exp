// Global augmentation: the ported key-unwrap logic reads the current video's
// apkId from window.apkId (exactly as the original hls_clone/www/player.html does).
export {};

declare global {
  interface Window {
    apkId?: string;
    // Exposed by the obfuscated /vh-hls-core.min.js: the two-stage AES-128-ECB
    // key unwrap (Spayee-hls.min.js parity). Returns the 16-byte content key.
    __vhUnwrap?: (blob: Uint8Array, url: string) => Uint8Array;
  }
}
