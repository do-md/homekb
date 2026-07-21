"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";

/**
 * / — redirect to the Search tab. Query + hash are carried over so the pairing
 * link contract (`/?relay=<url>&code=<code>`, docs/ARCHITECTURE.md "Pairing link")
 * keeps working: the unpaired gate on /search reads the params and auto-claims.
 */
export default function Home() {
  const { t } = useTranslation();
  const router = useRouter();

  useEffect(() => {
    router.replace(`/search${window.location.search}${window.location.hash}`);
  }, [router]);

  return (
    <main className="fixed inset-0 flex items-center justify-center">
      <span
        className="hk-spin inline-block h-5 w-5 rounded-full border-2 border-current border-t-transparent text-primary"
        aria-label={t("common.loading")}
      />
    </main>
  );
}
