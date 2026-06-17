import express, { type Request, type Response } from "express";
import session from "express-session";
import {
  AuthRequiredError,
  clearSalesforceOAuth,
  createSalesforceAuthorizationUrl,
  getSalesforceAccessToken,
  getSalesforceAuthStatus,
  handleSalesforceOAuthCallback
} from "./auth.js";
import { config } from "./config.js";
import { renderDashboard } from "./dashboard.js";
import { SalesforceMcpClient } from "./mcpClient.js";
import { ERROR_SPEECH, formatMcpResponse, UNSUPPORTED_SPEECH } from "./responseFormatter.js";
import { selectTool } from "./toolSelector.js";
import type { AskRequest, AskResponse, JsonObject, JsonValue, Logger } from "./types.js";

const app = express();

app.use(express.json({ limit: "1mb" }));
app.set("trust proxy", 1);
app.use(
  session({
    name: "headless-siri-mcp.sid",
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false
    }
  })
);

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

app.get("/", (_request: Request, response: Response) => {
  response.type("html").send(renderDashboard());
});

app.get("/auth/login", (request: Request, response: Response) => {
  const userId = readQueryString(request.query.userId) || config.defaultUserId;
  const authorizationUrl = createSalesforceAuthorizationUrl({
    appConfig: config,
    userId,
    session: request.session
  });

  logger.info("oauth_login_started", {
    userId
  });

  response.redirect(authorizationUrl);
});

app.get("/auth/callback", async (request: Request, response: Response) => {
  try {
    const code = readQueryString(request.query.code);
    const state = readQueryString(request.query.state);

    if (!code || !state) {
      response.status(400).type("text/plain").send("Faltan los parámetros code o state de Salesforce OAuth.");
      return;
    }

    const result = await handleSalesforceOAuthCallback({
      appConfig: config,
      code,
      state,
      session: request.session
    });

    logger.info("oauth_login_completed", {
      userId: result.userId,
      expiresAt: new Date(result.expiresAt).toISOString()
    });

    const labUrl = new URL("/", `${request.protocol}://${request.get("host") ?? `localhost:${config.port}`}`);
    labUrl.searchParams.set("userId", result.userId);
    labUrl.searchParams.set("login", "success");

    response.redirect(labUrl.pathname + labUrl.search);
  } catch (error) {
    logger.error("oauth_callback_error", {
      message: error instanceof Error ? error.message : "Unknown OAuth callback error"
    });

    response.status(400).type("text/plain").send("No se ha podido completar el login con Salesforce.");
  }
});

app.get("/auth/status", (request: Request, response: Response) => {
  const userId = readQueryString(request.query.userId) || request.session.userId || config.defaultUserId;
  response.json(getSalesforceAuthStatus({ appConfig: config, userId, session: request.session }));
});

app.post("/auth/logout", (request: Request<unknown, JsonObject, { userId?: string }>, response: Response) => {
  const userId = request.body.userId?.trim() || request.session.userId || config.defaultUserId;
  clearSalesforceOAuth({ userId, session: request.session });
  response.json({
    status: "ok",
    userId
  });
});

app.get("/mcp/tools", async (request: Request, response: Response) => {
  const userId = readQueryString(request.query.userId) || request.session.userId || config.defaultUserId;

  try {
    const mcpClient = await createMcpClient(userId, request.session);
    await mcpClient.connect();
    const tools = await mcpClient.listTools();

    logger.info("mcp_tools_discovered", {
      userId,
      count: tools.length
    });

    response.json({
      count: tools.length,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema ?? {},
        outputSchema: tool.outputSchema ?? {},
        annotations: tool.annotations ?? {}
      }))
    });
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      response.status(401).json({
        speech: "Necesito que inicies sesión en Salesforce antes de consultar las tools MCP.",
        intent: "auth_required",
        raw: {
          authUrl: buildLocalAuthUrl(request, userId)
        }
      });
      return;
    }

    logger.error("mcp_tools_error", {
      message: error instanceof Error ? error.message : "Unknown MCP tools error"
    });

    response.status(500).json({
      speech: ERROR_SPEECH,
      intent: "error",
      raw: buildErrorDiagnostic(error)
    });
  }
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

    const mcpClient = await createMcpClient(userId, request.session);
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
    if (error instanceof AuthRequiredError) {
      const userId = request.body.userId?.trim() || config.defaultUserId;
      response.status(401).json({
        speech: "Necesito que inicies sesión en Salesforce antes de consultar. Abre la URL de autenticación del servicio.",
        intent: "auth_required",
        tool: null,
        raw: {
          authUrl: buildLocalAuthUrl(request, userId)
        }
      });
      return;
    }

    logger.error("ask_error", {
      message: error instanceof Error ? error.message : "Unknown error"
    });

    response.status(500).json({
      speech: ERROR_SPEECH,
      intent: "error",
      tool: null,
      raw: buildErrorDiagnostic(error)
    });
  }
});

app.listen(config.port, () => {
  logger.info("server_started", {
    port: config.port
  });
});

async function createMcpClient(
  userId: string,
  sessionData: Request["session"] | undefined
): Promise<SalesforceMcpClient> {
  const authRequest: Parameters<typeof getSalesforceAccessToken>[0] = {
    appConfig: config,
    userId
  };

  if (sessionData) {
    authRequest.session = sessionData;
  }

  const accessToken = await getSalesforceAccessToken(authRequest);

  return new SalesforceMcpClient(config.salesforce.mcpServerUrl, accessToken, logger);
}

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

function buildErrorDiagnostic(error: unknown): JsonObject {
  const message = error instanceof Error ? error.message : "Unknown error";
  return {
    error: sanitizeErrorMessage(message)
  };
}

function sanitizeErrorMessage(message: string): string {
  return message.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]");
}

function readQueryString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }

  return undefined;
}

function buildLocalAuthUrl(request: { protocol: string; get(name: string): string | undefined }, userId: string): string {
  const protocol = request.protocol;
  const host = request.get("host") ?? `localhost:${config.port}`;
  const url = new URL(`${protocol}://${host}/auth/login`);
  url.searchParams.set("userId", userId);
  return url.toString();
}
