import { spawn } from "node:child_process";
import dotenv from "dotenv";
import { ensureOllama, isModelInstalled, modelName } from "./ollama-runtime.mjs";

dotenv.config();
const proxyPort = Number.parseInt(process.env.PORT ?? "3000", 10);

let ollamaProcess;
let proxyProcess;
let stopping = false;

try {
  if (await isProxyAlreadyRunning()) {
    throw new Error(`El puerto ${proxyPort} ya está ocupado por otro proxy. Detén la ejecución anterior antes de lanzar npm run dev.`);
  }

  const ollama = await ensureOllama();
  ollamaProcess = ollama.process;

  if (!(await isModelInstalled())) {
    console.warn(`[dev] El modelo ${modelName} no está instalado. Ejecuta una vez: npm run llm:pull`);
    console.warn("[dev] El proxy arrancará y utilizará el fallback determinista hasta entonces.");
  }

  proxyProcess = spawn("./node_modules/.bin/tsx", ["watch", "src/server.ts"], {
    stdio: "inherit",
    env: process.env
  });

  proxyProcess.on("exit", (code, signal) => {
    stop(code ?? (signal ? 1 : 0));
  });
} catch (error) {
  console.error(`[dev] ${error instanceof Error ? error.message : String(error)}`);
  stop(1);
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

function stop(exitCode) {
  if (stopping) return;
  stopping = true;
  proxyProcess?.kill("SIGTERM");
  ollamaProcess?.kill("SIGTERM");
  setTimeout(() => process.exit(exitCode), 250);
}

async function isProxyAlreadyRunning() {
  const response = await fetch(`http://127.0.0.1:${proxyPort}/health`).catch(() => undefined);
  return Boolean(response?.ok);
}
