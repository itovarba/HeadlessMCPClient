export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface AskRequest {
  userId?: string;
  question?: string;
}

export interface AskResponse {
  answer: string;
  intent: string;
  tool: string | null;
  raw: JsonValue;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: JsonObject;
  outputSchema?: JsonObject;
  annotations?: JsonObject;
}

export interface ToolSelection {
  intent: string;
  toolName: string | null;
  toolInput: JsonObject;
}

export interface SalesforceOAuthSession {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  salesforceUserId?: string;
  instanceUrl?: string;
  identityUrl?: string;
  issuedAt?: string;
  tokenType?: string;
  scope?: string;
}

export interface OAuthLoginState {
  state: string;
  userId: string;
  codeVerifier: string;
  expiresAt: number;
}

export interface Logger {
  info(message: string, meta?: JsonObject): void;
  warn(message: string, meta?: JsonObject): void;
  error(message: string, meta?: JsonObject): void;
}

declare module "express-session" {
  interface SessionData {
    salesforceOAuth?: SalesforceOAuthSession;
    oauthLoginState?: OAuthLoginState;
    userId?: string;
  }
}
