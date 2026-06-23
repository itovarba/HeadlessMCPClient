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
DEFAULT_USER_ID=iosu.demo

LLM_PROVIDER=openai
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1-mini

ENABLE_DETERMINISTIC_FALLBACK=true
```

The app fails fast if mandatory Salesforce MCP, session, or OAuth variables are missing. In normal use, do not paste a refresh token into `.env`. The app obtains the authorization code, access token, and refresh token through OAuth, then keeps the token session in server memory for the configured `userId`.

`SALESFORCE_TOKEN_URL` can point to `login.salesforce.com`, `test.salesforce.com`, or a custom Salesforce domain.

`SALESFORCE_ACCESS_TOKEN` is only a development bypass. If it is set, the app uses it directly and skips the login flow. Leave it empty for app-managed OAuth.

## Salesforce OAuth Setup

Create a Salesforce Connected App or External Client App with OAuth enabled.

The app supports OAuth Authorization Code Flow with PKCE. If Salesforce requires PKCE, keep that setting enabled; `/auth/login` sends a `code_challenge` with method `S256`, and `/auth/callback` sends the matching `code_verifier`.

OAuth settings matching the Copilot Studio external app:

```text
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
```

In `.env`, this maps to:

```env
SALESFORCE_OAUTH_SCOPES=refresh_token mcp_api
SALESFORCE_CLIENT_SECRET=
```

`SALESFORCE_CLIENT_SECRET` is optional. Leave it empty when your Salesforce External Client App does not require a secret for the web server or refresh token flow.

Callback URL for local development:

```text
http://localhost:3000/auth/callback
```

For ngrok or another public demo URL, set both the Salesforce callback URL and `.env` value to the same URL, for example:

```text
https://your-ngrok-domain.ngrok-free.app/auth/callback
```

After starting the app, open this URL in a browser:

```text
http://localhost:3000/auth/login?userId=iosu.demo
```

Salesforce redirects back to `/auth/callback`. The app exchanges the code for tokens and stores them in the server session store. Tokens are never logged and are not written to `.env`.

Check auth status:

```bash
curl "http://localhost:3000/auth/status?userId=iosu.demo"
```

Log out and clear the in-memory token session:

```bash
curl -X POST http://localhost:3000/auth/logout \
  -H "Content-Type: application/json" \
  -d '{"userId":"iosu.demo"}'
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
curl -X POST http://localhost:3000/ask -H "Content-Type: application/json" -d '{"userId":"iosu.demo","question":"¿Qué clientes debo priorizar hoy?"}'
```

Discover MCP tools:

```bash
curl "http://localhost:3000/mcp/tools?userId=iosu.demo"
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
- `auth_required`: open `/auth/login?userId=iosu.demo` in a browser and complete Salesforce login.
- `Invalid or expired Salesforce OAuth state`: restart login from `/auth/login`; OAuth state expires after 10 minutes.
- `missing required code challenge`: use the latest code in this project and restart the Node process. The OAuth flow sends PKCE parameters automatically.
- `Salesforce OAuth refresh failed`: verify connected app settings, OAuth scopes, client id, client secret, and token URL.
- `MCP HTTP request failed`: verify `SALESFORCE_MCP_SERVER_URL`, network access, bearer token scope, and Salesforce Hosted MCP availability.
- `MCP tools/list response did not include a tools array`: the server may use a different transport shape. Review `src/mcpClient.ts`.
- Client cannot reach the proxy: confirm it can access the Mac local IP, disable blocking firewall rules, or use ngrok/Tailscale for controlled demos.
