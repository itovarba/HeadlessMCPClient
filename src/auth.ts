import type { AppConfig } from "./config.js";

interface SalesforceTokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  issued_at?: string;
  instance_url?: string;
  error?: string;
  error_description?: string;
}

let cachedAccessToken: string | undefined;
let cachedAccessTokenExpiresAt = 0;

export async function getSalesforceAccessToken(appConfig: AppConfig): Promise<string> {
  const staticAccessToken = appConfig.salesforce.accessToken;
  if (staticAccessToken) {
    return staticAccessToken;
  }

  const now = Date.now();
  if (cachedAccessToken && cachedAccessTokenExpiresAt > now + 60_000) {
    return cachedAccessToken;
  }

  const { clientId, clientSecret, refreshToken, tokenUrl } = appConfig.salesforce;
  if (!clientId || !clientSecret || !refreshToken || !tokenUrl) {
    throw new Error("Salesforce refresh token OAuth is not fully configured.");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body
  });

  const payload = (await response.json().catch(() => ({}))) as SalesforceTokenResponse;

  if (!response.ok || !payload.access_token) {
    const description = payload.error_description || payload.error || response.statusText;
    throw new Error(`Salesforce OAuth refresh failed: ${description}`);
  }

  cachedAccessToken = payload.access_token;
  cachedAccessTokenExpiresAt = Date.now() + (payload.expires_in ?? 3600) * 1000;

  return cachedAccessToken;
}
