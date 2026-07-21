"use client";

/**
 * Camera QR scanner for the phone connect screen (design 8b, scan-first).
 *
 * getUserMedia + jsQR (pure JS — iOS Safari has no BarcodeDetector) over a
 * downscaled canvas at rAF cadence. Requires a secure context (HTTPS or
 * localhost); callers gate on `canScanQr()` before rendering.
 *
 * Visual: primary corner brackets + the `homekb-scan` line + a faint QR glyph hint,
 * per the design handoff. Decodes the pairing-link payload contract
 * (docs/ARCHITECTURE.md "Pairing link (QR payload)").
 */

import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { useTranslation } from "react-i18next";
import i18n from "@/lib/i18n";
import { parsePairingLink, type PairingLink } from "@/lib/client/connection";
import { IconQr } from "./icons";

/** Camera scanning is possible: capable API + secure context (getUserMedia requires it). */
export function canScanQr(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    window.isSecureContext
  );
}

/** Phone-shaped device (drives scan-first vs manual-first per design 8a/8b). */
export function isCoarsePointer(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
}

function cameraErrorMessage(e: unknown): string {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return i18n.t("pair.scanner.cameraDenied");
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return i18n.t("pair.scanner.cameraNotFound");
  }
  return i18n.t("pair.scanner.cameraFailed");
}

/** One corner bracket of the viewfinder (rotated for each corner). */
function Bracket({ className }: { className: string }) {
  return (
    <span
      className={`pointer-events-none absolute h-7 w-7 rounded-tl-[10px] border-t-2 border-l-2 border-primary ${className}`}
      aria-hidden
    />
  );
}

export function QrScanner({
  onResult,
  onUnavailable,
}: {
  /** Fired once with the decoded pairing link (relay or direct); the camera is stopped first. */
  onResult: (link: PairingLink) => void;
  /** Camera failed to start (denied / missing) — caller falls back to manual entry. */
  onUnavailable: (message: string) => void;
}) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [starting, setStarting] = useState(true);
  // A QR was decoded but it isn't a HomeKB pairing link — show a hint.
  const [badQr, setBadQr] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    let raf = 0;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    let lastMiss = 0;

    const stop = () => {
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
    };

    const tick = () => {
      const video = videoRef.current;
      if (cancelled) return;
      if (video && ctx && video.readyState >= video.HAVE_ENOUGH_DATA) {
        // Downscale to ~480px on the long edge — plenty for QR, cheap to decode.
        const scale = Math.min(1, 480 / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const found = jsQR(img.data, img.width, img.height, {
          inversionAttempts: "dontInvert",
        });
        if (found?.data) {
          const link = parsePairingLink(found.data);
          if (link) {
            stop();
            onResult(link);
            return;
          }
          // A QR, but not ours — hint and keep scanning (rate-limited).
          const now = Date.now();
          if (now - lastMiss > 2000) {
            lastMiss = now;
            setBadQr(true);
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        if (cancelled) return stream.getTracks().forEach((t) => t.stop());
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        // iOS Safari: must be inline + muted to autoplay inside the page.
        video.setAttribute("playsinline", "true");
        video.muted = true;
        await video.play();
        setStarting(false);
        raf = requestAnimationFrame(tick);
      } catch (e) {
        if (!cancelled) onUnavailable(cameraErrorMessage(e));
      }
    })();

    return () => {
      cancelled = true;
      stop();
    };
    // onResult/onUnavailable are stable callbacks from the caller (useRef'd there or inline-once).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col items-center">
      <div className="relative h-60 w-60 overflow-hidden rounded-3xl bg-black/60">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- silent camera preview */}
        <video ref={videoRef} className="absolute inset-0 h-full w-full object-cover" />
        {/* Faint QR hint while the camera warms up / between frames */}
        <span className="absolute inset-0 flex items-center justify-center text-white/25">
          <IconQr size={64} strokeWidth={1.2} />
        </span>
        {/* Primary corner brackets */}
        <Bracket className="top-3 left-3" />
        <Bracket className="top-3 right-3 rotate-90" />
        <Bracket className="bottom-3 right-3 rotate-180" />
        <Bracket className="bottom-3 left-3 -rotate-90" />
        {/* Animated scan line */}
        {!starting && (
          <span
            className="hk-scan absolute top-1/2 right-6 left-6 h-[2px] rounded-full bg-primary/80"
            style={{ "--hk-scan-amp": "84px" } as React.CSSProperties}
            aria-hidden
          />
        )}
      </div>
      <p className="mt-4 max-w-[260px] text-center text-[13px] leading-relaxed text-base-content/60">
        {t("pair.scanner.pointCamera")}
      </p>
      {badQr && (
        <p className="mt-2 max-w-[260px] text-center text-[12px] leading-relaxed text-hk-orange-text">
          {t("pair.scanner.notPairingQr")}
        </p>
      )}
    </div>
  );
}
