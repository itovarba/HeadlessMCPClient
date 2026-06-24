import type { AppConfig } from "./config.js";
import type { JsonObject, JsonValue, Logger, McpTool, ToolSelection } from "./types.js";

const TOOL_SELECTOR_SYSTEM_PROMPT = `You are a dynamic MCP tool selection layer for a Headless 360 assistant.

You receive:
- a user question from a local MCP proxy client
- the current user id
- the current date
- a list of MCP tools exposed by the connected MCP server

Your job:
Select the best MCP tool and build the JSON input for that tool.

Rules:
- Return strict JSON only.
- Do not include markdown, code fences, comments, or explanatory text.
- Select only one tool.
- toolName must exactly match one available MCP tool.
- Use the tool descriptions and input schemas as the source of truth.
- Do not invent tool names.
- Do not invent fields that are not in the selected tool schema.
- toolInput must be a JSON object.
- userId is the current Salesforce User Id when available. Use it for OwnerId, user id, manager, or owner fields when the schema or SOQL query requires the current user.
- If the request is ambiguous, choose the safest read-only tool.
- If a write/action tool is selected, make sure the user clearly requested an action.
- If no tool is appropriate, return:
{
  "intent": "unsupported",
  "toolName": null,
  "toolInput": {}
}

Return format:
{
  "intent": "short_intent_name",
  "toolName": "exact MCP tool name or null",
  "toolInput": {}
}`;

interface OpenAiChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
  };
}

interface OpenAiUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

interface OpenAiSelectionResult {
  selection: ToolSelection;
  usage?: OpenAiUsage;
}

export async function selectTool(params: {
  question: string;
  userId: string;
  currentDate: string;
  tools: McpTool[];
  config: AppConfig;
  logger?: Logger;
}): Promise<ToolSelection> {
  const { question, userId, currentDate, tools, config, logger } = params;

  if (tools.length === 0) {
    return unsupportedSelection();
  }

  let fallbackReason = "openai_not_configured";

  if (config.llm.provider === "openai" && config.llm.openaiApiKey) {
    try {
      logger?.info("llm_tool_selection_started", {
        provider: "openai",
        model: config.llm.openaiModel,
        endpoint: "/v1/chat/completions"
      });

      const llmResult = await selectWithOpenAi({
        question,
        userId,
        currentDate,
        tools,
        config
      });

      const normalizedSelection = normalizeAndValidateSelection(llmResult.selection, tools, { question, userId, currentDate });
      const successLog: JsonObject = {
        provider: "openai",
        model: config.llm.openaiModel,
        intent: normalizedSelection.intent,
        tool: normalizedSelection.toolName
      };

      if (llmResult.usage) {
        successLog.usage = { ...llmResult.usage };
      }

      logger?.info("llm_tool_selection_succeeded", successLog);

      return normalizedSelection;
    } catch (error) {
      fallbackReason = "llm_error";
      logger?.warn("llm_tool_selection_failed", {
        message: error instanceof Error ? error.message : "Unknown LLM selection error"
      });
    }
  } else if (config.llm.provider === "none") {
    fallbackReason = "provider_disabled";
  } else if (!config.llm.openaiApiKey) {
    fallbackReason = "api_key_missing";
  }

  if (config.enableDeterministicFallback) {
    logger?.info("deterministic_tool_selection_used", {
      reason: fallbackReason
    });
    return selectWithDeterministicFallback({ question, userId, currentDate, tools });
  }

  return unsupportedSelection();
}

async function selectWithOpenAi(params: {
  question: string;
  userId: string;
  currentDate: string;
  tools: McpTool[];
  config: AppConfig;
}): Promise<OpenAiSelectionResult> {
  const { question, userId, currentDate, tools, config } = params;
  const body = {
    model: config.llm.openaiModel,
    temperature: 0,
    response_format: {
      type: "json_object"
    },
    messages: [
      {
        role: "system",
        content: TOOL_SELECTOR_SYSTEM_PROMPT
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            question,
            userId,
            currentDate,
            tools: tools.map((tool) => ({
              name: tool.name,
              description: tool.description ?? "",
              inputSchema: tool.inputSchema ?? {},
              outputSchema: tool.outputSchema ?? {},
              annotations: tool.annotations ?? {}
            }))
          },
          null,
          2
        )
      }
    ]
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.llm.openaiApiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const payload = (await response.json().catch(() => ({}))) as OpenAiChatResponse;
  if (!response.ok) {
    throw new Error(payload.error?.message ?? `OpenAI request failed with status ${response.status}`);
  }

  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI response did not include message content.");
  }

  const result: OpenAiSelectionResult = {
    selection: parseOpenAiSelection(content)
  };
  const usage = normalizeOpenAiUsage(payload.usage);
  if (usage) {
    result.usage = usage;
  }

  return result;
}

function parseOpenAiSelection(content: string): ToolSelection {
  const jsonText = extractJsonObject(content);
  const parsed = JSON.parse(jsonText) as unknown;
  if (!isJsonObject(parsed)) {
    throw new Error("OpenAI response was not a JSON object.");
  }

  return parsed as unknown as ToolSelection;
}

function extractJsonObject(content: string): string {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");

  if (start === -1 || end === -1 || end < start) {
    throw new Error("OpenAI response did not contain a JSON object.");
  }

  return candidate.slice(start, end + 1);
}

function normalizeOpenAiUsage(usage: OpenAiChatResponse["usage"]): OpenAiUsage | undefined {
  if (!usage) {
    return undefined;
  }

  const normalized: OpenAiUsage = {};
  if (typeof usage.prompt_tokens === "number") {
    normalized.promptTokens = usage.prompt_tokens;
  }
  if (typeof usage.completion_tokens === "number") {
    normalized.completionTokens = usage.completion_tokens;
  }
  if (typeof usage.total_tokens === "number") {
    normalized.totalTokens = usage.total_tokens;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function selectWithDeterministicFallback(params: {
  question: string;
  userId: string;
  currentDate: string;
  tools: McpTool[];
}): ToolSelection {
  const { question, userId, currentDate, tools } = params;
  const context = { question, userId, currentDate };
  const questionTerms = expandTerms(tokenize(question));
  const scoredTools = tools
    .map((tool) => {
      const searchable = `${tool.name} ${tool.description ?? ""} ${schemaSearchText(tool.inputSchema ?? {})}`;
      const toolTerms = new Set(expandTerms(tokenize(searchable)));
      const overlap = questionTerms.filter((term) => toolTerms.has(term)).length;
      const normalizedScore = overlap / Math.max(questionTerms.length, 1);
      const schemaScore = schemaHintScore(question, tool.inputSchema ?? {});
      const intentScore = toolIntentScore(questionTerms, tool);
      const canBuildInput = buildToolInputForTool(tool, context) !== undefined;
      const executableScore = canBuildInput ? 0.15 : -0.5;

      return {
        tool,
        score: normalizedScore + schemaScore + intentScore + executableScore
      };
    })
    .sort((a, b) => b.score - a.score);

  const best = scoredTools[0];
  if (!best || best.score < 0.18) {
    return unsupportedSelection();
  }

  const toolInput = buildToolInputForTool(best.tool, context);
  if (!toolInput) {
    return unsupportedSelection();
  }

  return {
    intent: inferIntent(question),
    toolName: best.tool.name,
    toolInput
  };
}

function normalizeAndValidateSelection(
  selection: ToolSelection,
  tools: McpTool[],
  context: { question: string; userId: string; currentDate: string }
): ToolSelection {
  const availableTool = selection.toolName
    ? tools.find((tool) => tool.name === selection.toolName)
    : undefined;

  if (!selection.toolName || !availableTool) {
    return unsupportedSelection(selection.intent);
  }

  return {
    intent: safeIntent(selection.intent),
    toolName: availableTool.name,
    toolInput: completeToolInput(availableTool, pruneToSchema(selection.toolInput ?? {}, availableTool.inputSchema ?? {}), context)
  };
}

function completeToolInput(
  tool: McpTool,
  input: JsonObject,
  context: { question: string; userId: string; currentDate: string }
): JsonObject {
  const generated = buildToolInputForTool(tool, context);
  return {
    ...(generated ?? {}),
    ...input
  };
}

function buildToolInputForTool(
  tool: McpTool,
  context: { question: string; userId: string; currentDate: string }
): JsonObject | undefined {
  const schema = tool.inputSchema ?? {};
  const properties = getSchemaProperties(schema);
  if (!properties) {
    return {};
  }

  if ("q" in properties) {
    const q = buildSoqlQuery(context.question, context.userId);
    return q ? { q } : undefined;
  }

  const flowInput = buildFlowStyleInput(properties, context);
  if (flowInput) {
    return flowInput;
  }

  const input = buildMinimalToolInput(schema, context);
  return satisfiesRequiredSchema(schema, input) ? input : undefined;
}

function buildFlowStyleInput(
  properties: Record<string, JsonValue>,
  context: { question: string; userId: string; currentDate: string }
): JsonObject | undefined {
  const inputsSchema = properties.inputs;
  if (!isJsonObject(inputsSchema) || inputsSchema.type !== "array" || !isJsonObject(inputsSchema.items)) {
    return undefined;
  }

  const itemProperties = getSchemaProperties(inputsSchema.items);
  if (!itemProperties) {
    return undefined;
  }

  const item: JsonObject = {};
  for (const fieldName of Object.keys(itemProperties)) {
    const normalized = normalizeToken(fieldName);
    if (matchesAny(normalized, ["userquestion", "question", "prompt", "query", "request", "text"])) {
      item[fieldName] = context.question;
    } else if (matchesAny(normalized, ["userid", "user", "owner"])) {
      item[fieldName] = context.userId;
    } else if (matchesAny(normalized, ["date", "today", "currentdate"])) {
      item[fieldName] = context.currentDate;
    }
  }

  return Object.keys(item).length > 0 ? { inputs: [item] } : undefined;
}

function pruneToSchema(input: JsonObject, schema: JsonObject): JsonObject {
  const properties = getSchemaProperties(schema);
  if (!properties) {
    return input;
  }

  const pruned: JsonObject = {};
  for (const key of Object.keys(properties)) {
    const value = input[key];
    if (value !== undefined) {
      pruned[key] = value;
    }
  }
  return pruned;
}

function buildMinimalToolInput(
  schema: JsonObject,
  context: { question: string; userId: string; currentDate: string }
): JsonObject {
  const properties = getSchemaProperties(schema);
  if (!properties) {
    return {};
  }

  const input: JsonObject = {};
  const required = Array.isArray(schema.required) ? schema.required.filter((item) => typeof item === "string") : [];

  for (const [fieldName, propertySchema] of Object.entries(properties)) {
    const lowerName = fieldName.toLowerCase();
    const isRequired = required.includes(fieldName);
    const value = valueForSchemaField(lowerName, propertySchema, context, isRequired);
    if (value !== undefined) {
      input[fieldName] = value;
    }
  }

  return input;
}

function valueForSchemaField(
  lowerName: string,
  propertySchema: JsonValue,
  context: { question: string; userId: string; currentDate: string },
  isRequired: boolean
): JsonValue | undefined {
  const schemaObject = isJsonObject(propertySchema) ? propertySchema : {};
  const type = typeof schemaObject.type === "string" ? schemaObject.type : undefined;

  if (matchesAny(lowerName, ["sobject-name", "sobjectname", "object", "objectname"])) {
    return inferSObjectName(context.question);
  }

  if (lowerName === "id" || lowerName.endsWith("_id") || lowerName.endsWith("-id")) {
    return extractSalesforceId(context.question);
  }

  if (matchesAny(lowerName, ["relationship-path", "relationshippath", "relationship"])) {
    return inferRelationshipPath(context.question);
  }

  if (lowerName === "q") {
    return buildSoqlQuery(context.question, context.userId);
  }

  if (matchesAny(lowerName, ["userid", "user_id", "user", "owner", "manager", "salesmanager", "sales_manager"])) {
    return context.userId;
  }

  if (matchesAny(lowerName, ["date", "today", "currentdate", "current_date", "asof", "as_of"])) {
    return context.currentDate;
  }

  if (matchesAny(lowerName, ["question", "query", "prompt", "search", "text", "request"])) {
    return context.question;
  }

  if (matchesAny(lowerName, ["limit", "max", "count", "size"])) {
    return 3;
  }

  if (!isRequired) {
    return undefined;
  }

  if (type === "string") {
    return undefined;
  }

  if (type === "number" || type === "integer") {
    return 3;
  }

  if (type === "boolean") {
    return false;
  }

  if (type === "array") {
    return [];
  }

  if (type === "object") {
    return undefined;
  }

  return undefined;
}

function satisfiesRequiredSchema(schema: JsonObject, input: JsonObject): boolean {
  const required = Array.isArray(schema.required) ? schema.required.filter((item) => typeof item === "string") : [];
  return required.every((fieldName) => input[fieldName] !== undefined);
}

function getSchemaProperties(schema: JsonObject): Record<string, JsonValue> | undefined {
  if (!isJsonObject(schema.properties)) {
    return undefined;
  }

  return schema.properties as Record<string, JsonValue>;
}

function schemaHintScore(question: string, schema: JsonObject): number {
  const properties = getSchemaProperties(schema);
  if (!properties) {
    return 0;
  }

  const schemaTerms = new Set(expandTerms(tokenize(Object.keys(properties).join(" "))));
  const questionTerms = expandTerms(tokenize(question));
  const overlap = questionTerms.filter((term) => schemaTerms.has(term)).length;
  return overlap / Math.max(questionTerms.length, 1) / 2;
}

function tokenize(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 2 && !STOP_WORDS.has(term));
}

function expandTerms(terms: string[]): string[] {
  const expanded = new Set<string>();
  for (const term of terms) {
    expanded.add(term);
    if (term.endsWith("s") && term.length > 4) {
      expanded.add(term.slice(0, -1));
    }

    const translations = TERM_EQUIVALENTS[term] ?? [];
    for (const translation of translations) {
      expanded.add(translation);
    }
  }
  return [...expanded];
}

function toolIntentScore(questionTerms: string[], tool: McpTool): number {
  const name = tool.name.toLowerCase();
  const description = (tool.description ?? "").toLowerCase();
  const isWriteTool = /create|update|delete|upsert|modify|write/.test(name);
  const hasWriteIntent = questionTerms.some((term) => WRITE_TERMS.has(term));
  const hasReadObjectIntent = questionTerms.some((term) => SALESFORCE_OBJECT_TERMS.has(term));
  const hasSuccessCaseIntent = questionTerms.some((term) => SUCCESS_CASE_TERMS.has(term));

  if (isWriteTool && !hasWriteIntent) {
    return -0.55;
  }

  if (name.includes("soql") && hasReadObjectIntent) {
    return 0.35;
  }

  if ((name.includes("success") || description.includes("success cases")) && hasSuccessCaseIntent) {
    return 0.45;
  }

  if (name.includes("userinfo") && questionTerms.some((term) => USER_INFO_TERMS.has(term))) {
    return 0.35;
  }

  if (name.includes("relatedrecords") && !questionTerms.some((term) => RELATIONSHIP_TERMS.has(term))) {
    return -0.3;
  }

  return 0;
}

function buildSoqlQuery(question: string, userId: string): string | undefined {
  const terms = new Set(expandTerms(tokenize(question)));
  const ownerFilter = buildOwnerFilter(terms, userId);

  if (hasAny(terms, ["task", "todo", "activity", "tarea", "actividad"])) {
    return `SELECT Id, Subject, Status, ActivityDate, Priority, WhatId, WhoId FROM Task WHERE ${[
      ownerFilter,
      "Status != 'Completed'"
    ].filter(Boolean).join(" AND ")} ORDER BY ActivityDate ASC LIMIT 10`;
  }

  if (hasAny(terms, ["opportunity", "pipeline", "oportunidad", "deal"])) {
    return `SELECT Id, Name, StageName, Amount, CloseDate, Account.Name FROM Opportunity WHERE ${[
      ownerFilter,
      "IsClosed = false"
    ].filter(Boolean).join(" AND ")} ORDER BY CloseDate ASC LIMIT 10`;
  }

  if (hasAny(terms, ["contact", "contacto"])) {
    const where = ownerFilter ? ` WHERE ${ownerFilter}` : "";
    return `SELECT Id, Name, Email, Phone, Account.Name FROM Contact${where} ORDER BY LastModifiedDate DESC LIMIT 10`;
  }

  if (hasAny(terms, ["case", "ticket"]) && !hasAny(terms, ["success"])) {
    const where = ownerFilter ? ` WHERE ${ownerFilter}` : "";
    return `SELECT Id, CaseNumber, Subject, Status, Priority, Account.Name FROM Case${where} ORDER BY LastModifiedDate DESC LIMIT 10`;
  }

  if (hasAny(terms, ["account", "customer", "client", "cuenta", "cliente"])) {
    const where = ownerFilter ? ` WHERE ${ownerFilter}` : "";
    return `SELECT Id, Name, Type, Industry, Owner.Name, LastModifiedDate FROM Account${where} ORDER BY LastModifiedDate DESC LIMIT 10`;
  }

  return undefined;
}

function buildOwnerFilter(terms: Set<string>, userId: string): string | undefined {
  if (!isSalesforceId(userId)) {
    return undefined;
  }

  const isSelfScoped = hasAny(terms, [
    "my",
    "mine",
    "own",
    "me",
    "mi",
    "mis",
    "mio",
    "mios",
    "debo",
    "tengo",
    "asignado",
    "asignada",
    "asignados",
    "asignadas"
  ]);

  return isSelfScoped ? `OwnerId = '${userId}'` : undefined;
}

function inferSObjectName(question: string): string | undefined {
  const terms = new Set(expandTerms(tokenize(question)));
  if (hasAny(terms, ["account", "customer", "client", "cuenta", "cliente"])) return "Account";
  if (hasAny(terms, ["task", "todo", "activity", "tarea", "actividad"])) return "Task";
  if (hasAny(terms, ["contact", "contacto"])) return "Contact";
  if (hasAny(terms, ["opportunity", "pipeline", "oportunidad", "deal"])) return "Opportunity";
  if (hasAny(terms, ["case", "ticket"])) return "Case";
  return undefined;
}

function inferRelationshipPath(question: string): string | undefined {
  const terms = new Set(expandTerms(tokenize(question)));
  if (hasAny(terms, ["contact", "contacto"])) return "Contacts";
  if (hasAny(terms, ["opportunity", "pipeline", "oportunidad", "deal"])) return "Opportunities";
  if (hasAny(terms, ["case", "ticket"])) return "Cases";
  if (hasAny(terms, ["task", "todo", "activity", "tarea", "actividad"])) return "Tasks";
  return undefined;
}

function extractSalesforceId(text: string): string | undefined {
  return text.match(/\b[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?\b/)?.[0];
}

function isSalesforceId(value: string): boolean {
  return /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(value);
}

function schemaSearchText(value: JsonValue): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(schemaSearchText).join(" ");
  }
  if (isJsonObject(value)) {
    return Object.entries(value)
      .map(([key, item]) => `${key} ${schemaSearchText(item)}`)
      .join(" ");
  }
  return "";
}

function normalizeToken(text: string): string {
  return tokenize(text).join("");
}

function hasAny(terms: Set<string>, candidates: string[]): boolean {
  return candidates.some((candidate) => terms.has(candidate));
}

function inferIntent(question: string): string {
  const terms = tokenize(question);
  const firstTerms = terms.slice(0, 3);
  return safeIntent(firstTerms.join("_") || "detected_intent");
}

function safeIntent(intent: string | undefined): string {
  const normalized = (intent ?? "detected_intent")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return normalized || "detected_intent";
}

function unsupportedSelection(intent = "unsupported"): ToolSelection {
  return {
    intent: safeIntent(intent) === "unsupported" ? "unsupported" : "unsupported",
    toolName: null,
    toolInput: {}
  };
}

function matchesAny(value: string, candidates: string[]): boolean {
  return candidates.some((candidate) => value.includes(candidate));
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const STOP_WORDS = new Set([
  "me",
  "mi",
  "mis",
  "tus",
  "sus",
  "hay",
  "tengo",
  "tiene",
  "tienen",
  "hacer",
  "hablame",
  "dime",
  "sobre",
  "que",
  "para",
  "por",
  "con",
  "los",
  "las",
  "del",
  "una",
  "unos",
  "unas",
  "the",
  "and",
  "for",
  "from",
  "what",
  "which",
  "today",
  "hoy",
  "debo",
  "debe",
  "necesito",
  "quiero"
]);

const TERM_EQUIVALENTS: Record<string, string[]> = {
  cuenta: ["account", "accounts", "customer", "client"],
  cuentas: ["account", "accounts", "customer", "client"],
  cliente: ["account", "customer", "client"],
  clientes: ["account", "accounts", "customers", "clients"],
  contacto: ["contact"],
  contactos: ["contact", "contacts"],
  oportunidad: ["opportunity", "deal", "pipeline"],
  oportunidades: ["opportunity", "opportunities", "deals", "pipeline"],
  tarea: ["task", "todo", "activity"],
  tareas: ["task", "tasks", "todo", "activity"],
  actividad: ["task", "activity"],
  actividades: ["task", "tasks", "activity", "activities"],
  caso: ["case"],
  casos: ["case", "cases"],
  exito: ["success"],
  exitos: ["success"],
  priorizar: ["priority", "prioritize", "account", "customer"],
  prioritarios: ["priority", "prioritize"],
  pendientes: ["open", "todo", "task"],
  consultar: ["get", "read", "query"],
  buscar: ["search", "query"],
  obtener: ["get", "read"],
  crear: ["create"],
  actualizar: ["update"],
  modificar: ["update"],
  borrar: ["delete"],
  eliminar: ["delete"],
  account: ["cuenta", "cliente"],
  accounts: ["cuentas", "clientes"],
  customer: ["cliente", "cuenta"],
  customers: ["clientes", "cuentas"],
  client: ["cliente", "cuenta"],
  clients: ["clientes", "cuentas"],
  task: ["tarea", "actividad"],
  tasks: ["tareas", "actividades"],
  success: ["exito"],
  case: ["caso"],
  cases: ["casos"]
};

const SALESFORCE_OBJECT_TERMS = new Set([
  "account",
  "accounts",
  "customer",
  "customers",
  "client",
  "clients",
  "cuenta",
  "cuentas",
  "cliente",
  "clientes",
  "task",
  "tasks",
  "todo",
  "activity",
  "tarea",
  "tareas",
  "contact",
  "contacts",
  "contacto",
  "contactos",
  "opportunity",
  "opportunities",
  "pipeline",
  "oportunidad",
  "oportunidades",
  "case",
  "cases",
  "caso",
  "casos"
]);

const SUCCESS_CASE_TERMS = new Set(["success", "exito", "case", "cases", "caso", "casos", "ntt", "data"]);
const USER_INFO_TERMS = new Set(["user", "usuario", "perfil", "profile", "manager", "role", "rol"]);
const RELATIONSHIP_TERMS = new Set(["related", "relationship", "relacion", "relacionados", "contacts", "opportunities", "cases"]);
const WRITE_TERMS = new Set(["create", "crear", "update", "actualizar", "modificar", "delete", "borrar", "eliminar", "change", "cambiar"]);
