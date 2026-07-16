"use client";

import { useEffect } from "react";
import { useKbStoreApi } from "@/features/kb/store/kb-store";
import { StatusView } from "@/features/kb/components/views/status";

/** /status — knowledge-base health dashboard. */
export default function StatusPage() {
  const api = useKbStoreApi();

  // Entering the tab refreshes the dashboard (was part of the old go("status")).
  useEffect(() => {
    void api.loadStatus();
  }, [api]);

  return <StatusView />;
}
