export function renderDashboard(): string {
  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Headless 360 MCP</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f7f8fb;
        --panel: #ffffff;
        --ink: #16202a;
        --muted: #5c6874;
        --line: #dce3ea;
        --accent: #0b6bcb;
        --accent-strong: #084f96;
        --good: #16794c;
        --warn: #a65f00;
        --bad: #b42318;
        --code: #101828;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: var(--bg);
        color: var(--ink);
      }

      main {
        width: min(1180px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 24px 0 40px;
      }

      header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        padding: 0 0 18px;
        border-bottom: 1px solid var(--line);
      }

      h1 {
        margin: 0;
        font-size: 24px;
        line-height: 1.2;
        letter-spacing: 0;
      }

      h2 {
        margin: 0 0 12px;
        font-size: 16px;
        line-height: 1.3;
        letter-spacing: 0;
      }

      p {
        margin: 6px 0 0;
        color: var(--muted);
        font-size: 14px;
      }

      button,
      input,
      textarea {
        font: inherit;
      }

      button {
        border: 1px solid var(--accent);
        background: var(--accent);
        color: #fff;
        border-radius: 6px;
        padding: 9px 12px;
        cursor: pointer;
        min-height: 38px;
      }

      button:hover {
        background: var(--accent-strong);
      }

      button.secondary {
        background: #fff;
        color: var(--accent);
      }

      button.secondary:hover {
        background: #eef6ff;
      }

      button:disabled {
        cursor: not-allowed;
        opacity: 0.65;
      }

      label {
        display: grid;
        gap: 6px;
        color: var(--muted);
        font-size: 13px;
      }

      input,
      textarea {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: #fff;
        color: var(--ink);
        padding: 10px 11px;
        outline: none;
      }

      textarea {
        min-height: 120px;
        resize: vertical;
      }

      input:focus,
      textarea:focus {
        border-color: var(--accent);
        box-shadow: 0 0 0 3px rgba(11, 107, 203, 0.14);
      }

      .grid {
        display: grid;
        grid-template-columns: minmax(0, 0.85fr) minmax(360px, 1.15fr);
        gap: 18px;
        margin-top: 18px;
      }

      .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 16px;
      }

      .stack {
        display: grid;
        gap: 14px;
      }

      .row {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }

      .spacer {
        flex: 1;
      }

      .status {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        border: 1px solid var(--line);
        padding: 6px 9px;
        background: #fff;
        color: var(--muted);
        font-size: 13px;
        white-space: nowrap;
      }

      .status.ok {
        border-color: rgba(22, 121, 76, 0.35);
        color: var(--good);
        background: #effaf4;
      }

      .status.warn {
        border-color: rgba(166, 95, 0, 0.35);
        color: var(--warn);
        background: #fff7ed;
      }

      .status.bad {
        border-color: rgba(180, 35, 24, 0.35);
        color: var(--bad);
        background: #fff1f0;
      }

      .answer {
        border-left: 3px solid var(--accent);
        background: #f5faff;
        padding: 12px;
        border-radius: 6px;
        min-height: 76px;
        line-height: 1.45;
      }

      .meta {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }

      .meta-item {
        border: 1px solid var(--line);
        border-radius: 6px;
        padding: 10px;
        background: #fff;
        min-width: 0;
      }

      .meta-item span {
        display: block;
        color: var(--muted);
        font-size: 12px;
        margin-bottom: 4px;
      }

      .meta-item strong {
        display: block;
        overflow-wrap: anywhere;
        font-size: 14px;
      }

      .tools {
        display: grid;
        gap: 10px;
      }

      .tool {
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 12px;
        background: #fff;
      }

      .tool summary {
        cursor: pointer;
      }

      .tool-name {
        font-weight: 700;
        overflow-wrap: anywhere;
      }

      .tool-description {
        color: var(--muted);
        margin-top: 6px;
        font-size: 13px;
        line-height: 1.4;
      }

      pre {
        margin: 10px 0 0;
        max-height: 320px;
        overflow: auto;
        border-radius: 6px;
        background: var(--code);
        color: #e6edf3;
        padding: 12px;
        font-size: 12px;
        line-height: 1.45;
      }

      .muted {
        color: var(--muted);
      }

      @media (max-width: 860px) {
        main {
          width: min(100vw - 24px, 720px);
          padding-top: 16px;
        }

        header,
        .grid {
          display: grid;
          grid-template-columns: 1fr;
        }

        .meta {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <h1>Headless 360 MCP</h1>
          <p>Pruebas locales del gateway para Siri y Salesforce MCP.</p>
        </div>
        <div class="row">
          <span id="authStatus" class="status">Comprobando sesión</span>
          <button id="loginButton" class="secondary" type="button">Login Salesforce</button>
        </div>
      </header>

      <section class="grid">
        <div class="stack">
          <section class="panel stack">
            <h2>Ask</h2>
            <label>
              userId
              <input id="userId" value="iosu.demo" autocomplete="off">
            </label>
            <label>
              pregunta
              <textarea id="question">¿Qué clientes debo priorizar hoy?</textarea>
            </label>
            <div class="row">
              <button id="askButton" type="button">Preguntar</button>
              <button id="toolsButton" class="secondary" type="button">Descubrir tools</button>
              <span id="busy" class="muted"></span>
            </div>
          </section>

          <section class="panel stack">
            <h2>Respuesta para Siri</h2>
            <div id="speech" class="answer muted">Sin respuesta todavía.</div>
            <div class="meta">
              <div class="meta-item">
                <span>intent</span>
                <strong id="intent">-</strong>
              </div>
              <div class="meta-item">
                <span>tool seleccionada</span>
                <strong id="selectedTool">-</strong>
              </div>
            </div>
            <details>
              <summary>raw</summary>
              <pre id="raw">{}</pre>
            </details>
          </section>
        </div>

        <section class="panel stack">
          <div class="row">
            <h2>Tools MCP disponibles</h2>
            <span class="spacer"></span>
            <span id="toolCount" class="status">Sin descubrir</span>
          </div>
          <div id="tools" class="tools">
            <p class="muted">Pulsa "Descubrir tools" para leer el contexto real del MCP Server.</p>
          </div>
        </section>
      </section>
    </main>

    <script>
      const userId = document.querySelector("#userId");
      const question = document.querySelector("#question");
      const authStatus = document.querySelector("#authStatus");
      const loginButton = document.querySelector("#loginButton");
      const askButton = document.querySelector("#askButton");
      const toolsButton = document.querySelector("#toolsButton");
      const busy = document.querySelector("#busy");
      const speech = document.querySelector("#speech");
      const intent = document.querySelector("#intent");
      const selectedTool = document.querySelector("#selectedTool");
      const raw = document.querySelector("#raw");
      const tools = document.querySelector("#tools");
      const toolCount = document.querySelector("#toolCount");
      const params = new URLSearchParams(window.location.search);
      const urlUserId = params.get("userId");
      const loginResult = params.get("login");

      if (urlUserId) {
        userId.value = urlUserId;
      }

      if (loginResult === "success") {
        setStatus(authStatus, "Conectado", "ok");
        window.history.replaceState({}, "", window.location.pathname + "?userId=" + encodeURIComponent(currentUserId()));
      }

      loginButton.addEventListener("click", () => {
        window.location.href = "/auth/login?userId=" + encodeURIComponent(currentUserId());
      });

      askButton.addEventListener("click", ask);
      toolsButton.addEventListener("click", loadTools);
      userId.addEventListener("change", refreshStatus);

      refreshStatus();

      function currentUserId() {
        return userId.value.trim() || "iosu.demo";
      }

      async function refreshStatus() {
        const response = await fetch("/auth/status?userId=" + encodeURIComponent(currentUserId()));
        const payload = await response.json();
        if (payload.authenticated) {
          setStatus(authStatus, "Conectado", "ok");
        } else {
          setStatus(authStatus, "Sin login", "warn");
        }
      }

      async function ask() {
        setBusy("Consultando MCP");
        askButton.disabled = true;
        try {
          const response = await fetch("/ask", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              userId: currentUserId(),
              question: question.value.trim()
            })
          });
          const payload = await response.json();
          speech.textContent = payload.speech || "Sin respuesta.";
          speech.classList.remove("muted");
          intent.textContent = payload.intent || "-";
          selectedTool.textContent = payload.tool || "-";
          raw.textContent = JSON.stringify(payload.raw ?? {}, null, 2);

          if (payload.intent === "auth_required" && payload.raw && payload.raw.authUrl) {
            setStatus(authStatus, "Login requerido", "warn");
          }

          await refreshStatus();
        } catch (error) {
          speech.textContent = "Error ejecutando la prueba local.";
          intent.textContent = "error";
          selectedTool.textContent = "-";
          raw.textContent = JSON.stringify({ message: String(error) }, null, 2);
        } finally {
          askButton.disabled = false;
          setBusy("");
        }
      }

      async function loadTools() {
        setBusy("Descubriendo tools");
        toolsButton.disabled = true;
        try {
          const response = await fetch("/mcp/tools?userId=" + encodeURIComponent(currentUserId()));
          const payload = await response.json();

          if (!response.ok) {
            tools.innerHTML = "";
            const p = document.createElement("p");
            p.className = "muted";
            p.textContent = payload.raw && payload.raw.error
              ? payload.raw.error
              : payload.speech || "No se han podido descubrir tools.";
            tools.appendChild(p);
            setStatus(toolCount, "Error", "bad");
            return;
          }

          renderTools(payload.tools || []);
          setStatus(toolCount, String(payload.count || 0) + " tools", "ok");
          await refreshStatus();
        } catch (error) {
          tools.innerHTML = "";
          const p = document.createElement("p");
          p.className = "muted";
          p.textContent = "Error descubriendo tools.";
          tools.appendChild(p);
          setStatus(toolCount, "Error", "bad");
        } finally {
          toolsButton.disabled = false;
          setBusy("");
        }
      }

      function renderTools(items) {
        tools.innerHTML = "";
        if (items.length === 0) {
          const p = document.createElement("p");
          p.className = "muted";
          p.textContent = "El MCP Server no ha devuelto tools.";
          tools.appendChild(p);
          return;
        }

        for (const item of items) {
          const details = document.createElement("details");
          details.className = "tool";

          const summary = document.createElement("summary");
          const name = document.createElement("span");
          name.className = "tool-name";
          name.textContent = item.name;
          summary.appendChild(name);
          details.appendChild(summary);

          const description = document.createElement("div");
          description.className = "tool-description";
          description.textContent = item.description || "Sin descripción.";
          details.appendChild(description);

          const schema = document.createElement("pre");
          schema.textContent = JSON.stringify({
            inputSchema: item.inputSchema || {},
            outputSchema: item.outputSchema || {},
            annotations: item.annotations || {}
          }, null, 2);
          details.appendChild(schema);
          tools.appendChild(details);
        }
      }

      function setBusy(text) {
        busy.textContent = text;
      }

      function setStatus(element, text, kind) {
        element.textContent = text;
        element.className = "status" + (kind ? " " + kind : "");
      }
    </script>
  </body>
</html>`;
}
