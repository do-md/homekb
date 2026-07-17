import type { NextConfig } from "next";

// When BUILD_TARGET=tauri: static export for the Tauri desktop shell bundle (DoMD mode).
// The static export excludes server-only routes (app/api, app/oauth, app/.well-known);
// scripts/tauri-build.mjs temporarily moves them out and restores them afterward
// (see docs/ARCHITECTURE.md "desktop client").
// distDir is isolated from the dev/web build to avoid contention with a running next dev.
const isTauriBuild = process.env.BUILD_TARGET === "tauri";

const nextConfig: NextConfig = {
  output: isTauriBuild ? "export" : undefined,
  distDir: isTauriBuild ? ".next-tauri" : undefined,
  serverExternalPackages: ["better-sqlite3"],
  // Pretty share links (docs/ARCHITECTURE.md "Note sharing"): /s/<id> → /s?id=<id>.
  // Web build only — static export does not support rewrites (and the desktop
  // never links to the share viewer).
  ...(isTauriBuild
    ? {}
    : {
        async rewrites() {
          return [{ source: "/s/:shareId", destination: "/s?id=:shareId" }];
        },
      }),
};

export default nextConfig;
