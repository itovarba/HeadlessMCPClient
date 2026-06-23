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
- Select only one tool.
- toolName must exactly match one available MCP tool.
- Use the tool descriptions and input schemas as the source of truth.
- Do not invent tool names.
- Do not invent fields that are not in the selected tool schema.
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
  error?: {
    message?: string;
  };
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

  if (config.llm.provider === "openai" && config.llm.openaiApiKey) {
    try {
      const llmSelection = await selectWithOpenAi({
        question,
        userId,
        currentDate,
        tools,
        config
      });

      return normalizeAndValidateSelection(llmSelection, tools);
    } catch (error) {
      logger?.warn("llm_tool_selection_failed", {
        message: error instanceof Error ? error.message : "Unknown LLM selection error"
      });
    }
  }

  if (config.enableDeterministicFallback) {
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
}): Promise<ToolSelection> {
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

  return JSON.parse(content) as ToolSelection;
}

function selectWithDeterministicFallback(params: {
  question: string;
  userId: string;
  currentDate: string;
  tools: McpTool[];
}): ToolSelection {
  const { question, userId, currentDate, tools } = params;
  const questionTerms = tokenize(question);
  const scoredTools = tools
    .map((tool) => {
      const searchable = `${tool.name} ${tool.description ?? ""}`;
      const toolTerms = new Set(tokenize(searchable));
      const overlap = questionTerms.filter((term) => toolTerms.has(term)).length;
      const normalizedScore = overlap / Math.max(questionTerms.length, 1);
      const schemaScore = schemaHintScore(question, tool.inputSchema ?? {});

      return {
        tool,
        score: normalizedScore + schemaScore
      };
    })
    .sort((a, b) => b.score - a.score);

  const best = scoredTools[0];
  if (!best || best.score < 0.18) {
    return unsupportedSelection();
  }

  return {
    intent: inferIntent(question),
    toolName: best.tool.name,
    toolInput: buildMinimalToolInput(best.tool.inputSchema ?? {}, {
      question,
      userId,
      currentDate
    })
  };
}

function normalizeAndValidateSelection(selection: ToolSelection, tools: McpTool[]): ToolSelection {
  const availableTool = selection.toolName
    ? tools.find((tool) => tool.name === selection.toolName)
    : undefined;

  if (!selection.toolName || !availableTool) {
    return unsupportedSelection(selection.intent);
  }

  return {
    intent: safeIntent(selection.intent),
    toolName: availableTool.name,
    toolInput: pruneToSchema(selection.toolInput ?? {}, availableTool.inputSchema ?? {})
  };
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
    return context.question;
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
    return {};
  }

  return undefined;
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

  const schemaTerms = new Set(tokenize(Object.keys(properties).join(" ")));
  const questionTerms = tokenize(question);
  const overlap = questionTerms.filter((term) => schemaTerms.has(term)).length;
  return overlap / Math.max(questionTerms.length, 1) / 2;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9_]+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 2 && !STOP_WORDS.has(term));
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
