import type { AppConfig } from "./config.js";
import type { JsonObject } from "./types.js";

interface ChatCompletionResponse {
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

export interface LlmUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export async function requestJsonCompletion(params: {
  config: AppConfig;
  systemPrompt: string;
  userPayload: JsonObject;
  maxTokens?: number;
}): Promise<{ value: JsonObject; usage?: LlmUsage }> {
  const { config, systemPrompt, userPayload, maxTokens = 256 } = params;
  const headers: Record<string, string> = {
    "content-type": "application/json"
  };

  if (config.llm.apiKey) {
    headers.authorization = `Bearer ${config.llm.apiKey}`;
  }

  const response = await fetch(`${config.llm.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(config.llm.timeoutMs),
    body: JSON.stringify({
      model: config.llm.model,
      temperature: 0,
      max_tokens: maxTokens,
      stream: false,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: config.llm.provider === "ollama" ? `/no_think\n${systemPrompt}` : systemPrompt
        },
        { role: "user", content: JSON.stringify(userPayload) }
      ]
    })
  });

  const payload = (await response.json().catch(() => ({}))) as ChatCompletionResponse;
  if (!response.ok) {
    throw new Error(payload.error?.message ?? `LLM request failed with status ${response.status}`);
  }

  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("LLM response did not include message content.");
  }

  const parsed = JSON.parse(extractJsonObject(content)) as unknown;
  if (!isJsonObject(parsed)) {
    throw new Error("LLM response was not a JSON object.");
  }

  const result: { value: JsonObject; usage?: LlmUsage } = { value: parsed };
  const usage = normalizeUsage(payload.usage);
  if (usage) {
    result.usage = usage;
  }
  return result;
}

function extractJsonObject(content: string): string {
  const withoutThinking = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fenced = withoutThinking.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = (fenced?.[1] ?? withoutThinking).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end < start) {
    throw new Error("LLM response did not contain a JSON object.");
  }
  return candidate.slice(start, end + 1);
}

function normalizeUsage(usage: ChatCompletionResponse["usage"]): LlmUsage | undefined {
  if (!usage) return undefined;
  const normalized: LlmUsage = {};
  if (typeof usage.prompt_tokens === "number") normalized.promptTokens = usage.prompt_tokens;
  if (typeof usage.completion_tokens === "number") normalized.completionTokens = usage.completion_tokens;
  if (typeof usage.total_tokens === "number") normalized.totalTokens = usage.total_tokens;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
