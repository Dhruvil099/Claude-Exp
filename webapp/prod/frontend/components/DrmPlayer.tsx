"use client";

import { useEffect, useRef, useState } from "react";
import Watermark from "./Watermark";

/**
 * DrmPlayer — REAL DRM tier (Widevine / PlayReady / FairPlay), a faithful React
 * port of Spayee's drmPlayer.js (see 47.md). Uses Shaka Player + PallyCon/DoveRunner.
 *
 *  ⚠️ SCAFFOLD — requires:
 *    • a PallyCon/DoveRunner (or other Multi-DRM) account + credentials
 *    • content packaged with CENC (cbcs) — see DRM_SETUP.md / backend/drm.py
 *    • Shaka Player loaded (add "shaka-player" to package.json; imported dynamically below)
 *    • DRM-capable browser: FairPlay→Safari(Mac/iOS), PlayReady→Edge(Windows), Widevine→Chrome/Firefox
 *  It CANNOT run without those; there is no way to test DRM locally here.
 *
 * Unlike the AES-128 tier, the content key never reaches JS — it lives in the
 * browser/OS CDM — so there is no apkId to read and no key to unwrap. This is the
 * only tier that actually stops a technical downloader.
 */

const LICENSE_SERVER = "https://drm-license.doverunner.com/ri/licenseManager.do";
const FAIRPLAY_CERT_URL = "https://drm-license.doverunner.com/ri/fpsKeyManager.do?siteId=";

type Props = {
  /** DASH .mpd (Widevine/PlayReady) or HLS fMP4 (FairPlay) manifest URL. */
  manifestUrl: string;
  /** PallyCon license token (pallycon-customdata-v2), minted by the backend. */
  drmToken: string;
  /** PallyCon site id (for the FairPlay certificate fetch). */
  siteId: string;
  title: string;
  watermark?: string;
};

// Mirrors drmPlayer.js x(): which DRM this browser/OS supports.
function detectDrm(): { allowed: boolean; drmType?: string; message?: string } {
  const ua = navigator.userAgent;
  const plat = navigator.platform || "";
  const isWin = /Win/.test(plat) || /Windows/.test(ua);
  const isMac = /Mac/.test(plat) && !/iPad|iPhone|iPod/.test(ua);
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (plat === "MacIntel" && navigator.maxTouchPoints > 1);
  const isSafari = /Safari/.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  const isEdge = /Edg\//.test(ua) || /Edge\//.test(ua);
  const isChromeLike = /Chrome|Chromium|CriOS/.test(ua) && !isEdge;
  const isFirefox = /Firefox|FxiOS/.test(ua);

  if (isSafari && (isMac || isIOS)) return { allowed: true, drmType: "FairPlay" };
  if (isEdge && isWin) return { allowed: true, drmType: "PlayReady" };
  if ((isChromeLike || isFirefox) && !isIOS) return { allowed: true, drmType: "Widevine" };
  if (isIOS) return { allowed: false, message: "Open this video in Safari to watch." };
  if (isWin) return { allowed: false, message: "Open this video in Microsoft Edge to watch." };
  return { allowed: false, message: "Use Safari (Mac/iOS), Edge (Windows), or Chrome/Firefox." };
}

export default function DrmPlayer({ manifestUrl, drmToken, siteId, title, watermark }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let player: any;
    let cancelled = false;

    (async () => {
      const gate = detectDrm();
      if (!gate.allowed) {
        setError(gate.message ?? "DRM not supported on this browser.");
        return;
      }
      // Dynamic import so the app builds without shaka installed until you enable DRM.
      let shaka: any;
      try {
        // Optional dep — dynamic (non-literal) import so the app builds without it.
        const shakaModule = "shaka-player";
        const mod: any = await import(/* webpackIgnore: true */ shakaModule);
        shaka = mod.default ?? mod;
      } catch {
        setError("shaka-player is not installed. `npm i shaka-player` and enable the DRM tier.");
        return;
      }
      shaka.polyfill.installAll();
      if (!shaka.Player.isBrowserSupported()) {
        setError("This browser cannot play DRM content.");
        return;
      }
      const video = videoRef.current;
      if (!video || cancelled) return;

      player = new shaka.Player(video);
      const drmType = gate.drmType!;

      // ---- configure PallyCon/DoveRunner license server (mirrors drmPlayer.js) ----
      const config: any = { drm: { servers: {} as Record<string, string> } };
      if (drmType === "FairPlay") {
        // FairPlay needs the app certificate first.
        const certResp = await fetch(FAIRPLAY_CERT_URL + encodeURIComponent(siteId));
        const cert = new Uint8Array(await certResp.arrayBuffer());
        config.streaming = { useNativeHlsForFairPlay: false };
        config.drm.servers["com.apple.fps"] = LICENSE_SERVER;
        config.drm.advanced = { "com.apple.fps": { serverCertificate: cert } };
      } else if (drmType === "PlayReady") {
        config.drm.servers["com.microsoft.playready"] = LICENSE_SERVER;
        config.drm.advanced = {
          "com.microsoft.playready": { videoRobustness: "SW_SECURE_DECODE", audioRobustness: "" },
        };
      } else {
        config.drm.servers["com.widevine.alpha"] = LICENSE_SERVER;
      }
      player.configure(config);

      // PallyCon customdata token on every license request (mirrors drmPlayer.js filter).
      player.getNetworkingEngine().registerRequestFilter((type: any, request: any) => {
        if (type === shaka.net.NetworkingEngine.RequestType.LICENSE) {
          request.headers["pallycon-customdata-v2"] = drmToken;
          if (drmType === "FairPlay") {
            const body = new Uint8Array(request.body);
            const spc = shaka.util.Uint8ArrayUtils.toBase64(body);
            request.body = shaka.util.StringUtils.toUTF8("spc=" + encodeURIComponent(spc));
            request.headers["Content-Type"] = "application/x-www-form-urlencoded";
          }
        }
      });
      player.getNetworkingEngine().registerResponseFilter((type: any, response: any) => {
        if (type === shaka.net.NetworkingEngine.RequestType.LICENSE && drmType === "FairPlay") {
          const txt = shaka.util.StringUtils.fromUTF8(response.data).trim();
          if (txt.indexOf("errorCode") < 0) {
            response.data = shaka.util.Uint8ArrayUtils.fromBase64(txt).buffer;
          }
        }
      });

      player.addEventListener("error", (e: any) =>
        setError(`DRM playback error: ${e?.detail?.code ?? "unknown"}`),
      );
      try {
        await player.load(manifestUrl);
      } catch (e: any) {
        setError(`Failed to load DRM manifest: ${e?.code ?? e}`);
      }
    })();

    return () => {
      cancelled = true;
      if (player) player.destroy();
    };
  }, [manifestUrl, drmToken, siteId]);

  return (
    <div>
      <div className="player-wrap">
        <video
          ref={videoRef}
          controls
          playsInline
          controlsList="nodownload noremoteplayback"
          disablePictureInPicture
          onContextMenu={(e) => e.preventDefault()}
        />
        {watermark ? <Watermark text={watermark} /> : null}
      </div>
      <div className="notice">
        <strong>Video not available for download — streaming only (DRM protected).</strong>
      </div>
      {error && (
        <div className="notice" style={{ color: "var(--danger)" }}>
          {error}
        </div>
      )}
    </div>
  );
}
