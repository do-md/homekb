"use client";

/**
 * New note (design 5a): a focused compose mode — no pill nav. Pure WYSIWYG
 * Markdown editor; the first line becomes the title. Two actions only:
 * "Save draft" (saved to the home so every device sees it — needs home online)
 * and "Save to library" (writes to home, needs home online). Phone: actions in a
 * bottom bar (thumb zone); desktop: header. Leaving the view auto-stashes unsaved
 * content — the text is crash-safe on this device even offline, and promoted to a
 * shared draft as soon as the home is reachable.
 */

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { hashHref } from "@/lib/client/hash-route";
import { useKbStore, useKbStoreApi } from "../../store/kb-store";
import { KbEditor, type KbEditorHandle, titleFromMarkdown } from "../domd";
import { IconChevronLeft, Spinner, StatusDot } from "../icons";

function ActionButtons({ editorRef }: { editorRef: React.MutableRefObject<KbEditorHandle | null> }) {
  const api = useKbStoreApi();
  const busy = useKbStore((s) => s.state.newBusy);
  const connState = useKbStore((s) => s.connState);
  const online = connState === "online";

  const read = () => editorRef.current?.getMarkdown() ?? "";

  return (
    <>
      <button
        className="rounded-xl border border-base-300 px-3.5 py-2 text-[13.5px] font-semibold text-base-content/60 transition-colors hover:bg-base-200 disabled:opacity-50"
        disabled={!online}
        title={online ? undefined : "Home is offline — text is kept on this device until you reconnect"}
        onClick={() => void api.saveDraft(read())}
      >
        Save draft
      </button>
      <button
        className="flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-2 text-[13.5px] font-semibold text-primary-content transition-colors hover:bg-primary/90 disabled:opacity-50"
        disabled={busy || !online}
        title={online ? undefined : "Home is offline — reconnect to save"}
        onClick={() => {
          const md = read();
          void api.saveToLibrary(md, titleFromMarkdown(md));
        }}
      >
        {busy && <Spinner size={13} />}
        Save to library
      </button>
    </>
  );
}

export function NewNoteView() {
  const api = useKbStoreApi();
  const router = useRouter();
  const seed = useKbStore((s) => s.state.editorSeed);
  const session = useKbStore((s) => s.state.editorSession);
  const draftCount = useKbStore((s) => s.state.drafts.length);
  const savedPath = useKbStore((s) => s.state.newSavedPath);
  const error = useKbStore((s) => s.state.newError);
  const editorRef = useRef<KbEditorHandle | null>(null);
  const apiRef = useRef(api);
  apiRef.current = api;

  // Auto-stash on unmount (view switch): unsaved content becomes a local draft.
  useEffect(() => {
    return () => {
      const md = editorRef.current?.getMarkdown();
      if (md?.trim()) apiRef.current.stashDraft(md);
    };
  }, [session]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Focused compose header — pads its own safe area with its own background */}
      <header className="bg-base-100 pt-safe-top">
        <div className="mx-auto flex h-16 max-w-3xl items-center gap-2 px-3">
          <button
            className="-ml-1 flex items-center rounded-lg p-1.5 text-base-content/60 transition-colors hover:text-base-content"
            onClick={() => router.push("/search")}
            aria-label="Back"
          >
            <IconChevronLeft size={18} />
          </button>
          <span className="text-[15px] font-semibold text-base-content">New note</span>
          <button
            className="ml-1 flex items-center gap-1.5 rounded-full border border-base-200 px-2.5 py-1 text-[12.5px] font-medium text-base-content/60 transition-colors hover:bg-base-200"
            onClick={() => router.push("/new/drafts")}
          >
            Drafts
            {draftCount > 0 && (
              <span className="rounded-full bg-primary/10 px-1.5 text-[11px] font-semibold text-primary tabular-nums">
                {draftCount}
              </span>
            )}
          </button>
          {/* Connection state lives on the Remote tab badge / save-button disabled
              states now — no standalone indicator here. */}
          <div className="ml-auto hidden items-center gap-2 sm:flex">
            <ActionButtons editorRef={editorRef} />
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-4 py-5 pb-16">
          {savedPath && (
            <div className="mb-4 flex items-center gap-2 rounded-xl border border-base-300 bg-base-200 px-4 py-3 text-[13.5px] text-base-content/60">
              <span className="text-success">
                <StatusDot />
              </span>
              Saved to your library
              <button
                className="ml-auto font-semibold text-primary hover:text-primary"
                onClick={() => router.push(`/search${hashHref("doc", savedPath)}`)}
              >
                Open
              </button>
            </div>
          )}
          {error && (
            <div className="mb-4 rounded-xl border border-base-300 bg-base-200 px-4 py-3 text-[13.5px] text-hk-orange-text">
              {error}
            </div>
          )}
          <KbEditor
            key={`compose#${session}`}
            seed={seed}
            placeholder="Start writing — the first line becomes the title…"
            handleRef={editorRef}
            autoFocus
            className="min-h-[50dvh]"
          />
        </div>
      </div>

      {/* Phone: actions live in a bottom bar (thumb zone); pads its own safe area */}
      <footer className="border-t border-base-200 bg-base-100 px-4 pt-2.5 pb-[max(env(safe-area-inset-bottom),10px)] sm:hidden">
        <div className="flex items-center justify-end gap-2">
          <ActionButtons editorRef={editorRef} />
        </div>
      </footer>
    </div>
  );
}
