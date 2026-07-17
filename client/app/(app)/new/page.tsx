"use client";

import { useEffect } from "react";
import { closeHashOverlay, useHashParam } from "@/lib/client/hash-route";
import { useKbStore, useKbStoreApi } from "@/features/kb/store/kb-store";
import { NewNoteView } from "@/features/kb/components/views/new-note";

/**
 * /new — the composer (active compose buffer); `#draft=<id>` resumes a specific
 * home-side draft (hash overlay: system back returns to /new/drafts).
 */
export default function NewNotePage() {
  const api = useKbStoreApi();
  const draftId = useHashParam("draft");
  const draftsLoaded = useKbStore((s) => s.state.draftsLoaded);
  const editingDraftId = useKbStore((s) => s.state.editingDraftId);

  useEffect(() => {
    if (!draftId || draftId === editingDraftId) return;
    // Deep link before the shared drafts list arrived: wait — the effect
    // re-runs when draftsLoaded flips (loadDrafts / health-poll backfill).
    if (!draftsLoaded) return;
    const found = api.resumeDraft(draftId);
    if (!found) closeHashOverlay(); // stale link: fall back to the plain composer
  }, [draftId, draftsLoaded, editingDraftId, api]);

  return <NewNoteView />;
}
