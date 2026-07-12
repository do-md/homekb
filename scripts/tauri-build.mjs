#!/usr/bin/env node
/**
 * 桌面静态导出构建（docs/ARCHITECTURE.md「桌面客户端」）：
 *   1. 引擎 release 二进制 → src-tauri/resources/engine/homekb（App 捆绑资源）
 *   2. 临时移出服务端专属路由（app/api、app/oauth、app/.well-known）
 *   3. BUILD_TARGET=tauri next build（output:"export" → out/，distDir .next-tauri）
 *   4. 无论成败还原路由（try/finally）
 *
 * 注意：构建窗口内正在跑的 next dev(23333) 会短暂丢失这些路由，结束即恢复。
 */
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_ONLY = ["app/api", "app/oauth", "app/.well-known"];
const staging = path.join(root, ".tauri-staging");

// 1) 引擎二进制拷入资源
const engineBin = path.join(root, "engine/target/release/homekb");
if (!existsSync(engineBin)) {
  console.error("缺少引擎二进制：先运行  cd engine && cargo build --release");
  process.exit(1);
}
mkdirSync(path.join(root, "src-tauri/resources/engine"), { recursive: true });
cpSync(engineBin, path.join(root, "src-tauri/resources/engine/homekb"));

// 2~4) 移出 → 构建 → 还原
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

// Next 16 + 自定义 distDir：导出产物直接落在 distDir（.next-tauri/）。
// 拷到 out/ 维持 tauri.conf frontendDist("../out") 的稳定契约。
const exportDir = path.join(root, ".next-tauri");
if (!existsSync(path.join(exportDir, "index.html"))) {
  console.error("静态导出产物缺失 .next-tauri/index.html");
  process.exit(1);
}
const outDir = path.join(root, "out");
rmSync(outDir, { recursive: true, force: true });
cpSync(exportDir, outDir, { recursive: true });
console.log("✅ 桌面静态导出完成 → out/");
