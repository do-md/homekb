"use client";

import { useEffect } from "react";
import { closeHashOverlay, useHashParam } from "@/lib/client/hash-route";
import { useKbStore, useKbStoreApi } from "@/features/kb/store/kb-store";
import { NewNoteView } from "@/features/kb/components/views/new-note";

/**
 * /new — the composer. One surface, three entries (docs/ARCHITECTURE.md "UI
 * routes"): plain = active compose buffer; `#draft=<id>` resumes a home-side
 * draft; `#note=<encoded path>` edits a library note ("Edit note" mode — Save
 * to library updates it in place). Hash overlays: system back returns to where
 * the user came from (drafts list / reader).
 */
export default function NewNotePage() {
  const api = useKbStoreApi();
  const draftId = useHashParam("draft");
  const notePath = useHashParam("note");
  const draftsLoaded = useKbStore((s) => s.state.draftsLoaded);
  const editingDraftId = useKbStore((s) => s.state.editingDraftId);
  const editingNotePath = useKbStore((s) => s.state.editingNotePath);

  useEffect(() => {
    if (!notePath || notePath === editingNotePath) return;
    // Seeds from the already-loaded reader content when Edit came from the
    // reader; falls back to kb.read for deep links / reloads.
    void api.editNote(notePath);
  }, [notePath, editingNotePath, api]);

  useEffect(() => {
    if (notePath) return; // a #note edit session owns the composer
    if (!draftId || draftId === editingDraftId) return;
    // Deep link before the shared drafts list arrived: wait — the effect
    // re-runs when draftsLoaded flips (loadDrafts / health-poll backfill).
    if (!draftsLoaded) return;
    const found = api.resumeDraft(draftId);
    if (!found) closeHashOverlay(); // stale link: fall back to the plain composer
  }, [notePath, draftId, draftsLoaded, editingDraftId, api]);

  return <NewNoteView />;
}
