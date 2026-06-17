import express, { type Request, type Response } from "express";
import { getSalesforceAccessToken } from "./auth.js";
import { config } from "./config.js";
import { SalesforceMcpClient } from "./mcpClient.js";
import { ERROR_SPEECH, formatMcpResponse, UNSUPPORTED_SPEECH } from "./responseFormatter.js";
import { selectTool } from "./toolSelector.js";
import type { AskRequest, AskResponse, JsonObject, JsonValue, Logger } from "./types.js";

const app = express();

app.use(express.json({ limit: "1mb" }));

const logger: Logger = {
  info(message, meta) {
    console.log(JSON.stringify({ level: "info", message, ...sanitizeForLog(meta) }));
  },
  warn(message, meta) {
    console.warn(JSON.stringify({ level: "warn", message, ...sanitizeForLog(meta) }));
  },
  error(message, meta) {
    console.error(JSON.stringify({ level: "error", message, ...sanitizeForLog(meta) }));
  }
};

app.get("/health", (_request: Request, response: Response) => {
  response.json({ status: "ok" });
});

app.post("/ask", async (request: Request<unknown, AskResponse, AskRequest>, response: Response<AskResponse>) => {
  try {
    const question = request.body.question?.trim();
    const userId = request.body.userId?.trim() || config.defaultUserId;

    if (!question) {
      response.status(400).json({
        speech: "Necesito una pregunta para consultar Salesforce.",
        intent: "invalid_request",
        tool: null,
        raw: {}
      });
      return;
    }

    logger.info("incoming_question", {
      userId,
      question
    });

    const accessToken = await getSalesforceAccessToken(config);
    const mcpClient = new SalesforceMcpClient(config.salesforce.mcpServerUrl, accessToken, logger);

    await mcpClient.connect();

    const tools = await mcpClient.listTools();
    logger.info("mcp_tools_discovered", {
      count: tools.length
    });

    const selection = await selectTool({
      question,
      userId,
      currentDate: new Date().toISOString().slice(0, 10),
      tools,
      config,
      logger
    });

    logger.info("tool_selected", {
      intent: selection.intent,
      tool: selection.toolName
    });

    if (!selection.toolName) {
      response.json({
        speech: UNSUPPORTED_SPEECH,
        intent: "unsupported",
        tool: null,
        raw: {}
      });
      return;
    }

    const raw = await mcpClient.callTool(selection.toolName, selection.toolInput);
    logger.info("mcp_execution_result", {
      result: sanitizeForLog(raw)
    });

    response.json({
      speech: formatMcpResponse(raw),
      intent: selection.intent,
      tool: selection.toolName,
      raw
    });
  } catch (error) {
    logger.error("ask_error", {
      message: error instanceof Error ? error.message : "Unknown error"
    });

    response.status(500).json({
      speech: ERROR_SPEECH,
      intent: "error",
      tool: null,
      raw: {}
    });
  }
});

app.listen(config.port, () => {
  logger.info("server_started", {
    port: config.port
  });
});

function sanitizeForLog(value: JsonValue | undefined): JsonObject {
  if (value === undefined) {
    return {};
  }

  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      preview: value.slice(0, 2).map((item) => sanitizePreview(item))
    };
  }

  if (isJsonObject(value)) {
    const sanitized: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      if (isSecretKey(key)) {
        sanitized[key] = "[REDACTED]";
      } else {
        sanitized[key] = sanitizePreview(item);
      }
    }
    return sanitized;
  }

  return {
    value: sanitizePreview(value)
  };
}

function sanitizePreview(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length
    };
  }

  if (isJsonObject(value)) {
    const preview: JsonObject = {};
    for (const [key, item] of Object.entries(value).slice(0, 6)) {
      preview[key] = isSecretKey(key) ? "[REDACTED]" : sanitizePreview(item);
    }
    return preview;
  }

  if (typeof value === "string" && value.length > 120) {
    return `${value.slice(0, 117)}...`;
  }

  return value;
}

function isSecretKey(key: string): boolean {
  return /token|secret|password|authorization|api[_-]?key/i.test(key);
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
