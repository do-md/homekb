/**
 * Remote MCP tool definitions (identical to the local `homekb mcp` tool set; see
 * docs/ARCHITECTURE.md). Verbatim port of lib/mcp/tools.ts — keep the two in sync.
 * Each tool maps to a single tunnel RPC call.
 */

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Translate to a tunnel RPC call. */
  rpc: (args: Record<string, unknown>) => { method: string; params: unknown };
}

const str = (desc: string) => ({ type: "string", description: desc });
const num = (desc: string) => ({ type: "number", description: desc });
const bool = (desc: string) => ({ type: "boolean", description: desc });

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: "kb_search",
    description:
      "Semantic search over the user's personal knowledge base (Markdown notes on their home computer). Returns the most relevant chunks/documents with path, title, content and score. Use this first to find existing knowledge.",
    inputSchema: {
      type: "object",
      properties: {
        query: str("Natural-language search query"),
        limit: num("Max results (default 10)"),
        doc_type: str("Optional document type filter (see kb_status types)"),
        full: bool("Return whole documents instead of chunks (default false)"),
        enumerate: bool(
          "Whole-category sweep: return EVERY doc of doc_type (content = summary) ranked by relevance. Use for 'list everything in X' intents; requires doc_type; limit is ignored",
        ),
      },
      required: ["query"],
    },
    rpc: (a) => ({
      method: "kb.query",
      params: {
        query: a.query,
        limit: a.limit,
        docType: a.doc_type,
        full: a.full,
        enumerate: a.enumerate,
      },
    }),
  },
  {
    name: "kb_read",
    description:
      "Read the full Markdown content of a note by its relative path (as returned by kb_search / kb_list).",
    inputSchema: {
      type: "object",
      properties: { path: str("Relative path of the note, e.g. 'foo.md'") },
      required: ["path"],
    },
    rpc: (a) => ({ method: "kb.read", params: { path: a.path } }),
  },
  {
    name: "kb_create",
    description:
      "Create a new Markdown note in the knowledge base. The filename is derived from the title (or first heading). Returns the created path.",
    inputSchema: {
      type: "object",
      properties: {
        content: str("Full Markdown content of the note"),
        title: str("Optional title (used for the filename)"),
      },
      required: ["content"],
    },
    rpc: (a) => ({
      method: "kb.create",
      params: { content: a.content, title: a.title },
    }),
  },
  {
    name: "kb_update",
    description:
      "Overwrite an existing note (full Markdown replacement). Read it first with kb_read to avoid losing content.",
    inputSchema: {
      type: "object",
      properties: {
        path: str("Relative path of the note to overwrite"),
        content: str("New full Markdown content"),
      },
      required: ["path", "content"],
    },
    rpc: (a) => ({
      method: "kb.write",
      params: { path: a.path, content: a.content },
    }),
  },
  {
    name: "kb_list",
    description:
      "List recent notes in the knowledge base (path, title, type, modified time), newest first.",
    inputSchema: {
      type: "object",
      properties: { limit: num("Max entries (default 20)") },
    },
    rpc: (a) => ({ method: "kb.list", params: { limit: a.limit } }),
  },
  {
    name: "kb_status",
    description:
      "Knowledge base index status: document/chunk counts, pending embeddings, last compile time, known document types.",
    inputSchema: { type: "object", properties: {} },
    rpc: () => ({ method: "kb.status", params: {} }),
  },
];

export const MCP_TOOL_MAP = new Map(MCP_TOOLS.map((t) => [t.name, t]));
