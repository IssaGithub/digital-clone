export type McpTool = {
  alias: string;
  serverName: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type McpEndpoint = {
  name: string;
  url: string;
  headers: Record<string, string>;
};

const PROTOCOL = "2025-03-26";

export function toolAlias(serverName: string, toolName: string) {
  const server = serverName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24) || "server";
  const tool = toolName.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 48) || "tool";
  return `${server}__${tool}`;
}

export function parseRpcMessage(body: string) {
  const trimmed = body.trim();
  if (!trimmed) throw new Error("Leere Antwort");
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed) as unknown;
  const chunks = trimmed
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  const last = chunks.at(-1);
  if (!last) throw new Error("Keine MCP-Daten");
  return JSON.parse(last) as unknown;
}

function rpcResult(message: unknown) {
  const row = Array.isArray(message) ? message.at(-1) : message;
  if (!row || typeof row !== "object") throw new Error("MCP-Antwort unlesbar");
  const record = row as { error?: { message?: string }; result?: unknown };
  if (record.error) throw new Error(record.error.message || "MCP-Fehler");
  return record.result;
}

async function postRpc(endpoint: McpEndpoint, method: string, params: unknown, sessionId: string) {
  const response = await fetch(endpoint.url, {
    method: "POST",
    headers: {
      ...endpoint.headers,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
    signal: AbortSignal.timeout(8000),
  });
  const nextSession = response.headers.get("mcp-session-id") || sessionId;
  const text = await response.text();
  if (!response.ok) throw new Error(text.slice(0, 300) || `MCP ${response.status}`);
  return { sessionId: nextSession, result: rpcResult(parseRpcMessage(text)) };
}

export async function openMcp(endpoint: McpEndpoint) {
  const started = await postRpc(
    endpoint,
    "initialize",
    {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: "klon-voice", version: "0.1.0" },
    },
    "",
  );
  await fetch(endpoint.url, {
    method: "POST",
    headers: {
      ...endpoint.headers,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(started.sessionId ? { "Mcp-Session-Id": started.sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => undefined);
  return started.sessionId;
}

export async function listMcpTools(endpoint: McpEndpoint): Promise<McpTool[]> {
  const sessionId = await openMcp(endpoint);
  const listed = await postRpc(endpoint, "tools/list", {}, sessionId);
  const tools = (listed.result as { tools?: { name?: string; description?: string; inputSchema?: Record<string, unknown> }[] })
    ?.tools;
  if (!tools) return [];
  return tools
    .filter((tool) => tool.name)
    .map((tool) => ({
      alias: toolAlias(endpoint.name, tool.name || ""),
      serverName: endpoint.name,
      name: tool.name || "",
      description: tool.description || "",
      inputSchema: tool.inputSchema || { type: "object", properties: {} },
    }));
}

export async function callMcpTool(endpoint: McpEndpoint, name: string, args: unknown) {
  const sessionId = await openMcp(endpoint);
  const called = await postRpc(endpoint, "tools/call", { name, arguments: args ?? {} }, sessionId);
  const result = called.result as { content?: { text?: string }[]; isError?: boolean };
  const text = (result.content || [])
    .map((part) => part.text || "")
    .filter(Boolean)
    .join("\n")
    .slice(0, 4000);
  if (result.isError) throw new Error(text || "Werkzeug meldet einen Fehler");
  return text || JSON.stringify(called.result).slice(0, 4000);
}

export function toolCatalogPrompt(tools: McpTool[]) {
  if (!tools.length) return "";
  return [
    "",
    "Werkzeuge der hinterlegten MCP-Server. Antworte entweder mit gesprochenem Text oder genau einer Zeile:",
    'TOOL {"name":"<alias>","arguments":{...}}',
    "Nutze nur diese Aliasse. Erfinde keine Werkzeuge.",
    ...tools.map((tool) => `- ${tool.alias}: ${tool.description || tool.name} Schema ${JSON.stringify(tool.inputSchema)}`),
  ].join("\n");
}

export function readToolRequest(text: string): { name: string; arguments: Record<string, unknown> } | null {
  const line = text
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.startsWith("TOOL "));
  if (!line) return null;
  try {
    const parsed = JSON.parse(line.slice(5)) as { name?: string; arguments?: Record<string, unknown> };
    if (!parsed.name) return null;
    return { name: parsed.name, arguments: parsed.arguments || {} };
  } catch {
    return null;
  }
}
