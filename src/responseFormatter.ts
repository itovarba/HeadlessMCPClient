import type { JsonObject, JsonValue } from "./types.js";

export const UNSUPPORTED_SPEECH =
  "No he entendido la petición. Puedes pedirme que consulte información disponible en Salesforce o que ejecute una acción habilitada por el MCP Server.";

export const ERROR_SPEECH =
  "Ha ocurrido un error consultando el asistente comercial. Revisa la conexión con Salesforce.";

export function formatMcpResponse(raw: JsonValue): string {
  const naturalLanguageAnswer = findNaturalLanguageAnswer(raw);
  if (naturalLanguageAnswer) {
    return shortenSpeech(naturalLanguageAnswer);
  }

  if (typeof raw === "string") {
    return shortenSpeech(raw);
  }

  if (Array.isArray(raw)) {
    return summarizeArray(raw);
  }

  if (isJsonObject(raw)) {
    return summarizeObject(raw);
  }

  if (raw === null) {
    return "No he encontrado resultados relevantes.";
  }

  return shortenSpeech(String(raw));
}

function findNaturalLanguageAnswer(value: JsonValue): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const answer = findNaturalLanguageAnswer(item);
      if (answer) {
        return answer;
      }
    }
    return undefined;
  }

  if (!isJsonObject(value)) {
    return undefined;
  }

  const preferredKeys = ["speech", "answer", "summary", "message", "text", "response", "result"];
  for (const key of preferredKeys) {
    const item = value[key];
    if (typeof item === "string" && item.trim()) {
      return item;
    }
  }

  return undefined;
}

function summarizeArray(items: JsonValue[]): string {
  if (items.length === 0) {
    return "No he encontrado resultados relevantes.";
  }

  const firstItems = items.slice(0, 3);
  const summaries = firstItems.map((item) => summarizeBriefItem(item)).filter(Boolean);
  if (summaries.length === 0) {
    return `He encontrado ${items.length} resultado${items.length === 1 ? "" : "s"}.`;
  }

  const prefix = items.length === 1 ? "He encontrado" : `He encontrado ${items.length} resultados. Los principales son`;
  return shortenSpeech(`${prefix}: ${summaries.join("; ")}.`);
}

function summarizeObject(object: JsonObject): string {
  if (looksLikeMutationResult(object)) {
    return "He completado la acción en Salesforce.";
  }

  const entries = Object.entries(object).filter(([, value]) => isSpeakablePrimitive(value)).slice(0, 4);
  if (entries.length === 0) {
    return "He recibido la respuesta de Salesforce, pero no hay un resumen claro para leer.";
  }

  const summary = entries.map(([key, value]) => `${humanizeKey(key)}: ${String(value)}`).join("; ");
  return shortenSpeech(summary);
}

function summarizeBriefItem(item: JsonValue): string {
  if (typeof item === "string") {
    return item;
  }

  if (!isJsonObject(item)) {
    return String(item);
  }

  const preferredKeys = ["name", "nombre", "accountName", "cliente", "title", "subject", "stage", "status", "amount"];
  const selected = preferredKeys
    .filter((key) => item[key] !== undefined && isSpeakablePrimitive(item[key]))
    .slice(0, 3)
    .map((key) => String(item[key]));

  if (selected.length > 0) {
    return selected.join(", ");
  }

  return Object.entries(item)
    .filter(([, value]) => isSpeakablePrimitive(value))
    .slice(0, 2)
    .map(([key, value]) => `${humanizeKey(key)} ${String(value)}`)
    .join(", ");
}

function looksLikeMutationResult(object: JsonObject): boolean {
  const keys = Object.keys(object).map((key) => key.toLowerCase());
  return keys.some((key) =>
    ["created", "updated", "success", "id", "recordid", "record_id"].some((candidate) => key.includes(candidate))
  );
}

function isSpeakablePrimitive(value: JsonValue | undefined): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function humanizeKey(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
}

function shortenSpeech(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= 320) {
    return clean;
  }

  const sentenceCut = clean.slice(0, 320).replace(/[,;:]\s+\S*$/, "");
  return `${sentenceCut.trim()}.`;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
