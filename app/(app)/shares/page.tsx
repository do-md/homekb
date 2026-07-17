"use client";

import { useEffect } from "react";
import { useKbStoreApi } from "@/features/kb/store/kb-store";
import { SharesView } from "@/features/kb/components/views/shares";

/** /shares — public share links management (records live on the home). */
export default function SharesPage() {
  const api = useKbStoreApi();

  // Entering the tab refreshes the list (records may have changed from any
  // surface: CLI, MCP, another paired client).
  useEffect(() => {
    void api.loadShares();
  }, [api]);

  return <SharesView />;
}
