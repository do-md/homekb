import type { Env } from "./env";
import { callHome, HubClientError } from "./do-client";
import { MCP_TOOL_MAP, MCP_TOOLS } from "./mcp-tools";

/**
 * Stateless Streamable HTTP MCP: single JSON-RPC message in, JSON response out.
 * Port of ../node/src/lib/mcp/handler.ts — hub().call replaced by the per-home DO call.
 */

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";

const SERVER_INFO = { name: "homekb", version: "0.1.0" };

function rpcResult(id: JsonRpcMessage["id"], result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function rpcError(id: JsonRpcMessage["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function toolText(payload: unknown, isError = false) {
  return {
    content: [
      {
        type: "text",
        text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
      },
    ],
    isError,
  };
}

/**
 * Handle a single MCP message. Returns null when no response body is needed (notification → HTTP 202).
 */
export async function handleMcpMessage(
  msg: JsonRpcMessage,
  homeId: string,
  env: Env,
): Promise<Record<string, unknown> | null> {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize": {
      const requested = String(params?.protocolVersion ?? "");
      return rpcResult(id, {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(requested)
          ? requested
          : DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "HomeKB is the user's personal knowledge base living on their home computer. Search before creating; prefer kb_search → kb_read for recall, kb_create for new knowledge.",
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, {
        tools: MCP_TOOLS.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      });
    case "tools/call": {
      const name = String(params?.name ?? "");
      const tool = MCP_TOOL_MAP.get(name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      const { method: rpcMethod, params: rpcParams } = tool.rpc(args);
      try {
        const result = await callHome(env, homeId, rpcMethod, rpcParams);
        return rpcResult(id, toolText(result));
      } catch (e) {
        if (e instanceof HubClientError) {
          const hint =
            e.code === "home_offline"
              ? "The user's home computer is not connected to the relay right now (run `homekb tunnel` on it)."
              : e.message;
          return rpcResult(id, toolText(`HomeKB error (${e.code}): ${hint}`, true));
        }
        return rpcResult(
          id,
          toolText(`HomeKB internal error: ${e instanceof Error ? e.message : e}`, true),
        );
      }
    }
    default:
      // notifications (notifications/initialized etc.) — silently ignore
      if (isNotification || method?.startsWith("notifications/")) return null;
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
