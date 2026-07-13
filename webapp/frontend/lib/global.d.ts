// Global augmentation: the ported key-unwrap logic reads the current video's
// apkId from window.apkId (exactly as the original hls_clone/www/player.html does).
export {};

declare global {
  interface Window {
    apkId?: string;
  }
}
