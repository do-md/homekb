# HomeKB

个人知识库，数据永远在你自己的电脑上。

- **本地引擎**（Rust）：Markdown 知识编译（OpenAI embedding + sqlite-vec）+ 语义召回（双池 KNN + RRF）。
- **Agent 原生**：`homekb mcp` 一行接入 Claude Code / Codex；远程 MCP 接 Claude 手机端。
- **远程访问**：自托管中继（本 Next.js 应用），手机 Web 经 SSE 隧道读写家里电脑的数据；服务器零用户数据。
- **无账号**：配对码一次绑定，服务器只存 token 哈希。

架构与协议见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，开发约定见 [CLAUDE.md](CLAUDE.md)。

## 快速开始（家里电脑）

```bash
cd engine && cargo build --release
./target/release/homekb init            # 建 ~/.homekb + 配置
./target/release/homekb reindex         # 编译索引
./target/release/homekb query "..."     # 语义召回
claude mcp add homekb -- homekb mcp     # 接入 Claude Code

# 远程访问（可选）
homekb register --relay https://你的中继域名
homekb tunnel                           # 常驻：隧道 + 定时编译
homekb pair                             # 生成配对码给手机
```

## 远端接入（配对后）

- **手机浏览器**：打开中继域名 → 输入配对码 → 搜索/问答/读写笔记。
- **Claude 手机端 / claude.ai**：添加自定义连接器 `https://中继域名/api/mcp`，授权页输入配对码即可（OAuth 自动完成）。
- **Claude Code（远程）**：`claude mcp add --transport http homekb https://中继域名/api/mcp --header "Authorization: Bearer <配对换到的token>"`。

## 开发

- Web/中继：`npm run dev`（23333）；测试 `npm test` + `scripts/smoke-relay.sh` + `scripts/smoke-mcp.sh`。
- 引擎：`cd engine && cargo build && cargo test`；用 `HOMEKB_CONFIG=/tmp/x.toml` 隔离测试环境。
