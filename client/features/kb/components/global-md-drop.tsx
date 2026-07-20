"use client";

/**
 * Global Markdown drag-import (docs/ARCHITECTURE.md "Markdown file import"):
 * drop a `.md` file anywhere in the paired app — any tab, web and desktop, one
 * HTML5 code path — and it lands in the library as a new note via kb.create
 * (KbStore.importMarkdownFiles). Mounted once from Chrome (shell.tsx) so every
 * route is covered; the public share viewer (`/s`) lives outside the shell and
 * deliberately has no import.
 *
 * Event wiring (window, capture phase — runs *before* the editor's image
 * paste/drop bridge, which is capture-phase on the editor container):
 * - The global handler claims only Markdown files; image drops pass through
 *   untouched so the editor bridge keeps owning them. Image-only drags never
 *   even show the overlay (dragLooksImportable).
 * - A bubble-phase drop fallback swallows any file drop nobody claimed —
 *   otherwise the browser would navigate away to the dropped file.
 * - Desktop: requires `dragDropEnabled: false` in tauri.conf.json — Tauri's
 *   native drag-drop interception would otherwise eat HTML5 file drops.
 */

import { useEffect, useState } from "react";
import {
  dragLooksImportable,
  isMarkdownFile,
  MD_IMPORT_MAX_BYTES,
} from "@/lib/client/md-drop";
import { useKbStoreApi } from "../store/kb-store";
import { IconDocPlus } from "./icons";

export function GlobalMdDrop() {
  const api = useKbStoreApi();
  const [active, setActive] = useState(false);

  useEffect(() => {
    // dragenter/dragleave fire per element crossed; the depth counter nets them
    // out (enter on the new target fires before leave on the previous one).
    let depth = 0;
    // Whether the current drag looks importable — decided on the 0→1 enter,
    // where items are reliably readable, and reused for the whole drag.
    let importable = false;

    const reset = () => {
      depth = 0;
      importable = false;
      setActive(false);
    };

    const importFiles = async (files: File[]) => {
      const oversize = files.filter((f) => f.size > MD_IMPORT_MAX_BYTES);
      if (oversize.length) {
        api.notify(`Too large to import as a note: ${oversize[0].name}`);
      }
      const fit = files.filter((f) => f.size <= MD_IMPORT_MAX_BYTES);
      if (!fit.length) return;
      const read = await Promise.all(
        fit.map(async (f) => ({ name: f.name, text: await f.text() })),
      );
      await api.importMarkdownFiles(read);
    };

    const onDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      if (depth === 0) importable = dragLooksImportable(e.dataTransfer);
      depth += 1;
      if (importable) setActive(true);
    };

    const onDragLeave = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      depth -= 1;
      if (depth <= 0) reset();
    };

    const onDragOver = (e: DragEvent) => {
      // preventDefault is required to make the page a drop target for files;
      // without it the drop never fires and the browser opens the file instead.
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };

    const onDrop = (e: DragEvent) => {
      const files = Array.from(e.dataTransfer?.files ?? []);
      const mds = files.filter(isMarkdownFile);
      if (mds.length) {
        // Claim Markdown ahead of deeper handlers (editor image bridge, DOMD
        // text drop) — none of them wants .md files.
        e.preventDefault();
        e.stopPropagation();
        void importFiles(mds);
      }
      reset();
    };

    // Bubble phase: fires last — anything a deeper handler claimed arrives
    // defaultPrevented. Swallow unclaimed file drops (browser would navigate
    // to the file) and explain when the drag had looked importable.
    const onDropFallback = (e: DragEvent) => {
      if (e.defaultPrevented) return;
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (!files.length) return;
      e.preventDefault();
      if (files.some((f) => !f.type.startsWith("image/"))) {
        api.notify("Only Markdown (.md) files can be imported");
      }
    };

    const onDragEnd = () => reset();

    window.addEventListener("dragenter", onDragEnter, true);
    window.addEventListener("dragleave", onDragLeave, true);
    window.addEventListener("dragover", onDragOver, true);
    window.addEventListener("drop", onDrop, true);
    window.addEventListener("drop", onDropFallback, false);
    window.addEventListener("dragend", onDragEnd, true);
    return () => {
      window.removeEventListener("dragenter", onDragEnter, true);
      window.removeEventListener("dragleave", onDragLeave, true);
      window.removeEventListener("dragover", onDragOver, true);
      window.removeEventListener("drop", onDrop, true);
      window.removeEventListener("drop", onDropFallback, false);
      window.removeEventListener("dragend", onDragEnd, true);
    };
  }, [api]);

  if (!active) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-40 bg-base-100/70 backdrop-blur-[2px]">
      {/* The whole window is the drop target — the dashed frame hugs the
          viewport edge to say so (a small centered box would read as
          "drop *inside this box*", which is wrong). */}
      <div className="absolute inset-3 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-primary">
        <span className="text-primary">
          <IconDocPlus size={28} strokeWidth={1.7} />
        </span>
        <div className="text-[15px] font-semibold text-base-content">
          Drop Markdown file
        </div>
        <div className="text-[13px] text-base-content/60">
          Added straight to your library
        </div>
      </div>
    </div>
  );
}
