import dotenv from "dotenv";

dotenv.config();

export type SalesforceAuthType = "oauth";
export type LlmProvider = "openai" | "none";

export interface AppConfig {
  port: number;
  salesforce: {
    mcpServerUrl: string;
    authType: SalesforceAuthType;
    clientId?: string;
    clientSecret?: string;
    refreshToken?: string;
    accessToken?: string;
    tokenUrl?: string;
  };
  defaultUserId: string;
  llm: {
    provider: LlmProvider;
    openaiApiKey?: string;
    openaiModel: string;
  };
  enableDeterministicFallback: boolean;
}

function readOptional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function readRequired(name: string): string {
  const value = readOptional(name);
  if (!value) {
    throw new Error(`Missing mandatory environment variable: ${name}`);
  }
  return value;
}

function readPort(): number {
  const raw = readOptional("PORT") ?? "3000";
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("PORT must be a valid TCP port number.");
  }
  return port;
}

function readBoolean(name: string, defaultValue: boolean): boolean {
  const raw = readOptional(name);
  if (!raw) {
    return defaultValue;
  }
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function assertUrl(value: string, name: string): void {
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Unsupported protocol");
    }
  } catch {
    throw new Error(`${name} must be a valid HTTP(S) URL.`);
  }
}

function readLlmProvider(): LlmProvider {
  const provider = (readOptional("LLM_PROVIDER") ?? "openai").toLowerCase();
  if (provider === "openai" || provider === "none") {
    return provider;
  }
  throw new Error("LLM_PROVIDER must be either openai or none.");
}

function readAuthType(): SalesforceAuthType {
  const authType = (readOptional("SALESFORCE_AUTH_TYPE") ?? "oauth").toLowerCase();
  if (authType === "oauth") {
    return authType;
  }
  throw new Error("SALESFORCE_AUTH_TYPE must be oauth.");
}

function buildConfig(): AppConfig {
  const mcpServerUrl = readRequired("SALESFORCE_MCP_SERVER_URL");
  assertUrl(mcpServerUrl, "SALESFORCE_MCP_SERVER_URL");

  const tokenUrl = readOptional("SALESFORCE_TOKEN_URL") ?? "https://login.salesforce.com/services/oauth2/token";
  assertUrl(tokenUrl, "SALESFORCE_TOKEN_URL");

  const accessToken = readOptional("SALESFORCE_ACCESS_TOKEN");
  const refreshToken = readOptional("SALESFORCE_REFRESH_TOKEN");
  const clientId = readOptional("SALESFORCE_CLIENT_ID");
  const clientSecret = readOptional("SALESFORCE_CLIENT_SECRET");

  if (!accessToken && !(refreshToken && clientId && clientSecret)) {
    throw new Error(
      "Salesforce OAuth requires SALESFORCE_ACCESS_TOKEN or SALESFORCE_CLIENT_ID, SALESFORCE_CLIENT_SECRET and SALESFORCE_REFRESH_TOKEN."
    );
  }

  const salesforceConfig: AppConfig["salesforce"] = {
    mcpServerUrl,
    authType: readAuthType(),
    tokenUrl
  };

  if (clientId) {
    salesforceConfig.clientId = clientId;
  }

  if (clientSecret) {
    salesforceConfig.clientSecret = clientSecret;
  }

  if (refreshToken) {
    salesforceConfig.refreshToken = refreshToken;
  }

  if (accessToken) {
    salesforceConfig.accessToken = accessToken;
  }

  const llmConfig: AppConfig["llm"] = {
    provider: readLlmProvider(),
    openaiModel: readOptional("OPENAI_MODEL") ?? "gpt-4.1-mini"
  };

  const openaiApiKey = readOptional("OPENAI_API_KEY");
  if (openaiApiKey) {
    llmConfig.openaiApiKey = openaiApiKey;
  }

  return {
    port: readPort(),
    salesforce: salesforceConfig,
    defaultUserId: readOptional("DEFAULT_USER_ID") ?? "iosu.demo",
    llm: llmConfig,
    enableDeterministicFallback: readBoolean("ENABLE_DETERMINISTIC_FALLBACK", true)
  };
}

export const config = buildConfig();
