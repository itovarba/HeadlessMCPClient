import { spawn } from "node:child_process";
import {
  ensureOllama,
  isModelInstalled,
  modelName,
  ollamaBinary,
  ollamaEnvironment
} from "./ollama-runtime.mjs";

const sourceModel = "hf.co/Qwen/Qwen3-4B-GGUF:Q4_K_M";
let ollamaProcess;

try {
  const ollama = await ensureOllama({ allowDownloads: true });
  ollamaProcess = ollama.process;

  if (!(await isModelInstalled(modelName))) {
    await runOllama(["pull", sourceModel]);
    await runOllama(["cp", sourceModel, modelName]);
  }

  await verifyInference();
  console.log(`[llm] Modelo instalado como ${modelName}.`);
} finally {
  ollamaProcess?.kill("SIGTERM");
}

function runOllama(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ollamaBinary, args, {
      env: ollamaEnvironment({ allowDownloads: true }),
      stdio: "inherit"
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ollama ${args[0]} failed with code ${code}.`));
    });
  });
}

async function verifyInference() {
  const response = await fetch("http://127.0.0.1:11434/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: modelName,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Return strict JSON only." },
        { role: "user", content: "Return {\"ok\":true}." }
      ]
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.choices?.[0]?.message?.content) {
    throw new Error(`Local inference check failed with status ${response.status}.`);
  }
  console.log("[llm] Inferencia local verificada.");
}
