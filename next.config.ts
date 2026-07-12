import type { NextConfig } from "next";

// BUILD_TARGET=tauri 时静态导出（Tauri 桌面壳打包用，DoMD 模式）。
// 静态导出不含 app/api（中继服务只在自托管 Web 版存在）；
// tauri 构建前需临时移出 app/api（见 scripts/tauri-build.mjs，后续阶段）。
const isTauriBuild = process.env.BUILD_TARGET === "tauri";

const nextConfig: NextConfig = {
  output: isTauriBuild ? "export" : undefined,
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
