# Headless Siri MCP Client

Local Headless 360 MCP client gateway for a Siri Shortcut. The service receives a natural-language request, connects to a configurable Salesforce Hosted MCP Server, discovers MCP tools dynamically, selects one using the live MCP context, executes it, and returns concise Spanish JSON for Siri.

It does not hardcode Salesforce tool names or business capabilities. Tool selection uses `listTools()`, tool names, descriptions, input schemas, and available output.

## Requirements

- Node.js 26.3 or newer
- npm
- Salesforce Hosted MCP Server URL
- Salesforce OAuth access token or refresh-token credentials

## Installation

```bash
npm install
cp .env.example .env
```

Edit `.env`:

```bash
PORT=3000
SALESFORCE_MCP_SERVER_URL=https://your-domain.my.salesforce.com/services/mcp
SALESFORCE_AUTH_TYPE=oauth
SALESFORCE_CLIENT_ID=
SALESFORCE_CLIENT_SECRET=
SALESFORCE_REFRESH_TOKEN=
SALESFORCE_ACCESS_TOKEN=
SALESFORCE_TOKEN_URL=https://login.salesforce.com/services/oauth2/token
DEFAULT_USER_ID=iosu.demo

LLM_PROVIDER=openai
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1-mini

ENABLE_DETERMINISTIC_FALLBACK=true
```

The app fails fast if mandatory Salesforce MCP or OAuth variables are missing. You can use either `SALESFORCE_ACCESS_TOKEN` or the refresh token flow with `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET`, `SALESFORCE_REFRESH_TOKEN`, and `SALESFORCE_TOKEN_URL`.

`SALESFORCE_TOKEN_URL` can point to `login.salesforce.com`, `test.salesforce.com`, or a custom Salesforce domain.

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

Ask endpoint:

```bash
curl -X POST http://localhost:3000/ask \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "iosu.demo",
    "question": "¿Qué clientes debo priorizar hoy?"
  }'
```

Response shape:

```json
{
  "speech": "Texto corto para que Siri lo lea en voz alta",
  "intent": "detected_intent",
  "tool": "selected_mcp_tool_name",
  "raw": {}
}
```

## Siri Shortcut

Shortcut name:

```text
Asistente Comercial CPC
```

Actions:

1. Dictate Text

Prompt:

```text
¿Qué necesitas?
```

2. Get Contents of URL

Method:

```text
POST
```

URL:

```text
http://MAC_IP_OR_NGROK_URL:3000/ask
```

Headers:

```text
Content-Type: application/json
```

JSON body:

```json
{
  "userId": "iosu.demo",
  "question": "[Dictated Text]"
}
```

3. Get Dictionary Value

Key:

```text
speech
```

4. Speak Text

## Connectivity Options

- Same Wi-Fi: use your Mac local IP, for example `http://192.168.1.50:3000/ask`.
- ngrok: useful for controlled demos when the iPhone is outside the same network.
- Tailscale: good for private device-to-device connectivity without exposing the endpoint publicly.

## How Tool Selection Works

`POST /ask` performs this flow:

1. Reads `question` and `userId`.
2. Gets a Salesforce access token.
3. Connects to the Salesforce Hosted MCP Server.
4. Calls `listTools()`.
5. Builds a selection prompt from the user question, user id, current date, and available MCP tools.
6. Selects exactly one MCP tool and builds minimal valid JSON input.
7. Verifies that the selected tool exists in the MCP tool list.
8. Calls the MCP tool with JSON input.
9. Formats the tool output into short Spanish speech.

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
- Use HTTPS in real environments.
- Use least-privilege Salesforce credentials.
- Avoid returning sensitive customer information in voice responses.

## Troubleshooting

- `Missing mandatory environment variable`: check `.env` and make sure the Salesforce MCP URL and OAuth configuration are present.
- `Salesforce OAuth refresh failed`: verify connected app settings, refresh token validity, client id, client secret, and token URL.
- `MCP HTTP request failed`: verify `SALESFORCE_MCP_SERVER_URL`, network access, bearer token scope, and Salesforce Hosted MCP availability.
- `MCP tools/list response did not include a tools array`: the server may use a different transport shape. Review `src/mcpClient.ts`.
- Siri cannot reach the Mac: confirm both devices are on the same Wi-Fi, use the Mac LAN IP, disable blocking firewall rules, or use ngrok/Tailscale.
