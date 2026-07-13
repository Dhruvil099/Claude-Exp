"use client";

import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import CryptoJS from "crypto-js";
import Watermark from "./Watermark";

/**
 * VideoPlayer — protected AES-128 HLS playback.
 *
 * The WrappedKeyLoader + unwrapKey + VARIANTS + u8ToWA/waToU8 below are ported
 * EXACTLY (byte-for-byte semantics) from hls_clone/www/player.html. hls.js
 * requests the AES-128 key from the backend's ".../k/timestamp[/<variant>]"
 * endpoint, which returns a freshly-randomized wrapped blob. We intercept that
 * request, run the two-stage AES-128-ECB unwrap using window.apkId, and hand
 * hls.js the real 16-byte content key.
 */

type Props = {
  apkId: string;
  masterUrl: string;
  title: string;
  /** Per-user watermark text (email + short session tag) for leak tracing. */
  watermark?: string;
};

// ---- ported EXACTLY from hls_clone/www/player.html --------------------------

const hex = (u8: Uint8Array): string =>
  [...u8].map((x) => x.toString(16).padStart(2, "0")).join("");

// URI suffix after /timestamp/  ->  [g_range, v_range]   (identical to the origin)
const VARIANTS: Record<string, [[number, number], [number, number]]> = {
  "": [[32, 48], [0, 16]],
  scw: [[32, 48], [0, 16]],
  w1q: [[0, 16], [32, 48]],
  sdq: [[32, 48], [8, 24]],
  aav: [[48, 64], [0, 16]],
  scs: [[48, 64], [16, 32]],
  sxc: [[0, 16], [48, 64]],
  q1wq: [[16, 32], [48, 64]],
};

const u8ToWA = (u8: Uint8Array) => CryptoJS.enc.Hex.parse(hex(u8));

const waToU8 = (wa: CryptoJS.lib.WordArray): Uint8Array => {
  const h = wa.toString(CryptoJS.enc.Hex);
  const u = new Uint8Array(h.length / 2);
  for (let i = 0; i < u.length; i++) u[i] = parseInt(h.substr(i * 2, 2), 16);
  return u;
};

// The exact two-stage AES-128-ECB unwrap from Spayee's hls.min.js.
function unwrapKey(blob: Uint8Array, url: string): Uint8Array {
  const pp = url.includes("/k/timestamp/")
    ? url.split("/k/timestamp/")[1].replace(/\/$/, "")
    : "";
  const [g, v] = VARIANTS[pp] || VARIANTS[""];
  const cfg = { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.NoPadding };
  const stage1 = CryptoJS.enc.Hex.parse(
    window.apkId!.substring(0, 16) + window.apkId!.substring(48)
  );
  const inter = CryptoJS.AES.decrypt(
    { ciphertext: u8ToWA(blob.subarray(g[0], g[1])) } as CryptoJS.lib.CipherParams,
    stage1,
    cfg
  );
  const realkey = CryptoJS.AES.decrypt(
    { ciphertext: u8ToWA(blob.subarray(v[0], v[1])) } as CryptoJS.lib.CipherParams,
    inter,
    cfg
  );
  return waToU8(realkey);
}

// hls.js loader that intercepts the key request and returns the unwrapped 16-byte key.
function makeWrappedKeyLoader() {
  return class WrappedKeyLoader extends (Hls.DefaultConfig.loader as any) {
    load(context: any, config: any, callbacks: any) {
      if (context.url.includes("/k/timestamp")) {
        const orig = callbacks.onSuccess;
        callbacks = Object.assign({}, callbacks, {
          onSuccess: (resp: any, stats: any, ctx: any, net: any) => {
            const blob = new Uint8Array(resp.data);
            const key = unwrapKey(blob, ctx.url);
            resp.data = key.buffer;
            orig(resp, stats, ctx, net);
          },
        });
        context.responseType = "arraybuffer";
      }
      super.load(context, config, callbacks);
    }
  };
}

// -----------------------------------------------------------------------------

export default function VideoPlayer({ apkId, masterUrl, title, watermark }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Expose apkId to the ported unwrap logic (matches original player.html).
    window.apkId = apkId;

    if (!Hls.isSupported()) {
      // Native HLS (Safari) cannot run the custom key unwrap.
      setError(
        "This browser cannot run the protected-key unwrap. Please use Chrome, Edge, or Firefox."
      );
      return;
    }

    const hls = new Hls({ loader: makeWrappedKeyLoader() as any });
    hls.loadSource(masterUrl);
    hls.attachMedia(video);
    hls.on(Hls.Events.ERROR, (_e, d) => {
      if (d.fatal) {
        setError(`Playback error: ${d.type} / ${d.details}`);
      }
    });

    return () => {
      hls.destroy();
    };
  }, [apkId, masterUrl]);

  return (
    <section aria-label={`Video player: ${title}`}>
      <div className="player-wrap">
        <video
          ref={videoRef}
          controls
          playsInline
          aria-label={title}
          controlsList="nodownload noremoteplayback"
          disablePictureInPicture
          // No downloads: block the right-click context menu on the video.
          onContextMenu={(e) => e.preventDefault()}
        />
        {/* Per-user leak-tracing watermark drawn over the video. */}
        {watermark ? <Watermark text={watermark} /> : null}
      </div>

      {/* Required visible notice — free to watch, streaming only. */}
      <div className="notice">
        <span className="notice-icon" aria-hidden="true">
          🔒
        </span>
        <strong>Video not available for download — streaming only.</strong>
      </div>

      {error && (
        <div className="alert alert-danger" role="alert">
          <span aria-hidden="true">⚠️</span>
          <span>{error}</span>
        </div>
      )}
    </section>
  );
}
