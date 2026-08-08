"use strict";

/**
 * Minimal MCP (Model Context Protocol) client for the Kapruka MCP server
 * (https://mcp.kapruka.com/mcp). Handles session init and generic tool calls
 * over MCP's Streamable HTTP transport (JSON-RPC 2.0, SSE-formatted responses).
 */

const MCP_URL = "https://mcp.kapruka.com/mcp";

let sessionId = null;
let initPromise = null;

function parseSseJson(text) {
  for (const line of text.split("\n")) {
    if (line.startsWith("data:")) {
      const jsonStr = line.slice(5).trim();
      if (jsonStr) return JSON.parse(jsonStr);
    }
  }
  return JSON.parse(text); // fall back in case it wasn't SSE-wrapped
}

async function rpcCall(method, params, { isNotification = false } = {}) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const body = { jsonrpc: "2.0", method };
  if (!isNotification) body.id = Date.now();
  if (params !== undefined) body.params = params;

  const res = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const returnedSessionId = res.headers.get("mcp-session-id");
  if (returnedSessionId) sessionId = returnedSessionId;

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`MCP request failed (${res.status}): ${errText}`);
  }

  const text = await res.text();
  if (!text || !text.trim()) return null; // e.g. 202 for notifications

  const parsed = parseSseJson(text);
  if (parsed.error) {
    throw new Error(`MCP error: ${parsed.error.message || JSON.stringify(parsed.error)}`);
  }
  return parsed.result;
}

async function ensureSession() {
  if (sessionId) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    sessionId = null;
    await rpcCall("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "kapruka-messenger-bot", version: "1.0" },
    });
    await rpcCall("notifications/initialized", undefined, { isNotification: true });
  })();

  try {
    await initPromise;
  } finally {
    initPromise = null;
  }
}

/**
 * Call a Kapruka MCP tool by name with a flat args object, e.g.
 *   callTool("kapruka_search_products", { q: "school bag", limit: 5 })
 * Returns the tool's text result (markdown or JSON string, per the tool).
 */
async function callTool(toolName, args = {}, _retry = true) {
  await ensureSession();

  try {
    const result = await rpcCall("tools/call", {
      name: toolName,
      arguments: { params: args },
    });

    const textBlock = result && result.content && result.content[0];
    const text = (textBlock && textBlock.text) || "";

    if (result && result.isError) {
      throw new Error(text || `${toolName} returned an error`);
    }
    return text;
  } catch (err) {
    // Session may have expired server-side; reset and retry once.
    if (_retry && /session/i.test(err.message)) {
      sessionId = null;
      return callTool(toolName, args, false);
    }
    throw err;
  }
}

module.exports = { callTool };
