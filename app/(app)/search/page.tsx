"use client";

import { useEffect } from "react";
import { useHashParam } from "@/lib/client/hash-route";
import { useKbStoreApi } from "@/features/kb/store/kb-store";
import { ReaderView } from "@/features/kb/components/views/reader";
import { RecallView } from "@/features/kb/components/views/recall";

/** /search — entry + results; `#doc=<path>` overlays the reader (system back closes it). */
export default function SearchPage() {
  const api = useKbStoreApi();
  const doc = useHashParam("doc");

  useEffect(() => {
    if (doc) void api.openDoc(doc);
  }, [doc, api]);

  return doc ? <ReaderView /> : <RecallView />;
}
