import { spawn } from "node:child_process";
import path from "node:path";

export const ollamaBinary = "/opt/homebrew/bin/ollama";
export const ollamaUrl = "http://127.0.0.1:11434";
export const modelName = "qwen3:1.7b-voice";

export function ollamaEnvironment({ allowDownloads = false } = {}) {
  return {
    ...process.env,
    OLLAMA_MODELS: path.join(process.cwd(), ".ollama-models"),
    OLLAMA_FLASH_ATTENTION: "1",
    OLLAMA_KV_CACHE_TYPE: "q8_0",
    OLLAMA_CONTEXT_LENGTH: "4096",
    OLLAMA_KEEP_ALIVE: "-1",
    OLLAMA_NUM_PARALLEL: "1",
    OLLAMA_MAX_TRANSFER_STREAMS: "1",
    ...(allowDownloads ? {} : { OLLAMA_NO_CLOUD: "1" })
  };
}

export async function ensureOllama({ allowDownloads = false } = {}) {
  if (await isOllamaReady()) {
    return { process: undefined, owned: false };
  }

  const child = spawn(ollamaBinary, ["serve"], {
    env: ollamaEnvironment({ allowDownloads }),
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => process.stdout.write(`[ollama] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[ollama] ${chunk}`));

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Ollama exited during startup with code ${child.exitCode}.`);
    }
    if (await isOllamaReady()) {
      return { process: child, owned: true };
    }
    await delay(300);
  }

  child.kill("SIGTERM");
  throw new Error("Ollama did not become ready within 30 seconds.");
}

export async function isModelInstalled(name = modelName) {
  const response = await fetch(`${ollamaUrl}/api/tags`).catch(() => undefined);
  if (!response?.ok) return false;
  const payload = await response.json();
  return Array.isArray(payload.models) && payload.models.some((model) =>
    typeof model?.name === "string" && (model.name === name || model.name.startsWith(`${name}:`))
  );
}

async function isOllamaReady() {
  const response = await fetch(`${ollamaUrl}/api/tags`).catch(() => undefined);
  return Boolean(response?.ok);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
