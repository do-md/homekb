#!/usr/bin/env node
/**
 * Desktop static export build (docs/ARCHITECTURE.md "desktop client"):
 * BUILD_TARGET=tauri next build (output:"export" → distDir .next-tauri).
 *
 * The engine binary is NOT bundled — the shell downloads it from the
 * engine-v* GitHub release at first run (docs "Engine acquisition").
 * The Next.js app is a pure frontend (the relay moved to relay/ as a standalone
 * service), so no server routes need to be moved out of the way anymore.
 */
import { execSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Static export build
execSync("./node_modules/.bin/next build", {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, BUILD_TARGET: "tauri" },
});

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
