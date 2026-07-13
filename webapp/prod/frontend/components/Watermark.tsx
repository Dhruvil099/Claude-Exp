"use client";

import { useEffect, useState } from "react";

/**
 * Per-user watermark overlay — Spayee-style leak tracing.
 *
 * Mirrors scoursePlayer's Ia(): a faint, non-interactive text overlay (the
 * viewer's email + a short session tag from the stream token) drawn on top of
 * the <video>, repositioned periodically so any screenshot / screen-recording
 * captures the identity of whoever leaked it. It is a render-time overlay — the
 * shared encrypted segments are untouched — so it costs nothing per user.
 *
 * (Like all client-side watermarks, a determined user can strip the DOM node;
 * it deters casual leaking and traces screen-captures, which is its purpose.)
 */
export default function Watermark({ text }: { text: string }) {
  const [pos, setPos] = useState<{ top: string; left: string }>({
    top: "12%",
    left: "10%",
  });
  // Spayee's Ia() renders "location.host | name | email"; prepend the host here.
  const [label, setLabel] = useState(text);
  useEffect(() => {
    const host = typeof window !== "undefined" ? window.location.host : "";
    setLabel(host ? `${host} | ${text}` : text);
  }, [text]);

  useEffect(() => {
    const move = () => {
      // Keep the text comfortably inside the frame (percent-based).
      const top = 8 + Math.random() * 78; // 8%..86%
      const left = 5 + Math.random() * 62; // 5%..67% (leaves room for the text)
      setPos({ top: `${top}%`, left: `${left}%` });
    };
    move();
    const id = setInterval(move, 7000); // reposition every 7s
    return () => clearInterval(id);
  }, []);

  return (
    <div className="watermark" style={{ top: pos.top, left: pos.left }} aria-hidden="true">
      {label}
    </div>
  );
}
