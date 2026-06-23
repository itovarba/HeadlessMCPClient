import type { AppConfig } from "./config.js";
import type { Session, SessionData } from "express-session";
import type { JsonObject, SalesforceOAuthSession } from "./types.js";
import crypto from "node:crypto";

interface SalesforceTokenResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  issued_at?: string;
  instance_url?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

type RequestSession = Session & Partial<SessionData>;

interface StoredOAuthState {
  userId: string;
  codeVerifier: string;
  expiresAt: number;
}

export class AuthRequiredError extends Error {
  constructor(message = "Salesforce OAuth login is required.") {
    super(message);
    this.name = "AuthRequiredError";
  }
}

const userTokenStore = new Map<string, SalesforceOAuthSession>();
const oauthStates = new Map<string, StoredOAuthState>();

export async function getSalesforceAccessToken(params: {
  appConfig: AppConfig;
  userId: string;
  session?: RequestSession;
}): Promise<string> {
  const { appConfig, userId, session } = params;
  const staticAccessToken = appConfig.salesforce.accessToken;
  if (staticAccessToken) {
    return staticAccessToken;
  }

  const sessionToken = session?.salesforceOAuth;
  if (sessionToken) {
    const refreshed = await ensureFreshToken(appConfig, sessionToken);
    session.salesforceOAuth = refreshed;
    userTokenStore.set(userId, refreshed);
    return refreshed.accessToken;
  }

  const storedToken = userTokenStore.get(userId);
  if (storedToken) {
    const refreshed = await ensureFreshToken(appConfig, storedToken);
    userTokenStore.set(userId, refreshed);
    return refreshed.accessToken;
  }

  throw new AuthRequiredError();
}

export function createSalesforceAuthorizationUrl(params: {
  appConfig: AppConfig;
  userId: string;
  session?: RequestSession;
}): string {
  const { appConfig, userId, session } = params;
  const { clientId, authorizationUrl, oauthRedirectUri, oauthScopes } = appConfig.salesforce;
  if (!clientId) {
    throw new Error("SALESFORCE_CLIENT_ID is required for OAuth login.");
  }

  const state = crypto.randomUUID();
  const codeVerifier = createPkceCodeVerifier();
  const codeChallenge = createPkceCodeChallenge(codeVerifier);
  const expiresAt = Date.now() + 10 * 60 * 1000;
  oauthStates.set(state, { userId, codeVerifier, expiresAt });

  if (session) {
    session.oauthLoginState = {
      state,
      userId,
      codeVerifier,
      expiresAt
    };
  }

  const url = new URL(authorizationUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", oauthRedirectUri);
  url.searchParams.set("scope", oauthScopes);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");

  return url.toString();
}

export async function handleSalesforceOAuthCallback(params: {
  appConfig: AppConfig;
  code: string;
  state: string;
  session?: RequestSession;
}): Promise<{ userId: string; expiresAt: number; instanceUrl?: string }> {
  const { appConfig, code, state, session } = params;
  const oauthState = consumeOAuthState(state, session);
  const token = await exchangeAuthorizationCode(appConfig, code, oauthState.codeVerifier);

  userTokenStore.set(oauthState.userId, token);
  if (session) {
    session.userId = oauthState.userId;
    session.salesforceOAuth = token;
    delete session.oauthLoginState;
  }

  const result: { userId: string; expiresAt: number; instanceUrl?: string } = {
    userId: oauthState.userId,
    expiresAt: token.expiresAt
  };
  if (token.instanceUrl) {
    result.instanceUrl = token.instanceUrl;
  }
  return result;
}

export function getSalesforceAuthStatus(params: {
  appConfig: AppConfig;
  userId: string;
  session?: RequestSession;
}): JsonObject {
  const { appConfig, userId, session } = params;
  if (appConfig.salesforce.accessToken) {
    return {
      authenticated: true,
      mode: "static_access_token"
    };
  }

  const token = session?.salesforceOAuth ?? userTokenStore.get(userId);
  if (!token) {
    return {
      authenticated: false,
      mode: "oauth_session"
    };
  }

  return {
    authenticated: true,
    mode: "oauth_session",
    userId,
    expiresAt: new Date(token.expiresAt).toISOString(),
    hasRefreshToken: Boolean(token.refreshToken),
    instanceUrl: token.instanceUrl ?? "",
    scope: token.scope ?? ""
  };
}

export function clearSalesforceOAuth(params: { userId: string; session?: RequestSession }): void {
  const { userId, session } = params;
  userTokenStore.delete(userId);
  if (session) {
    delete session.salesforceOAuth;
    delete session.oauthLoginState;
    delete session.userId;
  }
}

async function ensureFreshToken(
  appConfig: AppConfig,
  token: SalesforceOAuthSession
): Promise<SalesforceOAuthSession> {
  if (token.expiresAt > Date.now() + 60_000) {
    return token;
  }

  if (!token.refreshToken) {
    throw new AuthRequiredError("Salesforce access token expired and no refresh token is available.");
  }

  const refreshed = await refreshAccessToken(appConfig, token.refreshToken);
  return {
    ...token,
    ...refreshed,
    refreshToken: refreshed.refreshToken ?? token.refreshToken
  };
}

function consumeOAuthState(state: string, session?: RequestSession): StoredOAuthState {
  const sessionState = session?.oauthLoginState;
  const storedState = oauthStates.get(state);

  if (sessionState?.state === state && sessionState.expiresAt > Date.now()) {
    oauthStates.delete(state);
    return {
      userId: sessionState.userId,
      codeVerifier: sessionState.codeVerifier,
      expiresAt: sessionState.expiresAt
    };
  }

  if (storedState && storedState.expiresAt > Date.now()) {
    oauthStates.delete(state);
    return storedState;
  }

  oauthStates.delete(state);
  throw new Error("Invalid or expired Salesforce OAuth state.");
}

async function exchangeAuthorizationCode(
  appConfig: AppConfig,
  code: string,
  codeVerifier: string
): Promise<SalesforceOAuthSession> {
  const { clientId, clientSecret, tokenUrl, oauthRedirectUri } = appConfig.salesforce;
  if (!clientId || !tokenUrl) {
    throw new Error("Salesforce authorization code flow is not fully configured.");
  }

  const params: Record<string, string> = {
    grant_type: "authorization_code",
    client_id: clientId,
    redirect_uri: oauthRedirectUri,
    code_verifier: codeVerifier,
    code
  };

  if (clientSecret) {
    params.client_secret = clientSecret;
  }

  return requestToken(appConfig, params);
}

async function refreshAccessToken(appConfig: AppConfig, refreshToken: string): Promise<SalesforceOAuthSession> {
  const { clientId, clientSecret } = appConfig.salesforce;
  if (!clientId) {
    throw new Error("Salesforce refresh flow is not fully configured.");
  }

  const params: Record<string, string> = {
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken
  };

  if (clientSecret) {
    params.client_secret = clientSecret;
  }

  return requestToken(appConfig, params);
}

async function requestToken(
  appConfig: AppConfig,
  params: Record<string, string>
): Promise<SalesforceOAuthSession> {
  const { tokenUrl } = appConfig.salesforce;
  if (!tokenUrl) {
    throw new Error("SALESFORCE_TOKEN_URL is required.");
  }

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(params)
  });

  const payload = (await response.json().catch(() => ({}))) as SalesforceTokenResponse;

  if (!response.ok || !payload.access_token) {
    const description = payload.error_description || payload.error || response.statusText;
    throw new Error(`Salesforce OAuth token request failed: ${description}`);
  }

  const token: SalesforceOAuthSession = {
    accessToken: payload.access_token,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000
  };
  if (payload.refresh_token) {
    token.refreshToken = payload.refresh_token;
  }
  if (payload.instance_url) {
    token.instanceUrl = payload.instance_url;
  }
  if (payload.issued_at) {
    token.issuedAt = payload.issued_at;
  }
  if (payload.token_type) {
    token.tokenType = payload.token_type;
  }
  if (payload.scope) {
    token.scope = payload.scope;
  }
  return token;
}

function createPkceCodeVerifier(): string {
  return base64UrlEncode(crypto.randomBytes(64));
}

function createPkceCodeChallenge(codeVerifier: string): string {
  return base64UrlEncode(crypto.createHash("sha256").update(codeVerifier).digest());
}

function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}
