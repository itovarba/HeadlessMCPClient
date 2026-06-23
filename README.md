# Local Salesforce MCP Proxy

Local Headless 360 MCP proxy for a configurable Salesforce Hosted MCP Server. The service receives a natural-language request, discovers MCP tools dynamically, selects the best tool using the live MCP context, executes it, and returns concise JSON for local clients or test tooling.

It does not hardcode Salesforce tool names or business capabilities. Tool selection uses `listTools()`, tool names, descriptions, input schemas, and available output.

## Requirements

- Node.js 26.3 or newer
- npm
- Salesforce Hosted MCP Server URL
- Salesforce Connected App or External Client App with OAuth enabled

## Installation

```bash
npm install
cp .env.example .env
```

Edit `.env`:

```bash
PORT=3000
SESSION_SECRET=replace-with-a-long-random-string
SALESFORCE_MCP_SERVER_URL=https://your-domain.my.salesforce.com/services/mcp
SALESFORCE_AUTH_TYPE=oauth
SALESFORCE_CLIENT_ID=
SALESFORCE_CLIENT_SECRET=
SALESFORCE_TOKEN_URL=https://login.salesforce.com/services/oauth2/token
SALESFORCE_AUTHORIZATION_URL=https://login.salesforce.com/services/oauth2/authorize
SALESFORCE_OAUTH_REDIRECT_URI=http://localhost:3000/auth/callback
SALESFORCE_OAUTH_SCOPES=refresh_token mcp_api
SALESFORCE_ACCESS_TOKEN=
DEFAULT_USER_ID=user.demo

LLM_PROVIDER=openai
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1-mini

ENABLE_DETERMINISTIC_FALLBACK=true
```

The app fails fast if mandatory Salesforce MCP, session, or OAuth variables are missing. In normal use, do not paste a refresh token into `.env`. The app obtains the authorization code, access token, and refresh token through OAuth, then keeps the token session in server memory for the configured `userId`.

`SALESFORCE_TOKEN_URL` can point to `login.salesforce.com`, `test.salesforce.com`, or a custom Salesforce domain.

`SALESFORCE_ACCESS_TOKEN` is only a development bypass. If it is set, the app uses it directly and skips the login flow. Leave it empty for app-managed OAuth.

## Salesforce Setup Guide

This proxy needs two Salesforce-side pieces:

- A Salesforce Hosted MCP Server that exposes tools.
- An External Client App that can issue tokens accepted by hosted MCP servers.

Salesforce setup labels can vary by release and org feature set. The important output is always the same: a hosted MCP server URL and an OAuth client ID authorized for `mcp_api`.

### 1. Create or Configure a Hosted MCP Server

In Salesforce Setup, open the area for Agentforce, Einstein, or Model Context Protocol configuration and create a hosted MCP server.

Recommended setup:

1. Create a hosted/custom MCP server.
2. Give it a stable API-style name, for example `MCPServerLab`.
3. Add only the tools you want this proxy to expose. Typical tools include:
   - SOQL/read tools, such as querying records.
   - User context tools, such as current user info.
   - Flow actions, such as a Flow that searches Enterprise Knowledge.
   - Create/update tools only if this proxy should perform write actions.
4. Publish or activate the MCP server.
5. Copy the server URL. It usually looks similar to:

```text
https://api.salesforce.com/platform/mcp/v1/custom/MCPServerLab
```

Set it in `.env`:

```env
SALESFORCE_MCP_SERVER_URL=https://api.salesforce.com/platform/mcp/v1/custom/MCPServerLab
```

Validation target:

```bash
curl "http://localhost:3000/mcp/tools?userId=user.demo"
```

If the proxy is authenticated correctly, this endpoint returns the tools discovered from Salesforce. The proxy never hardcodes tool names; it uses `tools/list` dynamically.

### 2. Create the External Client App

In Salesforce Setup, create an External Client App for this proxy.

Use these OAuth settings, matching the configuration proven with the Copilot Studio external app:

```text
Callback URL:
http://localhost:3000/auth/callback

Selected OAuth Scopes:
- Perform requests at any time (refresh_token, offline_access)
- Access Salesforce hosted MCP servers (mcp_api)

Flow Enablement:
- Authorization Code flow with PKCE

Security:
- Require Proof Key for Code Exchange (PKCE)
- Issue JSON Web Token (JWT)-based access tokens for named users
- Require secret for Web Server Flow: disabled
- Require secret for Refresh Token Flow: disabled
- Enable Refresh Token Rotation: optional; disabled is simplest for local testing
```

Do not confuse **JWT-based access tokens for named users** with the **OAuth JWT Bearer Flow**. This proxy uses Authorization Code with PKCE; Salesforce issues the access token format accepted by hosted MCP servers when that named-user JWT access token setting is enabled.

For ngrok or a remote demo URL, the callback URL must match exactly in both Salesforce and `.env`:

```text
https://your-ngrok-domain.ngrok-free.app/auth/callback
```

After saving the app, copy the consumer key or client ID. If your External Client App does not require a secret, leave `SALESFORCE_CLIENT_SECRET` empty.

```env
SALESFORCE_AUTH_TYPE=oauth
SALESFORCE_CLIENT_ID=your_consumer_key
SALESFORCE_CLIENT_SECRET=
SALESFORCE_OAUTH_REDIRECT_URI=http://localhost:3000/auth/callback
SALESFORCE_OAUTH_SCOPES=refresh_token mcp_api
```

Make sure the Salesforce user who logs in is allowed to use the External Client App and has access to the MCP server, Flow actions, objects, and fields exposed by the MCP tools.

### 3. Configure Token URLs

Use production login unless you are targeting a sandbox or custom domain:

```env
SALESFORCE_TOKEN_URL=https://login.salesforce.com/services/oauth2/token
SALESFORCE_AUTHORIZATION_URL=https://login.salesforce.com/services/oauth2/authorize
```

For sandbox:

```env
SALESFORCE_TOKEN_URL=https://test.salesforce.com/services/oauth2/token
SALESFORCE_AUTHORIZATION_URL=https://test.salesforce.com/services/oauth2/authorize
```

For a custom domain:

```env
SALESFORCE_TOKEN_URL=https://your-domain.my.salesforce.com/services/oauth2/token
SALESFORCE_AUTHORIZATION_URL=https://your-domain.my.salesforce.com/services/oauth2/authorize
```

### 4. First Login and Validation

Start the proxy:

```bash
npm run dev
```

Open the lab:

```text
http://localhost:3000/
```

Click **Login Salesforce**, or open:

```text
http://localhost:3000/auth/login?userId=user.demo
```

Salesforce redirects back to `/auth/callback`. The app exchanges the code for tokens and stores them in the server session store. Tokens are never logged and are not written to `.env`.

Check auth status:

```bash
curl "http://localhost:3000/auth/status?userId=user.demo"
```

Expected:

```json
{
  "authenticated": true,
  "mode": "oauth_session",
  "scope": "refresh_token mcp_api"
}
```

The scope order can vary. The important part is that `mcp_api` is present.

Then discover tools:

```bash
curl "http://localhost:3000/mcp/tools?userId=user.demo"
```

Log out and clear the in-memory token session:

```bash
curl -X POST http://localhost:3000/auth/logout \
  -H "Content-Type: application/json" \
  -d '{"userId":"user.demo"}'
```

This implementation uses in-memory token storage. Restarting the Node process clears the session and requires login again. For production, replace it with an encrypted database, OS keychain, or secret manager.

## Running Locally

```bash
npm run dev
```

Build and start:

```bash
npm run build
npm start
```

Health check:

```bash
curl http://localhost:3000/health
```

Browser test UI:

```text
http://localhost:3000/
```

The UI includes OAuth status, a `userId` field, a text box for test questions, a button to call `/ask`, and a button to discover the current MCP tools.

Ask endpoint:

```bash
curl -X POST http://localhost:3000/ask -H "Content-Type: application/json" -d '{"userId":"user.demo","question":"¿Qué clientes debo priorizar hoy?"}'
```

Discover MCP tools:

```bash
curl "http://localhost:3000/mcp/tools?userId=user.demo"
```

Response shape:

```json
{
  "answer": "Respuesta corta generada a partir del resultado MCP",
  "intent": "detected_intent",
  "tool": "selected_mcp_tool_name",
  "raw": {}
}
```

If `/ask` is called before login, the response has `intent: "auth_required"` and includes a local `authUrl` in `raw`.

## Connectivity Options

- Same Wi-Fi: use your Mac local IP, for example `http://192.168.1.50:3000/ask`.
- ngrok: useful for controlled demos when the iPhone is outside the same network.
- Tailscale: good for private device-to-device connectivity without exposing the endpoint publicly.

## How Tool Selection Works

`POST /ask` performs this flow:

1. Reads `question` and `userId`.
2. Gets a Salesforce access token from the app-managed OAuth session, refreshing it when needed.
3. Connects to the Salesforce Hosted MCP Server.
4. Calls `listTools()`.
5. Builds a selection prompt from the user question, user id, current date, and available MCP tools.
6. Selects exactly one MCP tool and builds minimal valid JSON input.
7. Verifies that the selected tool exists in the MCP tool list.
8. Calls the MCP tool with JSON input.
9. Formats the tool output into a short Spanish answer.

If `LLM_PROVIDER=openai` and `OPENAI_API_KEY` is configured, the service uses OpenAI for tool selection with strict JSON output. If OpenAI is not configured or fails, the deterministic fallback scores available tools by matching question terms against tool names, descriptions, and input schema fields. The fallback still uses the MCP server context dynamically and returns `unsupported` if confidence is low.

## MCP Transport Notes

`src/mcpClient.ts` implements a reusable Salesforce MCP wrapper with:

- `connect()`
- `listTools()`
- `callTool(toolName, payload)`

It assumes a Salesforce Hosted MCP Streamable HTTP style endpoint using JSON-RPC methods:

- `initialize`
- `notifications/initialized`
- `tools/list`
- `tools/call`

It sends the Salesforce bearer token on every request and preserves the `mcp-session-id` header when returned by the server. If your Salesforce Hosted MCP transport requires a different URL shape, header, session behavior, or response format, adjust only `src/mcpClient.ts`.

## Logging

The service emits structured JSON logs for:

- Incoming question
- Number of MCP tools discovered
- Selected intent
- Selected tool
- Sanitized execution result
- Errors

Tokens, refresh tokens, client secrets, passwords, and API keys are redacted from logs.

## Security Notes

- Do not expose the local endpoint publicly without authentication.
- Use ngrok only for controlled demos.
- Never commit `.env`.
- Do not paste refresh tokens into `.env`; let the app obtain them through OAuth.
- Use HTTPS in real environments.
- Use least-privilege Salesforce credentials.
- Avoid returning sensitive customer information in proxy responses.

## Troubleshooting

- `Missing mandatory environment variable`: check `.env` and make sure the Salesforce MCP URL and OAuth configuration are present.
- `auth_required`: open `/auth/login?userId=user.demo` in a browser and complete Salesforce login.
- `Invalid or expired Salesforce OAuth state`: restart login from `/auth/login`; OAuth state expires after 10 minutes.
- `missing required code challenge`: use the latest code in this project and restart the Node process. The OAuth flow sends PKCE parameters automatically.
- `Salesforce OAuth refresh failed`: verify connected app settings, OAuth scopes, client id, client secret, and token URL.
- `MCP HTTP request failed`: verify `SALESFORCE_MCP_SERVER_URL`, network access, bearer token scope, and Salesforce Hosted MCP availability.
- `Invalid token`: confirm the token status includes `mcp_api`, the External Client App has **Issue JSON Web Token (JWT)-based access tokens for named users** enabled, and the MCP server URL is the one copied from Salesforce.
- `MCP tools/list response did not include a tools array`: the server may use a different transport shape. Review `src/mcpClient.ts`.
- Client cannot reach the proxy: confirm it can access the Mac local IP, disable blocking firewall rules, or use ngrok/Tailscale for controlled demos.

## References

- Salesforce OAuth Web Server Flow: https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_web_server_flow.htm&type=5
- Salesforce OAuth Refresh Token Flow: https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_refresh_token_flow.htm&type=5
- Salesforce OAuth JWT Bearer Flow, for comparison only: https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_jwt_flow.htm&type=5
