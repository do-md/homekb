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
