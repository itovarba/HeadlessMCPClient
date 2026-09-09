import type { ConversationContext, ConversationTurn, JsonObject, JsonValue } from "./types.js";

interface StoredConversation {
  expiresAt: number;
  turns: ConversationTurn[];
}

export class ConversationStore {
  private readonly conversations = new Map<string, StoredConversation>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxTurns: number,
    private readonly maxConversations: number
  ) {}

  get(userId: string, conversationId: string): ConversationContext {
    this.removeExpired();
    const key = conversationKey(userId, conversationId);
    const conversation = this.conversations.get(key);
    if (!conversation) {
      return { conversationId, turns: [] };
    }

    conversation.expiresAt = Date.now() + this.ttlMs;
    this.conversations.delete(key);
    this.conversations.set(key, conversation);
    return {
      conversationId,
      turns: conversation.turns.map(cloneTurn)
    };
  }

  addTurn(userId: string, conversationId: string, turn: ConversationTurn): void {
    this.removeExpired();
    const key = conversationKey(userId, conversationId);
    const existing = this.conversations.get(key)?.turns ?? [];
    const turns = [...existing, compactTurn(turn)].slice(-this.maxTurns);
    this.conversations.delete(key);
    while (this.conversations.size >= this.maxConversations) {
      const oldestKey = this.conversations.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.conversations.delete(oldestKey);
    }
    this.conversations.set(key, {
      expiresAt: Date.now() + this.ttlMs,
      turns
    });
  }

  clear(userId: string, conversationId: string): boolean {
    return this.conversations.delete(conversationKey(userId, conversationId));
  }

  clearUser(userId: string): number {
    const prefix = `${userId}\u0000`;
    let cleared = 0;
    for (const key of this.conversations.keys()) {
      if (key.startsWith(prefix) && this.conversations.delete(key)) {
        cleared += 1;
      }
    }
    return cleared;
  }

  private removeExpired(): void {
    const now = Date.now();
    for (const [key, conversation] of this.conversations) {
      if (conversation.expiresAt <= now) {
        this.conversations.delete(key);
      }
    }
  }
}

export function normalizeConversationId(value: string | undefined): string {
  const normalized = value?.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  return normalized || "default";
}

function conversationKey(userId: string, conversationId: string): string {
  return `${userId}\u0000${conversationId}`;
}

function compactTurn(turn: ConversationTurn): ConversationTurn {
  return {
    ...turn,
    question: turn.question.slice(0, 500),
    answer: turn.answer.slice(0, 500),
    toolInput: compactObject(turn.toolInput, 3_000),
    result: compactValue(turn.result, 6_000)
  };
}

function compactObject(value: JsonObject, maxLength: number): JsonObject {
  const compacted = compactValue(value, maxLength);
  return isJsonObject(compacted) ? compacted : { preview: compacted };
}

function compactValue(value: JsonValue, maxLength: number): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized.length <= maxLength) {
    return structuredClone(value);
  }
  return {
    truncated: true,
    preview: serialized.slice(0, maxLength)
  };
}

function cloneTurn(turn: ConversationTurn): ConversationTurn {
  return structuredClone(turn);
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
