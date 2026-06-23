import dotenv from "dotenv";

dotenv.config();

export type SalesforceAuthType = "oauth";
export type LlmProvider = "openai" | "none";

export interface AppConfig {
  port: number;
  sessionSecret: string;
  salesforce: {
    mcpServerUrl: string;
    authType: SalesforceAuthType;
    clientId?: string;
    clientSecret?: string;
    accessToken?: string;
    tokenUrl?: string;
    authorizationUrl: string;
    oauthRedirectUri: string;
    oauthScopes: string;
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
  const authorizationUrl = readOptional("SALESFORCE_AUTHORIZATION_URL") ?? deriveAuthorizationUrl(tokenUrl);
  assertUrl(authorizationUrl, "SALESFORCE_AUTHORIZATION_URL");

  const accessToken = readOptional("SALESFORCE_ACCESS_TOKEN");
  const clientId = readOptional("SALESFORCE_CLIENT_ID");
  const clientSecret = readOptional("SALESFORCE_CLIENT_SECRET");
  const oauthRedirectUri = readRequired("SALESFORCE_OAUTH_REDIRECT_URI");
  assertUrl(oauthRedirectUri, "SALESFORCE_OAUTH_REDIRECT_URI");

  if (!accessToken && !clientId) {
    throw new Error(
      "Salesforce OAuth requires SALESFORCE_ACCESS_TOKEN or SALESFORCE_CLIENT_ID for app-managed authorization code flow with PKCE."
    );
  }

  const salesforceConfig: AppConfig["salesforce"] = {
    mcpServerUrl,
    authType: readAuthType(),
    tokenUrl,
    authorizationUrl,
    oauthRedirectUri,
    oauthScopes: readOptional("SALESFORCE_OAUTH_SCOPES") ?? "refresh_token mcp_api"
  };

  if (clientId) {
    salesforceConfig.clientId = clientId;
  }

  if (clientSecret) {
    salesforceConfig.clientSecret = clientSecret;
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
    sessionSecret: readRequired("SESSION_SECRET"),
    salesforce: salesforceConfig,
    defaultUserId: readOptional("DEFAULT_USER_ID") ?? "iosu.demo",
    llm: llmConfig,
    enableDeterministicFallback: readBoolean("ENABLE_DETERMINISTIC_FALLBACK", true)
  };
}

function deriveAuthorizationUrl(tokenUrl: string): string {
  const parsed = new URL(tokenUrl);
  parsed.pathname = "/services/oauth2/authorize";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

export const config = buildConfig();
