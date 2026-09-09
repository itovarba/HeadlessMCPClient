import type { AppConfig } from "./config.js";
import { requestJsonCompletion, type LlmUsage } from "./llmClient.js";
import type { ConversationContext, JsonObject, JsonValue, Logger, McpTool, ToolSelection } from "./types.js";

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
- conversation contains earlier successful turns from the same conversation. Use it to resolve follow-ups, pronouns, omitted objects, filters, and references such as "la primera", "esas", "sus contactos", or "ahora las cerradas".
- A follow-up may intentionally select a different tool from the previous turn. Always choose from the current dynamic tool list.
- Reuse record IDs or other facts only when they are explicitly present in conversation. Never invent them.
- For a request to close, finish, or mark a Salesforce Task as done, select an available update tool, reuse the exact matching Task Id from conversation, and set its Status to "Completed" using the selected tool schema.
- Never update a record when the requested target cannot be identified from the current question or conversation.
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

interface LlmSelectionResult {
  selection: ToolSelection;
  usage?: LlmUsage;
}

export async function selectTool(params: {
  question: string;
  userId: string;
  currentDate: string;
  tools: McpTool[];
  conversation?: ConversationContext;
  config: AppConfig;
  logger?: Logger;
}): Promise<ToolSelection> {
  const { question, userId, currentDate, tools, conversation, config, logger } = params;

  if (tools.length === 0) {
    return unsupportedSelection();
  }

  if (hasTaskCompletionRequest(question) && !hasResolvableRecordReference(question, conversation)) {
    logger?.warn("task_reference_not_resolved", {
      conversationId: conversation?.conversationId ?? "",
      contextTurns: conversation?.turns.length ?? 0
    });
    return unresolvedReferenceSelection();
  }

  const resolvedQuestion = buildContextualQuestion(question, conversation);
  if (!hasExplicitWriteIntent(question)) {
    const stableReadSelection = selectStableReadTool(resolvedQuestion, userId, tools);
    if (stableReadSelection) {
      logger?.info("stable_read_tool_selected", {
        intent: stableReadSelection.intent,
        tool: stableReadSelection.toolName
      });
      return stableReadSelection;
    }
  }

  let fallbackReason = "llm_not_configured";

  const canUseLlm = config.llm.provider === "ollama" ||
    (config.llm.provider === "openai" && Boolean(config.llm.apiKey));

  if (canUseLlm) {
    try {
      logger?.info("llm_tool_selection_started", {
        provider: config.llm.provider,
        model: config.llm.model,
        endpoint: `${config.llm.baseUrl}/chat/completions`
      });

      const llmResult = await selectWithLlm({
        question,
        userId,
        currentDate,
        tools,
        conversation,
        config
      });

      const normalizedSelection = enforceExplicitWriteIntent(
        normalizeAndValidateSelection(llmResult.selection, tools, {
        question: resolvedQuestion,
        userId,
        currentDate
        }),
        question,
        tools,
        logger
      );
      const contextualFallback = conversation?.turns.length && looksLikeFollowUp(question)
        ? selectWithDeterministicFallback({ question, userId, currentDate, tools, conversation })
        : undefined;

      if (
        normalizedSelection.toolName &&
        contextualFallback?.toolName === normalizedSelection.toolName
      ) {
        const reconciledSelection: ToolSelection = {
          intent: contextualFallback.intent,
          toolName: normalizedSelection.toolName,
          toolInput: {
            ...normalizedSelection.toolInput,
            ...contextualFallback.toolInput
          }
        };
        logger?.info("llm_tool_selection_reconciled_with_context", {
          provider: config.llm.provider,
          model: config.llm.model,
          intent: reconciledSelection.intent,
          tool: reconciledSelection.toolName
        });
        return enforceExplicitWriteIntent(reconciledSelection, question, tools, logger);
      }

      if (!normalizedSelection.toolName && config.enableDeterministicFallback) {
        const recoveredSelection = selectWithDeterministicFallback({ question, userId, currentDate, tools, conversation });
        if (recoveredSelection.toolName) {
          logger?.info("llm_tool_selection_recovered_with_fallback", {
            provider: config.llm.provider,
            model: config.llm.model,
            intent: recoveredSelection.intent,
            tool: recoveredSelection.toolName
          });
          return enforceExplicitWriteIntent(recoveredSelection, question, tools, logger);
        }
      }

      const successLog: JsonObject = {
        provider: config.llm.provider,
        model: config.llm.model,
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
  } else if (config.llm.provider === "openai" && !config.llm.apiKey) {
    fallbackReason = "api_key_missing";
  }

  if (config.enableDeterministicFallback) {
    logger?.info("deterministic_tool_selection_used", {
      reason: fallbackReason
    });
    return enforceExplicitWriteIntent(
      selectWithDeterministicFallback({ question, userId, currentDate, tools, conversation }),
      question,
      tools,
      logger
    );
  }

  return unsupportedSelection();
}

function selectStableReadTool(question: string, userId: string, tools: McpTool[]): ToolSelection | undefined {
  const q = buildSoqlQuery(question, userId);
  if (!q) return undefined;

  const queryTool = tools.find((tool) => {
    const properties = getSchemaProperties(tool.inputSchema ?? {});
    if (!properties || !("q" in properties)) return false;
    const searchable = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
    return searchable.includes("soql") || searchable.includes("query");
  });
  if (!queryTool) return undefined;

  return {
    intent: inferIntent(question),
    toolName: queryTool.name,
    toolInput: { q }
  };
}

async function selectWithLlm(params: {
  question: string;
  userId: string;
  currentDate: string;
  tools: McpTool[];
  conversation: ConversationContext | undefined;
  config: AppConfig;
}): Promise<LlmSelectionResult> {
  const { question, userId, currentDate, tools, conversation, config } = params;
  const result = await requestJsonCompletion({
    config,
    systemPrompt: TOOL_SELECTOR_SYSTEM_PROMPT,
    userPayload: {
      question,
      userId,
      currentDate,
      conversation: conversation ? compactConversationForLlm(conversation) : { turns: [] },
      tools: tools.map((tool) => ({
        name: tool.name,
        description: (tool.description ?? "").slice(0, 1_200),
        inputSchema: tool.inputSchema ?? {}
      }))
    },
    maxTokens: 256
  });

  const selectionResult: LlmSelectionResult = {
    selection: result.value as unknown as ToolSelection
  };
  if (result.usage) {
    selectionResult.usage = result.usage;
  }
  return selectionResult;
}

function selectWithDeterministicFallback(params: {
  question: string;
  userId: string;
  currentDate: string;
  tools: McpTool[];
  conversation: ConversationContext | undefined;
}): ToolSelection {
  const { question, userId, currentDate, tools, conversation } = params;
  const contextualQuestion = buildContextualQuestion(question, conversation);
  const context = { question: contextualQuestion, userId, currentDate };
  const questionTerms = expandTerms(tokenize(contextualQuestion));
  const scoredTools = tools
    .map((tool) => {
      const searchable = `${tool.name} ${tool.description ?? ""} ${schemaSearchText(tool.inputSchema ?? {})}`;
      const toolTerms = new Set(expandTerms(tokenize(searchable)));
      const overlap = questionTerms.filter((term) => toolTerms.has(term)).length;
      const normalizedScore = overlap / Math.max(questionTerms.length, 1);
      const schemaScore = schemaHintScore(contextualQuestion, tool.inputSchema ?? {});
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
    intent: inferIntent(contextualQuestion),
    toolName: best.tool.name,
    toolInput
  };
}

function compactConversationForLlm(conversation: ConversationContext): JsonObject {
  return {
    conversationId: conversation.conversationId,
    turns: conversation.turns.slice(-2).map((turn) => ({
      question: turn.question,
      intent: turn.intent,
      toolName: turn.toolName,
      toolInput: limitContextValue(turn.toolInput, 800),
      answer: turn.answer.slice(0, 320),
      result: limitContextValue(turn.result, 1_500)
    }))
  };
}

function limitContextValue(value: JsonValue, maxLength: number): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized.length <= maxLength) {
    return value;
  }
  return { truncated: true, preview: serialized.slice(0, maxLength) };
}

function buildContextualQuestion(question: string, conversation?: ConversationContext): string {
  if (!conversation?.turns.length || !looksLikeFollowUp(question)) {
    return question;
  }

  const previous = conversation.turns.at(-1);
  if (!previous) {
    return question;
  }

  const referencedRecord = findReferencedRecord(previous.result, question);
  const reference = referencedRecord ? `Registro referenciado: ${JSON.stringify(referencedRecord)}. ` : "";
  const result = JSON.stringify(previous.result).slice(0, 1_500);
  const toolInput = JSON.stringify(previous.toolInput).slice(0, 800);
  return `${reference}${previous.question}. Intent anterior: ${previous.intent}. Resultado anterior: ${result}. Entrada anterior: ${toolInput}. Seguimiento: ${question}`;
}

function looksLikeFollowUp(question: string): boolean {
  const normalized = question.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (/^(ok|vale|bien|gracias|perfecto)[.!]?$/i.test(normalized)) {
    return false;
  }
  const contentTerms = tokenize(question);
  const hasExplicitTopic = Boolean(inferSObjectName(question)) ||
    contentTerms.some((term) => SUCCESS_TERMS.has(term) || USER_INFO_TERMS.has(term));
  const startsAsFollowUp = /^(ok|vale|bien|y|e|pero|entonces|ahora|tambien|ademas)\b/.test(normalized);
  const hasReference = /\b(ese|esa|esos|esas|este|esta|estos|estas|anterior|primero|primera|segundo|segunda|ultimo|ultima|sus|suyo|suya)\b/.test(normalized);
  const refersToDefiniteRecord = /\b(el|la|los|las)\s+(tarea|actividad|oportunidad|cuenta|caso|contacto)\b/.test(normalized);
  return startsAsFollowUp || hasReference || refersToDefiniteRecord ||
    hasTaskCompletionRequest(question) || (contentTerms.length <= 3 && !hasExplicitTopic);
}

function enforceExplicitWriteIntent(
  selection: ToolSelection,
  currentQuestion: string,
  tools: McpTool[],
  logger?: Logger
): ToolSelection {
  if (!selection.toolName) return selection;
  const tool = tools.find((candidate) => candidate.name === selection.toolName);
  if (!tool || !isWriteToolDefinition(tool) || hasExplicitWriteIntent(currentQuestion)) {
    return selection;
  }

  logger?.warn("inherited_write_intent_rejected", {
    tool: selection.toolName,
    intent: selection.intent
  });
  return unsupportedSelection();
}

function hasExplicitWriteIntent(question: string): boolean {
  const terms = new Set(expandTerms(tokenize(question)));
  return [...terms].some((term) => WRITE_TERMS.has(term)) || hasTaskCompletionRequest(question);
}

function isWriteToolDefinition(tool: McpTool): boolean {
  if (tool.annotations?.readOnlyHint === true) return false;
  const searchable = `${tool.name} ${tool.description ?? ""}`
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[_-]+/g, " ");
  return /\b(create|creates|update|updates|delete|deletes|upsert|modify|write|complete|close|insert|remove)\b/.test(searchable) ||
    tool.annotations?.destructiveHint === true;
}

function findReferencedRecord(value: JsonValue, question: string): JsonObject | undefined {
  const candidates = collectRecordCandidates(value);
  if (candidates.length === 0) return undefined;

  const questionTerms = new Set(tokenize(question));
  const scored = candidates
    .map((record, index) => {
      const searchable = Object.entries(record)
        .filter(([key, item]) => key !== "Id" && typeof item === "string")
        .map(([, item]) => item)
        .join(" ");
      const overlap = tokenize(searchable).filter((term) => questionTerms.has(term)).length;
      const ordinalScore = matchesOrdinal(question, index) ? 10 : 0;
      return { record, score: overlap + ordinalScore };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const next = scored[1];
  if (!best || best.score <= 0 || (next && next.score === best.score)) {
    return candidates.length === 1 ? candidates[0] : undefined;
  }
  return best.record;
}

function hasResolvableRecordReference(question: string, conversation?: ConversationContext): boolean {
  if (extractSalesforceId(question)) return true;
  const previous = conversation?.turns.at(-1);
  return previous ? Boolean(findReferencedRecord(previous.result, question)) : false;
}

function collectRecordCandidates(value: JsonValue, depth = 0): JsonObject[] {
  if (depth > 5) return [];
  if (typeof value === "string") {
    try {
      return collectRecordCandidates(JSON.parse(value) as JsonValue, depth + 1);
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectRecordCandidates(item, depth + 1));
  }
  if (!isJsonObject(value)) return [];

  const ownId = typeof value.Id === "string" && isSalesforceId(value.Id) ? [value] : [];
  return ownId.length > 0
    ? ownId
    : Object.values(value).flatMap((item) => collectRecordCandidates(item, depth + 1));
}

function matchesOrdinal(question: string, index: number): boolean {
  const normalized = question.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const ordinals = [
    /\b(primero|primera|1)\b/,
    /\b(segundo|segunda|2)\b/,
    /\b(tercero|tercera|3)\b/
  ];
  return ordinals[index]?.test(normalized) ?? false;
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
    toolInput: stabilizeToolInput(
      availableTool,
      completeToolInput(availableTool, pruneToSchema(selection.toolInput ?? {}, availableTool.inputSchema ?? {}), context),
      context
    )
  };
}

function stabilizeToolInput(
  tool: McpTool,
  input: JsonObject,
  context: { question: string; userId: string; currentDate: string }
): JsonObject {
  const stableInput = buildStableToolInputForQuestion(tool, context);
  return stableInput ? { ...input, ...stableInput } : input;
}

function buildStableToolInputForQuestion(
  tool: McpTool,
  context: { question: string; userId: string; currentDate: string }
): JsonObject | undefined {
  const properties = getSchemaProperties(tool.inputSchema ?? {});
  if (!properties || !("q" in properties)) {
    return undefined;
  }

  const q = buildSoqlQuery(context.question, context.userId);
  return q ? { q } : undefined;
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
      item[fieldName] = buildVoiceFriendlyQuestion(fieldName, context.question);
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

  if (
    lowerName === "id" ||
    lowerName.endsWith("_id") ||
    lowerName.endsWith("-id") ||
    matchesAny(lowerName, ["recordid", "taskid", "targetid", "entityid"])
  ) {
    return extractSalesforceId(context.question);
  }

  if (matchesAny(lowerName, ["status", "state"]) && hasTaskCompletionRequest(context.question)) {
    return "Completed";
  }

  if (matchesAny(lowerName, ["completed", "iscompleted", "done", "closed", "isclosed"]) &&
    hasTaskCompletionRequest(context.question)) {
    return type === "boolean" ? true : "Completed";
  }

  if (type === "object" && matchesAny(lowerName, ["fields", "values", "data", "record"])) {
    return buildMutationObject(lowerName, schemaObject, context);
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

function buildMutationObject(
  fieldName: string,
  schema: JsonObject,
  context: { question: string; userId: string; currentDate: string }
): JsonObject | undefined {
  const nestedProperties = getSchemaProperties(schema);
  if (nestedProperties) {
    const nested = buildMinimalToolInput(schema, context);
    return Object.keys(nested).length > 0 ? nested : undefined;
  }

  if (!hasTaskCompletionRequest(context.question)) return undefined;
  const id = extractSalesforceId(context.question);
  return fieldName.includes("record") && id
    ? { Id: id, Status: "Completed" }
    : { Status: "Completed" };
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

function tokenizeWithStopWords(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 1);
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
  const isWriteTool = isWriteToolDefinition(tool);
  const hasWriteIntent = questionTerms.some((term) => WRITE_TERMS.has(term));
  const hasTaskCompletionIntent = questionTerms.some((term) => ["task", "tarea", "activity"].includes(term)) &&
    questionTerms.some((term) => ["close", "complete", "done", "update"].includes(term));
  const hasReadObjectIntent = questionTerms.some((term) => SALESFORCE_OBJECT_TERMS.has(term));
  const hasSuccessCaseIntent =
    questionTerms.some((term) => SUCCESS_TERMS.has(term)) ||
    (questionTerms.includes("ntt") && questionTerms.includes("data"));
  const hasUserInfoIntent = questionTerms.some((term) => USER_INFO_TERMS.has(term));

  if (isWriteTool && !hasWriteIntent) {
    return -0.55;
  }

  if (isWriteTool && hasTaskCompletionIntent) {
    return 1.2;
  }

  if (!isWriteTool && hasTaskCompletionIntent) {
    return -0.6;
  }

  if (name.includes("soql") && hasReadObjectIntent) {
    return 0.55;
  }

  if ((name.includes("success") || description.includes("success cases")) && hasSuccessCaseIntent) {
    return 0.85;
  }

  if ((name.includes("success") || description.includes("success cases")) && !hasSuccessCaseIntent) {
    return -0.6;
  }

  if (name.includes("userinfo") && hasUserInfoIntent) {
    return 0.75;
  }

  if (name.includes("userinfo") && !hasUserInfoIntent) {
    return -0.25;
  }

  if (name.includes("relatedrecords") && !questionTerms.some((term) => RELATIONSHIP_TERMS.has(term))) {
    return -0.3;
  }

  return 0;
}

function buildSoqlQuery(question: string, userId: string): string | undefined {
  const terms = new Set(expandTerms(tokenize(question)));
  const ownerFilter = buildOwnerFilter(question, userId);
  const contextualAccountId = extractSalesforceIdByPrefix(question, "001");

  if (hasAny(terms, ["event", "meeting", "reunion", "calendar"])) {
    const personName = extractPersonName(question);
    const personFilter = personName
      ? `(Who.Name LIKE '%${escapeSoqlLiteral(personName)}%' OR Subject LIKE '%${escapeSoqlLiteral(personName)}%')`
      : undefined;
    return `SELECT Id, Subject, StartDateTime, EndDateTime, Location, WhoId, Who.Name FROM Event WHERE ${[
      ownerFilter,
      "StartDateTime >= TODAY",
      personFilter
    ].filter(Boolean).join(" AND ")} ORDER BY StartDateTime ASC LIMIT 10`;
  }

  if (hasAny(terms, ["task", "todo", "activity", "tarea", "actividad"])) {
    const dateFilter = inferTaskDateFilter(terms);
    return `SELECT Id, Subject, Status, ActivityDate, Priority, WhatId, WhoId FROM Task WHERE ${[
      ownerFilter,
      "Status != 'Completed'",
      dateFilter
    ].filter(Boolean).join(" AND ")} ORDER BY ActivityDate ASC LIMIT 10`;
  }

  if (hasAny(terms, ["opportunity", "pipeline", "oportunidad", "deal"])) {
    const statusFilter = hasAny(terms, ["closed", "cerrada", "cerradas", "cerrado", "cerrados"])
      ? "IsClosed = true"
      : "IsClosed = false";
    const dateFilter = inferOpportunityDateFilter(terms);
    const orderBy = hasAny(terms, ["largest", "biggest", "mayor", "mayores", "importe", "amount"])
      ? "Amount DESC NULLS LAST"
      : "CloseDate ASC";
    return `SELECT Id, Name, StageName, Amount, CloseDate, Account.Name FROM Opportunity WHERE ${[
      contextualAccountId ? `AccountId = '${contextualAccountId}'` : ownerFilter,
      statusFilter,
      dateFilter
    ].filter(Boolean).join(" AND ")} ORDER BY ${orderBy} LIMIT 10`;
  }

  if (hasAny(terms, ["contact", "contacto"])) {
    const contactFilter = contextualAccountId ? `AccountId = '${contextualAccountId}'` : ownerFilter;
    const where = contactFilter ? ` WHERE ${contactFilter}` : "";
    return `SELECT Id, Name, Email, Phone, Account.Name FROM Contact${where} ORDER BY LastModifiedDate DESC LIMIT 10`;
  }

  if (hasAny(terms, ["case", "ticket"]) && !hasAny(terms, ["success"])) {
    const caseFilter = contextualAccountId ? `AccountId = '${contextualAccountId}'` : ownerFilter;
    const where = caseFilter ? ` WHERE ${caseFilter}` : "";
    return `SELECT Id, CaseNumber, Subject, Status, Priority, Account.Name FROM Case${where} ORDER BY LastModifiedDate DESC LIMIT 10`;
  }

  if (hasAny(terms, ["account", "customer", "client", "cuenta", "cliente"])) {
    const where = ownerFilter ? ` WHERE ${ownerFilter}` : "";
    return `SELECT Id, Name, Type, Industry, Owner.Name, LastModifiedDate FROM Account${where} ORDER BY LastModifiedDate DESC LIMIT 10`;
  }

  return undefined;
}

function buildOwnerFilter(question: string, userId: string): string | undefined {
  if (!isSalesforceId(userId)) {
    return undefined;
  }

  const terms = new Set(tokenizeWithStopWords(question));
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
  if (hasAny(terms, ["event", "meeting", "reunion", "calendar"])) return "Event";
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

function extractPersonName(question: string): string | undefined {
  const match = question.match(/\bcon\s+([\p{L}][\p{L}'-]*(?:\s+[\p{L}][\p{L}'-]*){0,2})/iu);
  if (!match?.[1]) return undefined;
  return match[1]
    .replace(/\s+(hoy|mañana|manana|esta|este|el|la|a las).*$/iu, "")
    .trim() || undefined;
}

function escapeSoqlLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function extractSalesforceId(text: string): string | undefined {
  const ids = text.match(/\b[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?\b/g) ?? [];
  return ids.find((id) => !id.startsWith("005")) ?? ids[0];
}

function extractSalesforceIdByPrefix(text: string, prefix: string): string | undefined {
  const ids = text.match(/\b[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?\b/g) ?? [];
  return ids.find((id) => id.startsWith(prefix));
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
  const terms = new Set(expandTerms(tokenize(question)));

  if (hasTaskCompletionRequest(question)) return "complete_task";
  if (hasAny(terms, ["event", "meeting", "reunion", "calendar"])) return "list_pending_meetings";

  if (hasAny(terms, ["success", "exito"]) || (terms.has("ntt") && terms.has("data"))) {
    return "get_success_cases";
  }
  if (hasAny(terms, ["user", "usuario", "perfil", "profile", "manager", "role", "rol"])) {
    return "get_user_info";
  }
  if (hasAny(terms, ["opportunity", "pipeline", "oportunidad", "deal"])) {
    if (hasAny(terms, ["closed", "cerrada", "cerradas", "cerrado", "cerrados"])) return "list_closed_opportunities";
    if (hasAny(terms, ["largest", "biggest", "mayor", "mayores", "importe", "amount"])) return "rank_opportunities_by_amount";
    return "list_open_opportunities";
  }
  if (hasAny(terms, ["task", "todo", "activity", "tarea", "actividad"])) return "list_pending_tasks";
  if (hasAny(terms, ["contact", "contacto"])) return "list_contacts";
  if (hasAny(terms, ["account", "customer", "client", "cuenta", "cliente"])) return "list_accounts";
  if (hasAny(terms, ["case", "ticket", "caso"])) return "list_salesforce_cases";

  const firstTerms = [...terms].slice(0, 3);
  return safeIntent(firstTerms.join("_") || "detected_intent");
}

function hasTaskCompletionRequest(question: string): boolean {
  const normalized = question.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const hasTask = /\b(tarea|task|actividad)\b/.test(normalized);
  const hasCompletionAction = /\b(cierra|cerrar|completa|completar|finaliza|finalizar|termina|terminar|marca|marcar|done)\b/.test(normalized) ||
    /\b(da|dar)\s+por\s+(hecha|hecho|completada|completado|finalizada|finalizado)\b/.test(normalized);
  return hasTask && hasCompletionAction;
}

function buildVoiceFriendlyQuestion(fieldName: string, question: string): string {
  if (normalizeToken(fieldName) !== "userquestion") {
    return question;
  }

  return `Responde en español, de forma breve y apta para ser leída por Siri. Pregunta: ${question}`;
}

function inferTaskDateFilter(terms: Set<string>): string | undefined {
  if (hasAny(terms, ["today", "hoy"])) return "ActivityDate = TODAY";
  if (hasAny(terms, ["overdue", "vencida", "vencidas", "atrasada", "atrasadas"])) return "ActivityDate < TODAY";
  if (hasAny(terms, ["week", "semana"])) return "ActivityDate = THIS_WEEK";
  return undefined;
}

function inferOpportunityDateFilter(terms: Set<string>): string | undefined {
  if (hasAny(terms, ["today", "hoy"])) return "CloseDate = TODAY";
  if (hasAny(terms, ["month", "mes"])) return "CloseDate = THIS_MONTH";
  if (hasAny(terms, ["overdue", "vencida", "vencidas", "atrasada", "atrasadas"])) return "CloseDate < TODAY";
  return undefined;
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

function unresolvedReferenceSelection(): ToolSelection {
  return {
    intent: "ambiguous_reference",
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
  reunion: ["event", "meeting", "calendar"],
  reuniones: ["event", "events", "meeting", "meetings", "calendar"],
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
  cerrar: ["close", "update"],
  cierra: ["close", "update"],
  completar: ["complete", "update"],
  completa: ["complete", "update"],
  finalizar: ["complete", "update"],
  finaliza: ["complete", "update"],
  done: ["complete", "update"],
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
  "event",
  "events",
  "meeting",
  "meetings",
  "reunion",
  "reuniones",
  "calendar",
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

const SUCCESS_TERMS = new Set(["success", "successful", "exito", "exitos"]);
const USER_INFO_TERMS = new Set(["user", "usuario", "perfil", "profile", "manager", "role", "rol"]);
const RELATIONSHIP_TERMS = new Set(["related", "relationship", "relacion", "relacionados", "contacts", "opportunities", "cases"]);
const WRITE_TERMS = new Set([
  "create", "crear", "update", "actualizar", "modificar", "delete", "borrar", "eliminar", "change", "cambiar",
  "close", "cerrar", "cierra", "complete", "completar", "completa", "finalizar", "finaliza", "terminar", "termina", "done", "marcar", "marca"
]);
