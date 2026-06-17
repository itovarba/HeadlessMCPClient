import type { JsonObject, JsonValue, Logger, McpTool } from "./types.js";

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: string | number | null;
  result?: JsonValue;
  error?: {
    code?: number;
    message?: string;
    data?: JsonValue;
  };
}

interface ListToolsResult {
  tools?: McpTool[];
}

interface CallToolResult {
  content?: Array<{
    type?: string;
    text?: string;
    data?: string;
    mimeType?: string;
    [key: string]: unknown;
  }>;
  structuredContent?: JsonValue;
  isError?: boolean;
  [key: string]: unknown;
}

const MCP_PROTOCOL_VERSION = "2025-03-26";

export class SalesforceMcpClient {
  private requestId = 1;
  private sessionId: string | undefined;

  constructor(
    private readonly serverUrl: string,
    private readonly accessToken: string,
    private readonly logger?: Logger
  ) {}

  async connect(): Promise<void> {
    await this.rpcRequest("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: "headless-siri-mcp-client",
        version: "1.0.0"
      }
    });

    await this.rpcNotification("notifications/initialized", {});
  }

  async listTools(): Promise<McpTool[]> {
    const result = await this.rpcRequest("tools/list", {});
    const toolsResult = result as ListToolsResult;

    if (!Array.isArray(toolsResult.tools)) {
      throw new Error("MCP tools/list response did not include a tools array.");
    }

    return toolsResult.tools.filter((tool): tool is McpTool => typeof tool?.name === "string");
  }

  async callTool(toolName: string, payload: JsonObject): Promise<JsonValue> {
    const result = (await this.rpcRequest("tools/call", {
      name: toolName,
      arguments: payload
    })) as CallToolResult;

    if (result.structuredContent !== undefined) {
      return result.structuredContent;
    }

    if (Array.isArray(result.content)) {
      const textItems = result.content
        .filter((item): item is { type?: string; text: string } => item.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .filter((text) => text.trim().length > 0);

      if (textItems.length === 1) {
        const onlyText = textItems[0] ?? "";
        const parsed = tryParseJson(onlyText);
        return parsed ?? onlyText;
      }

      if (textItems.length > 1) {
        return textItems;
      }
    }

    return result as unknown as JsonValue;
  }

  private async rpcRequest(method: string, params?: JsonObject): Promise<JsonValue> {
    const id = this.requestId++;
    const response = await this.sendJsonRpc({
      jsonrpc: "2.0",
      id,
      method,
      params: params ?? {}
    });

    if (response.error) {
      throw new Error(`MCP ${method} failed: ${response.error.message ?? "Unknown MCP error"}`);
    }

    return response.result ?? {};
  }

  private async rpcNotification(method: string, params?: JsonObject): Promise<void> {
    await this.sendJsonRpc({
      jsonrpc: "2.0",
      method,
      params: params ?? {}
    });
  }

  private async sendJsonRpc(body: JsonObject): Promise<JsonRpcResponse> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.accessToken}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION
    };

    if (this.sessionId) {
      headers["mcp-session-id"] = this.sessionId;
    }

    // Salesforce Hosted MCP is expected to expose the MCP Streamable HTTP endpoint.
    // If your Salesforce org uses a different Hosted MCP transport shape, adjust this
    // method only: URL, headers, session handling, or response parsing.
    const response = await fetch(this.serverUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });

    const nextSessionId = response.headers.get("mcp-session-id");
    if (nextSessionId) {
      this.sessionId = nextSessionId;
    }

    const rawText = await response.text();

    if (!response.ok) {
      this.logger?.warn("mcp_http_error", {
        status: response.status,
        statusText: response.statusText,
        body: previewText(rawText)
      });
      throw new Error(
        `MCP HTTP request failed with status ${response.status} ${response.statusText}: ${previewText(rawText)}`
      );
    }

    if (!rawText.trim()) {
      return {};
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      return parseEventStreamJsonRpc(rawText);
    }

    let parsed: JsonRpcResponse | JsonValue;
    try {
      parsed = JSON.parse(rawText) as JsonRpcResponse | JsonValue;
    } catch {
      throw new Error(`MCP response was not valid JSON: ${previewText(rawText)}`);
    }

    if (isJsonRpcResponse(parsed)) {
      return parsed;
    }

    return {
      result: parsed
    };
  }
}

function previewText(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) {
    return "[empty body]";
  }
  return clean.length > 500 ? `${clean.slice(0, 497)}...` : clean;
}

function isJsonRpcResponse(value: JsonValue | JsonRpcResponse): value is JsonRpcResponse {
  return typeof value === "object" && value !== null && ("result" in value || "error" in value);
}

function parseEventStreamJsonRpc(rawText: string): JsonRpcResponse {
  const dataLines = rawText
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((line) => line && line !== "[DONE]");

  for (const line of dataLines) {
    const parsed = JSON.parse(line) as JsonRpcResponse | JsonValue;
    if (isJsonRpcResponse(parsed)) {
      return parsed;
    }
    return { result: parsed };
  }

  return {};
}

function tryParseJson(text: string | undefined): JsonValue | undefined {
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}
