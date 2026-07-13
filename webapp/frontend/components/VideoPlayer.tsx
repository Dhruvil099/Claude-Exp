"use client";

import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import Watermark from "./Watermark";

/**
 * VideoPlayer — protected AES-128 HLS playback.
 *
 * The AES-128 key served from ".../k/timestamp[/<variant>]" is a freshly
 * randomized wrapped blob. The two-stage AES-128-ECB unwrap (keyed off
 * window.apkId) does NOT live here — it ships as the separately obfuscated
 * /vh-hls-core.min.js (parity with Spayee's obfuscated hls.min.js), which
 * exposes window.__vhUnwrap(blob, url) -> 16-byte content key. We load that
 * core, intercept the key request, and hand hls.js the real key.
 */

type Props = {
  apkId: string;
  masterUrl: string;
  title: string;
  /** Per-user watermark text (email + short session tag) for leak tracing. */
  watermark?: string;
};

const CORE_SRC = "/vh-hls-core.min.js";

// Load the obfuscated unwrap core once; resolves when window.__vhUnwrap is ready.
function loadUnwrapCore(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") return reject(new Error("no window"));
    if (window.__vhUnwrap) return resolve();
    const settle = () =>
      window.__vhUnwrap ? resolve() : reject(new Error("core missing unwrap"));
    const existing = document.querySelector<HTMLScriptElement>(
      "script[data-vh-core]"
    );
    if (existing) {
      existing.addEventListener("load", settle);
      existing.addEventListener("error", () =>
        reject(new Error("core load failed"))
      );
      return;
    }
    const s = document.createElement("script");
    s.src = CORE_SRC;
    s.async = true;
    s.setAttribute("data-vh-core", "");
    s.onload = settle;
    s.onerror = () => reject(new Error("core load failed"));
    document.head.appendChild(s);
  });
}

// hls.js loader that intercepts the key request and returns the unwrapped key.
function makeWrappedKeyLoader() {
  return class WrappedKeyLoader extends (Hls.DefaultConfig.loader as any) {
    load(context: any, config: any, callbacks: any) {
      if (context.url.includes("/k/timestamp")) {
        const orig = callbacks.onSuccess;
        callbacks = Object.assign({}, callbacks, {
          onSuccess: (resp: any, stats: any, ctx: any, net: any) => {
            const blob = new Uint8Array(resp.data);
            // Delegated to the obfuscated core (window.__vhUnwrap).
            const key = window.__vhUnwrap!(blob, ctx.url);
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

export default function VideoPlayer({ apkId, masterUrl, title, watermark }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Expose apkId to the obfuscated unwrap core (matches original player.html).
    window.apkId = apkId;

    if (!Hls.isSupported()) {
      // Native HLS (Safari) cannot run the custom key unwrap.
      setError(
        "This browser cannot run the protected-key unwrap. Please use Chrome, Edge, or Firefox."
      );
      return;
    }

    let hls: Hls | undefined;
    let destroyed = false;

    loadUnwrapCore()
      .then(() => {
        if (destroyed || !videoRef.current) return;
        hls = new Hls({ loader: makeWrappedKeyLoader() as any });
        hls.loadSource(masterUrl);
        hls.attachMedia(videoRef.current);
        hls.on(Hls.Events.ERROR, (_e, d) => {
          if (d.fatal) {
            setError(`Playback error: ${d.type} / ${d.details}`);
          }
        });
      })
      .catch(() =>
        setError("Could not load the player. Please refresh and try again.")
      );

    return () => {
      destroyed = true;
      if (hls) hls.destroy();
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
