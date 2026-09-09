import express, { type Request, type Response } from "express";
import session from "express-session";
import { generateVoiceAnswer } from "./answerGenerator.js";
import {
  AuthRequiredError,
  clearSalesforceOAuth,
  createSalesforceAuthorizationUrl,
  getSalesforceAuthContext,
  getSalesforceAuthStatus,
  handleSalesforceOAuthCallback
} from "./auth.js";
import { config } from "./config.js";
import { ConversationStore, normalizeConversationId } from "./conversationStore.js";
import { renderDashboard } from "./dashboard.js";
import { SalesforceMcpClient } from "./mcpClient.js";
import { ERROR_ANSWER, UNSUPPORTED_ANSWER } from "./responseFormatter.js";
import { selectTool } from "./toolSelector.js";
import type { AskRequest, AskResponse, ConversationTurn, JsonObject, JsonValue, Logger, McpTool } from "./types.js";

const app = express();
const TOOL_CACHE_TTL_MS = 30_000;
const toolCache = new Map<string, { expiresAt: number; tools: McpTool[] }>();
const conversationStore = new ConversationStore(
  config.conversation.ttlMs,
  config.conversation.maxTurns,
  config.conversation.maxSessions
);

app.use(express.json({ limit: "1mb" }));
app.set("trust proxy", 1);
app.use(
  session({
    name: "local-mcp-proxy.sid",
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
      salesforceUserId: result.salesforceUserId ?? "",
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
  conversationStore.clearUser(userId);
  response.json({
    status: "ok",
    userId
  });
});

app.get("/mcp/tools", async (request: Request, response: Response) => {
  const userId = readQueryString(request.query.userId) || request.session.userId || config.defaultUserId;

  try {
    const { mcpClient, authContext } = await createMcpClient(userId, request.session);
    await mcpClient.connect();
    const tools = await mcpClient.listTools();

    logger.info("mcp_tools_discovered", {
      userId,
      salesforceUserId: authContext.salesforceUserId ?? "",
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
        answer: "Necesito que inicies sesión en Salesforce antes de consultar las tools MCP.",
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
      answer: ERROR_ANSWER,
      intent: "error",
      raw: buildErrorDiagnostic(error)
    });
  }
});

app.post("/ask", async (request: Request<unknown, AskResponse, AskRequest>, response: Response<AskResponse>) => {
  const appUserId = request.body.userId?.trim() || config.defaultUserId;
  const conversationId = normalizeConversationId(request.body.conversationId);

  try {
    const question = request.body.question?.trim();

    if (!question) {
      response.status(400).json({
        answer: "Necesito una pregunta para consultar Salesforce.",
        intent: "invalid_request",
        tool: null,
        raw: {}
      });
      return;
    }

    if (request.body.resetConversation) {
      conversationStore.clear(appUserId, conversationId);
    }

    const conversation = conversationStore.get(appUserId, conversationId);
    const duplicateTurn = findRecentDuplicateTurn(conversation.turns, question);
    if (duplicateTurn) {
      logger.warn("duplicate_question_reused", {
        userId: appUserId,
        conversationId,
        intent: duplicateTurn.intent,
        tool: duplicateTurn.toolName
      });
      response.json({
        answer: duplicateTurn.answer,
        intent: duplicateTurn.intent,
        tool: duplicateTurn.toolName,
        raw: duplicateTurn.result,
        conversationId
      });
      return;
    }

    logger.info("incoming_question", {
      userId: appUserId,
      conversationId,
      contextTurns: conversation.turns.length,
      question
    });

    const { mcpClient, authContext } = await createMcpClient(appUserId, request.session);
    const salesforceUserId = authContext.salesforceUserId ?? appUserId;

    logger.info("salesforce_user_context_resolved", {
      appUserId,
      salesforceUserId,
      hasSalesforceUserId: Boolean(authContext.salesforceUserId)
    });

    await mcpClient.connect();

    const tools = await listToolsWithCache(mcpClient, appUserId);
    logger.info("mcp_tools_discovered", {
      count: tools.length
    });

    const selection = await selectTool({
      question,
      userId: salesforceUserId,
      currentDate: new Date().toISOString().slice(0, 10),
      tools,
      conversation,
      config,
      logger
    });

    logger.info("tool_selected", {
      intent: selection.intent,
      tool: selection.toolName
    });

    if (!selection.toolName) {
      const isAmbiguousReference = selection.intent === "ambiguous_reference";
      response.json({
        answer: isAmbiguousReference
          ? "No puedo identificar una única tarea con ese nombre. Dime el asunto exacto o cuál de las tareas quieres cerrar."
          : UNSUPPORTED_ANSWER,
        intent: isAmbiguousReference ? selection.intent : "unsupported",
        tool: null,
        raw: {}
      });
      return;
    }

    logger.info("tool_input_built", {
      tool: selection.toolName,
      input: sanitizeForLog(selection.toolInput)
    });

    const raw = await mcpClient.callTool(selection.toolName, selection.toolInput);
    logger.info("mcp_execution_result", {
      result: sanitizeForLog(raw)
    });

    if (isToolErrorResult(raw)) {
      logger.warn("mcp_tool_result_rejected_from_context", {
        tool: selection.toolName,
        error: extractToolErrorCode(raw) ?? "unknown_tool_error"
      });
      response.json({
        answer: "Salesforce no ha podido ejecutar esa consulta. No guardaré este resultado en la conversación.",
        intent: "tool_error",
        tool: selection.toolName,
        raw,
        conversationId
      });
      return;
    }

    const answer = await generateVoiceAnswer({
      question,
      selection,
      raw,
      config,
      logger
    });

    const turn: ConversationTurn = {
      question,
      intent: selection.intent,
      toolName: selection.toolName,
      toolInput: selection.toolInput,
      answer,
      result: raw,
      createdAt: new Date().toISOString()
    };
    conversationStore.addTurn(appUserId, conversationId, turn);

    response.json({
      answer,
      intent: selection.intent,
      tool: selection.toolName,
      raw,
      conversationId
    });
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      response.status(401).json({
        answer: "Necesito que inicies sesión en Salesforce antes de consultar. Abre la URL de autenticación del servicio.",
        intent: "auth_required",
        tool: null,
        raw: {
          authUrl: buildLocalAuthUrl(request, appUserId)
        }
      });
      return;
    }

    logger.error("ask_error", {
      message: error instanceof Error ? error.message : "Unknown error"
    });

    response.status(500).json({
      answer: ERROR_ANSWER,
      intent: "error",
      tool: null,
      raw: buildErrorDiagnostic(error)
    });
  }
});

app.post(
  "/conversation/reset",
  (request: Request<unknown, JsonObject, { userId?: string; conversationId?: string }>, response: Response) => {
    const userId = request.body.userId?.trim() || config.defaultUserId;
    const conversationId = normalizeConversationId(request.body.conversationId);
    const cleared = conversationStore.clear(userId, conversationId);
    response.json({ status: "ok", userId, conversationId, cleared });
  }
);

app.listen(config.port, () => {
  logger.info("server_started", {
    port: config.port
  });
});

async function createMcpClient(
  userId: string,
  sessionData: Request["session"] | undefined
): Promise<{ mcpClient: SalesforceMcpClient; authContext: Awaited<ReturnType<typeof getSalesforceAuthContext>> }> {
  const authRequest: Parameters<typeof getSalesforceAuthContext>[0] = {
    appConfig: config,
    userId
  };

  if (sessionData) {
    authRequest.session = sessionData;
  }

  const authContext = await getSalesforceAuthContext(authRequest);

  return {
    mcpClient: new SalesforceMcpClient(config.salesforce.mcpServerUrl, authContext.accessToken, logger),
    authContext
  };
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

function isToolErrorResult(value: JsonValue): boolean {
  if (Array.isArray(value)) {
    return value.some(isToolErrorResult);
  }
  if (!isJsonObject(value)) return false;

  if (typeof value.errorCode === "string" || value.isError === true || value.success === false) {
    return true;
  }
  if (Array.isArray(value.errors) && value.errors.length > 0) {
    return true;
  }
  return Object.values(value).some((item) =>
    typeof item === "object" && item !== null ? isToolErrorResult(item) : false
  );
}

function extractToolErrorCode(value: JsonValue): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const code = extractToolErrorCode(item);
      if (code) return code;
    }
    return undefined;
  }
  if (!isJsonObject(value)) return undefined;
  if (typeof value.errorCode === "string") return value.errorCode;
  for (const item of Object.values(value)) {
    if (typeof item === "object" && item !== null) {
      const code = extractToolErrorCode(item);
      if (code) return code;
    }
  }
  return undefined;
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

function findRecentDuplicateTurn(turns: ConversationTurn[], question: string): ConversationTurn | undefined {
  const previous = turns.at(-1);
  if (!previous) return undefined;
  const createdAt = Date.parse(previous.createdAt);
  if (!Number.isFinite(createdAt) || Date.now() - createdAt > 15_000) return undefined;
  return normalizeQuestion(previous.question) === normalizeQuestion(question) ? previous : undefined;
}

function normalizeQuestion(question: string): string {
  return question
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function listToolsWithCache(mcpClient: SalesforceMcpClient, userId: string): Promise<McpTool[]> {
  const cached = toolCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    logger.info("mcp_tools_cache_hit", { userId, count: cached.tools.length });
    return cached.tools;
  }

  const tools = await mcpClient.listTools();
  toolCache.set(userId, {
    tools,
    expiresAt: Date.now() + TOOL_CACHE_TTL_MS
  });
  return tools;
}
