import type { NextConfig } from "next";

// BUILD_TARGET=tauri 时静态导出（Tauri 桌面壳打包用，DoMD 模式）。
// 静态导出不含服务端专属路由（app/api、app/oauth、app/.well-known），
// 由 scripts/tauri-build.mjs 临时移出再还原（docs/ARCHITECTURE.md「桌面客户端」）。
// distDir 与 dev/Web 版隔离，避免与正在跑的 next dev 抢 .next。
const isTauriBuild = process.env.BUILD_TARGET === "tauri";

const nextConfig: NextConfig = {
  output: isTauriBuild ? "export" : undefined,
  distDir: isTauriBuild ? ".next-tauri" : undefined,
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
