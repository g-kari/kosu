/**
 * MCP endpoint (phase 4): POST /mcp, Streamable HTTP transport,
 * stateless JSON-RPC 2.0. One POST carries one request (or a batch);
 * notifications are accepted and dropped. There is no server-initiated
 * stream, so GET/DELETE answer 405.
 *
 * Auth: `Authorization: Bearer <Kosu API key>` (the key's tenant is the
 * default tenant for every tool) or the browser session cookie. API-key
 * scopes are enforced per tool inside the dispatcher (src/mcp.ts),
 * because the transport is POST even for reads.
 */
import { Hono } from "hono";
import { assertSameOriginForSessionMutation, resolvePrincipal } from "../auth";
import { ApiError } from "../errors";
import { MCP_TOOLS, callMcpTool } from "../mcp";
import type { Env, Principal, Variables } from "../types";
import type { Ctx } from "./http";

export const mcpRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const PROTOCOL_VERSION = "2025-03-26";
const SUPPORTED_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];
const SERVER_INFO = { name: "kosu", version: "0.5.0" };
const BODY_LIMIT = 1024 * 1024;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: string | number | null, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(
  id: string | number | null,
  code: number,
  message: string,
) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleRequest(
  c: Ctx,
  principal: Principal,
  req: JsonRpcRequest,
): Promise<Record<string, unknown> | null> {
  const id = req.id ?? null;
  const isNotification = req.id === undefined;
  const method = req.method ?? "";
  try {
    switch (method) {
      case "initialize": {
        const requested = req.params?.["protocolVersion"];
        const version =
          typeof requested === "string" &&
          SUPPORTED_VERSIONS.includes(requested)
            ? requested
            : PROTOCOL_VERSION;
        return rpcResult(id, {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            "Kosu 工数・タスク管理 MCP。tenant_id は API キーのテナントが既定。タスク本文はクライアント暗号化のため description_enc（暗号文）でやり取りする。",
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, {
          tools: MCP_TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
      case "tools/call": {
        const name = req.params?.["name"];
        if (typeof name !== "string") {
          return rpcError(id, -32602, '"name" is required');
        }
        try {
          const result = await callMcpTool(
            c.env,
            principal,
            name,
            req.params?.["arguments"] ?? {},
          );
          return rpcResult(id, {
            content: [
              { type: "text", text: JSON.stringify(result, null, 2) },
            ],
          });
        } catch (err) {
          if (err instanceof ApiError) {
            return rpcResult(id, {
              content: [
                {
                  type: "text",
                  text: `Error ${err.code}: ${err.message}`,
                },
              ],
              isError: true,
            });
          }
          throw err;
        }
      }
      default:
        if (isNotification) return null;
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    console.error("mcp request failed", err);
    if (isNotification) return null;
    return rpcError(id, -32603, "Internal error");
  }
}

mcpRoutes.post("/mcp", async (c) => {
  const principal = await resolvePrincipal(c);
  if (!principal) {
    return c.json(
      rpcError(null, -32001, "Authentication required (Bearer API key)"),
      401,
    );
  }
  if (principal.kind === "session") {
    // Cookie-authenticated calls ride on ambient authority: keep the
    // same-origin guard the REST API applies to mutations.
    assertSameOriginForSessionMutation(c);
  }
  const text = await c.req.text();
  if (text.length > BODY_LIMIT) {
    return c.json(rpcError(null, -32600, "Request body too large"), 413);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return c.json(rpcError(null, -32700, "Parse error"), 400);
  }
  if (Array.isArray(parsed)) {
    const responses: Record<string, unknown>[] = [];
    for (const item of parsed) {
      const res = await handleRequest(
        c,
        principal,
        item as JsonRpcRequest,
      );
      if (res) responses.push(res);
    }
    if (responses.length === 0) return c.body(null, 202);
    return c.json(responses);
  }
  const res = await handleRequest(c, principal, parsed as JsonRpcRequest);
  if (!res) return c.body(null, 202);
  return c.json(res);
});

const methodNotAllowed = (c: Ctx) =>
  c.json(
    rpcError(null, -32600, "This MCP endpoint is stateless; use POST"),
    405,
  );
mcpRoutes.get("/mcp", methodNotAllowed);
mcpRoutes.delete("/mcp", methodNotAllowed);
