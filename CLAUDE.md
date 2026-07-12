# homekb

@../../CLAUDE.md

> 上面一行继承 workspace 根 CLAUDE.md（包管理规则、zenith 约定、技术栈）。下面是 HomeKB 特有的补充。

## 这是什么

HomeKB —— 面向 C 端的个人知识库产品，核心卖点：**数据永远在用户自己的电脑上**。
三大件：

1. **engine/**（Rust）：`homekb` CLI —— 知识编译（md → 分块 → OpenAI embedding → sqlite-vec 索引）+ 语义召回（双池 KNN + RRF）+ 本地 MCP（stdio，接 Claude Code / Codex）+ tunnel（连中继的家端常驻进程）。fork 自 kb-compile / kb-query，独立演进。
2. **Next.js（本目录）**：自托管中继 + Web 版 UI。中继只存「配对关系 + token 哈希」，**不存任何知识库数据**；家端经 SSE 隧道收指令、本地执行、回传结果。含远程 MCP（Streamable HTTP + 配对码 OAuth，接 Claude 手机端）。
3. **src-tauri/**（后续阶段）：桌面 App，DoMD 模式（静态导出 + Rust invoke 嵌入 engine core）。

协议契约（RPC 方法、API、目录布局、token 格式）见 `docs/ARCHITECTURE.md`，**改协议先改文档**。

## 端口与运行

- 开发：`npm run dev`（端口 **23333**）；生产：`npm start`（端口 3333）。
- 引擎构建：`cd engine && cargo build --release`，二进制 `engine/target/release/homekb`。
- 中继服务端库：`relay.db`（better-sqlite3），路径 env `HOMEKB_RELAY_DB`，默认 `~/.homekb-relay/relay.db`。

## 数据目录（用户侧）

- 数据根 `~/.homekb/`：`notes/`（md 正文，引擎只扫这里）、`assets/images/`、`assets/attachments/`、`index/index.db`（索引快照，单文件、网盘同步安全）。
- live.db（编译工作库）在 `~/Library/Application Support/homekb/`，**故意不放数据根**——防用户网盘同步 WAL 坏写路径（claude-os 踩过的坑）。
- 配置 `~/.config/homekb/config.toml`（含 OpenAI key，不进数据根防随网盘外泄）；`notes_dir` 可覆盖指向任意已有目录。

## 约定

- 状态管理 zenith（`npx i @do-md/zenith`），store 写法遵循根 CLAUDE.md。
- 不写 data-theme，纯跟随系统；分明暗样式一律 `@media (prefers-color-scheme)`。
- 服务端单例（隧道 hub）必须挂 globalThis，防 dev HMR 重复初始化。
- 本仓库是独立 git 仓库（apps/homekb 下 git init），语义化中文 commit，直接上 main。
