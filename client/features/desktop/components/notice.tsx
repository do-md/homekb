"use client";
import { useDesktopStore } from "../store/desktop-store";

/** Floating pill for desktop-store flash messages (key saved, tunnel errors, …). */
export function DesktopNotice() {
  const notice = useDesktopStore((s) => s.state.notice);
  if (!notice) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-8 z-30 flex justify-center px-4">
      <div
        className="rounded-full border border-base-200 bg-hk-composer px-4 py-2 text-[13px] text-base-content backdrop-blur-md"
        style={{ boxShadow: "0 4px 16px rgba(0,0,0,0.25)" }}
      >
        {notice}
      </div>
    </div>
  );
}
