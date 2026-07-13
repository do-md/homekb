#!/usr/bin/env node
/**
 * Desktop static export build (docs/ARCHITECTURE.md "desktop client"):
 *   1. Engine release binary → src-tauri/resources/engine/homekb (bundled app resource)
 *   2. Temporarily move out server-only routes (app/api, app/oauth, app/.well-known)
 *   3. BUILD_TARGET=tauri next build (output:"export" → out/, distDir .next-tauri)
 *   4. Restore routes regardless of success/failure (try/finally)
 *
 * Note: any next dev(3000) running during the build window will briefly lose these routes; they are restored on completion.
 */
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_ONLY = ["app/api", "app/oauth", "app/.well-known"];
const staging = path.join(root, ".tauri-staging");

// 1) Copy engine binary into resources
const engineBin = path.join(root, "engine/target/release/homekb");
if (!existsSync(engineBin)) {
  console.error("Engine binary missing: run  cd engine && cargo build --release  first");
  process.exit(1);
}
mkdirSync(path.join(root, "src-tauri/resources/engine"), { recursive: true });
cpSync(engineBin, path.join(root, "src-tauri/resources/engine/homekb"));

// 2–4) Move out → build → restore
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
const moved = [];
try {
  for (const rel of SERVER_ONLY) {
    const from = path.join(root, rel);
    if (!existsSync(from)) continue;
    const to = path.join(staging, rel.replaceAll("/", "__"));
    renameSync(from, to);
    moved.push([from, to]);
  }
  execSync("./node_modules/.bin/next build", {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, BUILD_TARGET: "tauri" },
  });
} finally {
  for (const [from, to] of moved.reverse()) renameSync(to, from);
  rmSync(staging, { recursive: true, force: true });
}

// Next 16 + custom distDir: export output lands directly in distDir (.next-tauri/).
// Copy to out/ to maintain the stable tauri.conf frontendDist("../out") contract.
const exportDir = path.join(root, ".next-tauri");
if (!existsSync(path.join(exportDir, "index.html"))) {
  console.error("Static export artifact missing: .next-tauri/index.html not found");
  process.exit(1);
}
const outDir = path.join(root, "out");
rmSync(outDir, { recursive: true, force: true });
cpSync(exportDir, outDir, { recursive: true });
console.log("✅ Desktop static export complete → out/");
