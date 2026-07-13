# HomeKB

A personal knowledge base — your data always stays on your own computer.

- **Local engine** (Rust): Markdown knowledge compilation (OpenAI embedding + sqlite-vec) + semantic retrieval (dual-pool KNN + RRF).
- **Agent-native**: `homekb mcp` integrates with Claude Code / Codex in one line; the remote MCP connects the Claude mobile app.
- **Remote access**: a self-hosted relay (this Next.js app) lets the mobile Web read and write the data on your home computer over an SSE tunnel; the server holds zero user data.
- **Account-free**: the pairing code binds once, and the server stores only token hashes.

For architecture and protocol see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); for development conventions see [CLAUDE.md](CLAUDE.md).

## Quick start (home computer)

```bash
cd engine && cargo build --release
./target/release/homekb init            # Create ~/.homekb + config
./target/release/homekb reindex         # Compile the index
./target/release/homekb query "..."     # Semantic retrieval
claude mcp add homekb -- homekb mcp     # Integrate with Claude Code

# Remote access (optional)
homekb register --relay https://your-relay-domain
homekb tunnel                           # Daemon: tunnel + scheduled compile
homekb pair                             # Generate a pairing code for your phone
```

## Remote access (after pairing)

- **Mobile browser**: open the relay domain → enter the pairing code → search / ask / read and write notes.
- **Claude mobile app / claude.ai**: add a custom connector `https://your-relay-domain/api/mcp` and enter the pairing code on the authorization page (OAuth completes automatically).
- **Claude Code (remote)**: `claude mcp add --transport http homekb https://your-relay-domain/api/mcp --header "Authorization: Bearer <token obtained from pairing>"`.

## Development

- Web/relay: `npm run dev` (3000); tests `npm test` + `scripts/smoke-relay.sh` + `scripts/smoke-mcp.sh`.
- Engine: `cd engine && cargo build && cargo test`; use `HOMEKB_CONFIG=/tmp/x.toml` to isolate the test environment.
