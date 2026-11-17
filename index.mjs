// magpie-qwen-code-cli — a Magpie provider plugin that runs the local
// Qwen Code CLI for each chat request, so the request uses Qwen Code's own
// sign-in and quota (for example the Qoder limited-free Qwen4 promotion).
//
// This is deliberately a CLI wrapper, not a reimplementation of Qwen Code's
// private HTTP protocol. It uses only the public `qwen -p` interface.
//
// Limitations:
//   - one process per request (slow; ~2-15s for short prompts)
//   - text only; images/tool calls are not forwarded
//   - streaming requests are answered as a single SSE chunk
//
// Provider id: qwen4-qoder. Model id: qwen4-max (maps to qmodel_latest).

import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PROVIDER = "qwen4-qoder";
const PROVIDER_NAME = "Qwen4-Max via Qwen Code";
const MODEL_ID = "qwen4-max";
const MODEL_NAME = "Qwen4-Max (Qwen Code)";
const QWEN_MODEL = "qmodel_latest";
const DUMMY_BASE = "http://127.0.0.1:9/v1";
const ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjE3LjUgMjcuNyAxMzUuNiAxMzUuNiI+CiAgPHBhdGggZmlsbD0iIzA4MkRGRiIgZD0iTTEzMC4wNiw0My42NmgtMzMuMzdjMC0xLjQyLS4zNy0yLjg0LTEuMS00LjExbC00LjQ3LTcuNzRjLTEuNDctMi41NC00LjE4LTQuMTEtNy4xMi00LjExaC04LjkzYy0yLjk0LDAtNS42NSwxLjU3LTcuMTIsNC4xMWwtMTMuNjgsMjMuNjljLTEuNDcsMi41NC0xLjQ3LDUuNjcsMCw4LjIybDQuNDcsNy43NGMxLjQ3LDIuNTQsNC4xOCw0LjExLDcuMTIsNC4xMWg2NC4xOWMyLjk0LDAsNS42NS0xLjU3LDcuMTItNC4xMWw0LjQ3LTcuNzRjMS40Ny0yLjU0LDEuNDctNS42NywwLTguMjJsLTQuNDctNy43NGMtMS40Ny0yLjU0LTQuMTgtNC4xMS03LjEyLTQuMTFaIiAvPgogIDxwYXRoIGZpbGw9IiMwODJERkYiIGQ9Ik0xOS43NSw4My42NmwxNi42OCwyOC45Yy0xLjIzLjcxLTIuMjcsMS43NC0zLjAxLDMuMDFsLTQuNDcsNy43NGMtMS40NywyLjU0LTEuNDcsNS42NywwLDguMjJsNC40Nyw3Ljc0YzEuNDcsMi41NCw0LjE4LDQuMTEsNy4xMiw0LjExaDI3LjM1YzIuOTQsMCw1LjY1LTEuNTcsNy4xMi00LjExbDQuNDctNy43NGMxLjQ3LTIuNTQsMS40Ny01LjY3LDAtOC4yMmwtMzIuMS01NS41OWMtMS40Ny0yLjU0LTQuMTgtNC4xMS03LjEyLTQuMTFoLTguOTNjLTIuOTQsMC01LjY1LDEuNTctNy4xMiw0LjExbC00LjQ3LDcuNzRjLTEuNDcsMi41NC0xLjQ3LDUuNjcsMCw4LjIyWiIgLz4KICA8cGF0aCBmaWxsPSIjMDgyREZGIiBkPSJNMTA5LjU1LDE1OS4xOWwxNi42OC0yOC45YzEuMjMuNzEsMi42NCwxLjEsNC4xMSwxLjFoOC45M2MyLjk0LDAsNS42NS0xLjU3LDcuMTItNC4xMWw0LjQ3LTcuNzRjMS40Ny0yLjU0LDEuNDctNS42NywwLTguMjJsLTEzLjY4LTIzLjY5Yy0xLjQ3LTIuNTQtNC4xOC00LjExLTcuMTItNC4xMWgtOC45M2MtMi45NCwwLTUuNjUsMS41Ny03LjEyLDQuMTFsLTMyLjEsNTUuNTljLTEuNDcsMi41NC0xLjQ3LDUuNjcsMCw4LjIybDQuNDcsNy43NGMxLjQ3LDIuNTQsNC4xOCw0LjExLDcuMTIsNC4xMWg4LjkzYzIuOTQsMCw1LjY1LTEuNTcsNy4xMi00LjExWiIgLz4KPC9zdmc+Cg==";
function envNumber(name, fallback, min = 1) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

const CLI_TIMEOUT_MS = envNumber("MAGPIE_QWEN_CLI_TIMEOUT_MS", 540_000);
const KEEPALIVE_MS = envNumber("MAGPIE_QWEN_KEEPALIVE_MS", 15_000);
const MAX_CONCURRENCY = Math.max(1, Math.trunc(envNumber("MAGPIE_QWEN_CONCURRENCY", 2)));
const MAX_OUTPUT = 393_216;
const DEFAULT_EFFORT = "high";
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 30_000;

const SYSTEM_PROMPT =
  "You are a helpful assistant. Answer the user's last message directly in plain text. " +
  "If images are attached, inspect them and answer about them. " +
  "Do not use tools, do not read or modify files, and do not ask clarifying questions " +
  "unless the request is impossible to answer.";

function modelEntry() {
  return {
    id: MODEL_ID,
    name: MODEL_NAME,
    api: {
      id: MODEL_ID,
      url: DUMMY_BASE,
      npm: "@ai-sdk/openai-compatible",
    },
    status: "active",
    cost: {
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    },
    limit: {
      context: 1_000_000,
      output: MAX_OUTPUT,
    },
    options: {},
    headers: {},
    // Magpie's provider-list shape: top-level attachment / modalities / reasoning.
    attachment: true,
    modalities: { input: ["text", "image"], output: ["text"] },
    reasoning: true,
    tool_call: false,
    // OpenCode / AI SDK runtime shape.
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: false,
      input: { text: true, image: true, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "2026-11-16",
    variants: {
      none: { reasoningEffort: "none" },
      low: { reasoningEffort: "low" },
      medium: { reasoningEffort: "medium" },
      high: { reasoningEffort: "high" },
      xhigh: { reasoningEffort: "xhigh" },
    },
  };
}

const MODELS = { [MODEL_ID]: modelEntry() };

function qwenBin() {
  const env = process.env.QWEN_CODE_BIN;
  if (env && fs.existsSync(env)) return env;
  const local = path.join(
    os.homedir(),
    ".qwen",
    "bin",
    "qwen",
    process.platform === "win32" ? "qwen.exe" : "qwen",
  );
  if (fs.existsSync(local)) return local;
  return process.platform === "win32" ? "qwen.exe" : "qwen";
}

// Qwen Code asks for folder trust in an interactive session. The CLI is
// started in a folder its own settings already trust, so `-p` does not stop
// on that prompt.
function trustedDir() {
  const settingsPath = path.join(os.homedir(), ".qwen", "settings.json");
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const dirs = settings?.permissions?.trustDirectories;
    if (Array.isArray(dirs)) {
      for (const dir of dirs) {
        if (typeof dir === "string" && fs.existsSync(dir)) return dir;
      }
    }
  } catch {}
  return os.homedir();
}

function readCreds() {
  const credsPath = path.join(os.homedir(), ".qwen", "qoder_oauth_creds.json");
  try {
    return JSON.parse(fs.readFileSync(credsPath, "utf8"));
  } catch {
    return null;
  }
}

function accountOf() {
  const creds = readCreds();
  const accounts = creds?.accounts;
  if (!accounts || typeof accounts !== "object") return null;
  const account = accounts.cn || accounts.intl || Object.values(accounts)[0];
  if (!account || typeof account !== "object") return null;
  return {
    userId: typeof account.userId === "string" ? account.userId : "",
    userName: typeof account.userName === "string" ? account.userName : "",
    region: typeof account.region === "string" ? account.region : "",
  };
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        if (part?.type === "image_url" || part?.type === "input_image" || part?.type === "image") {
          return "[Image attached]";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

function imageUrlsOf(body) {
  const urls = [];
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (const message of messages) {
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part === "string") continue;
      const type = part.type;
      if (type === "image_url" || type === "input_image" || type === "image") {
        let url = null;
        if (typeof part.image_url === "string") url = part.image_url;
        else if (part.image_url && typeof part.image_url.url === "string") url = part.image_url.url;
        else if (typeof part.url === "string") url = part.url;
        else if (typeof part.image === "string") url = part.image;
        else if (part.source?.type === "base64" && typeof part.source.data === "string") {
          url = `data:${part.source.media_type || "image/png"};base64,${part.source.data}`;
        }
        if (url) urls.push(url);
      }
    }
  }
  return urls;
}

function extensionFor(mime) {
  const type = String(mime || "").toLowerCase();
  if (type.includes("jpeg") || type.includes("jpg")) return ".jpg";
  if (type.includes("webp")) return ".webp";
  if (type.includes("gif")) return ".gif";
  if (type.includes("bmp")) return ".bmp";
  return ".png";
}

async function readImage(url) {
  if (url.startsWith("data:")) {
    const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(url);
    if (!match) throw new Error("Unsupported image data URL");
    const mime = match[1] || "image/png";
    const data = match[2]
      ? Buffer.from(match[3], "base64")
      : Buffer.from(decodeURIComponent(match[3]), "utf8");
    return { mime, data };
  }
  if (/^https?:\/\//i.test(url)) {
    const timeout =
      typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS)
        : undefined;
    const response = await fetch(url, timeout ? { signal: timeout } : {});
    if (!response.ok) throw new Error(`Image download failed: HTTP ${response.status}`);
    const mime = response.headers.get("content-type") || "image/png";
    return { mime, data: Buffer.from(await response.arrayBuffer()) };
  }
  throw new Error("Unsupported image URL");
}

async function materializeImages(body) {
  const urls = imageUrlsOf(body);
  if (urls.length === 0) return { dir: null, attachments: [] };
  if (urls.length > MAX_IMAGES) throw new Error(`Too many images (max ${MAX_IMAGES})`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-qwen4-"));
  const attachments = [];
  try {
    for (let i = 0; i < urls.length; i += 1) {
      const { mime, data } = await readImage(urls[i]);
      if (data.length > MAX_IMAGE_BYTES) throw new Error(`Image ${i + 1} exceeds 20 MB`);
      const file = path.join(dir, `image-${i + 1}${extensionFor(mime)}`);
      fs.writeFileSync(file, data);
      attachments.push(file);
    }
    return { dir, attachments };
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function promptOf(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lines = [];
  for (const message of messages) {
    const text = contentText(message?.content);
    if (!text.trim()) continue;
    const role = message?.role || "user";
    const label =
      role === "system"
        ? "System"
        : role === "assistant"
          ? "Assistant"
          : role === "tool"
            ? "Tool result"
            : "User";
    lines.push(`[${label}]\n${text}`);
  }
  if (lines.length === 0 && typeof body.prompt === "string") {
    lines.push(`[User]\n${body.prompt}`);
  }
  lines.push(
    "[Instruction]\nReply to the last user message as the assistant. Output only the answer text.",
  );
  return lines.join("\n\n");
}

function mapEffort(value) {
  const effort = String(value ?? "").trim().toLowerCase();
  if (!effort) return null;
  if (effort === "none" || effort === "off" || effort === "disabled") return "none";
  if (effort === "minimal" || effort === "low") return "low";
  if (effort === "medium" || effort === "mid") return "medium";
  if (effort === "high") return "high";
  if (effort === "xhigh" || effort === "extra-high" || effort === "max") return "xhigh";
  return null;
}

function effortOf(body) {
  return mapEffort(
    body?.reasoning_effort ??
      body?.reasoningEffort ??
      body?.reasoning?.effort ??
      body?.thinking?.effort ??
      null,
  );
}

function logEffort(body, chosen) {
  if (!process.env.MAGPIE_QWEN_DEBUG) return;
  try {
    fs.appendFileSync(
      path.join(os.tmpdir(), "magpie-qwen4-qoder-effort.log"),
      JSON.stringify({
        at: new Date().toISOString(),
        reasoning_effort: body?.reasoning_effort,
        reasoningEffort: body?.reasoningEffort,
        reasoning: body?.reasoning,
        thinking: body?.thinking,
        chosen,
      }) + "\n",
    );
  } catch {}
}

function parseResult(stdout) {
  const text = String(stdout || "").trim();
  if (!text) throw new Error("Qwen Code returned no output");
  try {
    const data = JSON.parse(text);
    if (data?.is_error) {
      throw new Error(data?.error?.message || data?.result || "Qwen Code returned an error");
    }
    if (typeof data?.result === "string") return data.result;
    if (typeof data?.response === "string") return data.response;
    if (data?.message?.content != null) return contentText(data.message.content);
    return JSON.stringify(data);
  } catch (error) {
    if (error instanceof SyntaxError) return text;
    throw error;
  }
}

function modelName(requested) {
  const name = typeof requested === "string" ? requested : "";
  return name || `${PROVIDER}/${MODEL_ID}`;
}

function jsonResponse(text, requested) {
  const body = {
    id: "chatcmpl-qwen-" + randomUUID(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelName(requested),
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function streamQwen(requestBody, signal) {
  const id = "chatcmpl-qwen-" + randomUUID();
  const created = Math.floor(Date.now() / 1000);
  const model = modelName(requestBody.model);
  const encoder = new TextEncoder();
  const controller = new AbortController();
  let keepalive = null;

  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  const stream = new ReadableStream({
    start(streamController) {
      const send = (chunk) => {
        try {
          streamController.enqueue(encoder.encode(chunk));
        } catch {}
      };
      const chunk = (delta, finish = null) =>
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;

      // Send a data event before the CLI starts. A stream-idle timeout on the
      // client side resets on any data, so a long xhigh call no longer looks
      // like a dead connection.
      send(chunk({ role: "assistant" }));
      keepalive = setInterval(() => send(chunk({})), KEEPALIVE_MS);

      (async () => {
        let dir = null;
        try {
          const imageData = await materializeImages(requestBody);
          dir = imageData.dir;
          if (controller.signal.aborted) throw new Error("Request aborted");
          const text = await withSlot(() =>
            runQwen(promptOf(requestBody), requestBody, controller.signal, imageData.attachments),
          );
          send(chunk({ content: text }));
          send(chunk({}, "stop"));
          send("data: [DONE]\n\n");
        } catch (error) {
          const message = error?.message || String(error);
          send(
            `data: ${JSON.stringify({
              error: { message, type: "qwen_code_cli_error" },
            })}\n\n`,
          );
          send("data: [DONE]\n\n");
        } finally {
          if (keepalive) clearInterval(keepalive);
          if (dir) {
            try {
              fs.rmSync(dir, { recursive: true, force: true });
            } catch {}
          }
          if (signal) signal.removeEventListener("abort", onAbort);
          try {
            streamController.close();
          } catch {}
        }
      })();
    },
    cancel() {
      controller.abort();
      if (keepalive) clearInterval(keepalive);
      if (signal) signal.removeEventListener("abort", onAbort);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

function errorResponse(status, message) {
  return new Response(
    JSON.stringify({
      error: { message: String(message || "Qwen Code CLI error"), type: "qwen_code_cli_error" },
    }),
    {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    },
  );
}

function modelsResponse() {
  return new Response(
    JSON.stringify({
      object: "list",
      data: [{ id: MODEL_ID, object: "model", created: 0, owned_by: PROVIDER }],
    }),
    { status: 200, headers: { "content-type": "application/json; charset=utf-8" } },
  );
}

async function runQwen(prompt, requestBody, signal, attachments = []) {
  if (signal?.aborted) throw new Error("Request aborted");
  const args = [
    "-p",
    prompt,
    "-m",
    QWEN_MODEL,
    "-o",
    "json",
    "--no-session-persistence",
    "--tools",
    "",
    "--system-prompt",
    SYSTEM_PROMPT,
  ];

  const max = requestBody.max_tokens ?? requestBody.max_completion_tokens;
  if (max != null) {
    const n = Number(max);
    if (Number.isFinite(n) && n > 0) {
      args.push("--max-output-tokens", String(Math.min(Math.trunc(n), MAX_OUTPUT)));
    }
  }

  const effort = effortOf(requestBody) ?? DEFAULT_EFFORT;
  logEffort(requestBody, effort);
  args.push("--reasoning-effort", effort);

  for (const attachment of attachments) {
    args.push("--attachment", attachment);
  }

  const options = {
    cwd: trustedDir(),
    timeout: CLI_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    encoding: "utf8",
  };
  if (signal) options.signal = signal;

  const { stdout } = await execFileAsync(qwenBin(), args, options);
  return parseResult(stdout);
}

let active = 0;
const waiting = [];

function withSlot(fn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      active += 1;
      try {
        resolve(await fn());
      } catch (error) {
        reject(error);
      } finally {
        active -= 1;
        const next = waiting.shift();
        if (next) next();
      }
    };
    if (active < MAX_CONCURRENCY) run();
    else waiting.push(run);
  });
}

async function qwenFetch(input, init = {}) {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : typeof input?.url === "string"
          ? input.url
          : "";

  if (/\/models(?:\?|$)/.test(url)) return modelsResponse();

  let raw = init.body;
  if (raw == null && typeof Request !== "undefined" && input instanceof Request) {
    raw = await input.text();
  }

  let requestBody = {};
  if (typeof raw === "string" && raw.trim()) {
    try {
      requestBody = JSON.parse(raw);
    } catch {
      return errorResponse(400, "Invalid JSON request body");
    }
  } else if (raw && typeof raw === "object" && !(raw instanceof ReadableStream)) {
    requestBody = raw;
  }

  if (requestBody.stream) return streamQwen(requestBody, init.signal);

  let imageData;
  try {
    imageData = await materializeImages(requestBody);
  } catch (error) {
    return errorResponse(400, error?.message || String(error));
  }

  try {
    const text = await withSlot(() =>
      runQwen(promptOf(requestBody), requestBody, init.signal, imageData.attachments),
    );
    return jsonResponse(text, requestBody.model);
  } catch (error) {
    return errorResponse(502, error?.message || String(error));
  } finally {
    if (imageData.dir) {
      try {
        fs.rmSync(imageData.dir, { recursive: true, force: true });
      } catch {}
    }
  }
}

export async function QwenCodeCliPlugin() {
  return {
    config(cfg) {
      cfg.provider ??= {};
      cfg.provider[PROVIDER] ??= {
        name: PROVIDER_NAME,
        npm: "@ai-sdk/openai-compatible",
        api: DUMMY_BASE,
        models: MODELS,
      };
    },

    auth: {
      provider: PROVIDER,
      icon: ICON,
      maxConcurrency: MAX_CONCURRENCY,
      methods: [
        {
          type: "api",
          label: "Qwen Code CLI local sign-in",
          placeholder: "local",
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth();
        if (!auth || auth.type !== "api") return {};
        return {
          baseURL: DUMMY_BASE,
          apiKey: auth.key || "local",
          headers: {},
          fetch: qwenFetch,
        };
      },
      async usage(getAuth) {
        const auth = await getAuth();
        if (!auth || auth.type !== "api") {
          return {
            error: "Add an account with any value (for example: local)",
            signIn: "kept",
          };
        }
        const account = accountOf();
        return {
          plan: "Qwen Code limited-free",
          user: account?.userName || account?.userId || "local Qwen Code",
          error:
            "Exact quota is managed by Qwen Code. Run `qwen` and `/usage` in its terminal UI.",
          windows: [],
          resets: [],
        };
      },
    },

    provider: {
      id: PROVIDER,
      async models(provider) {
        return provider.models;
      },
    },
  };
}

export const _internal = {
  PROVIDER,
  MODEL_ID,
  QWEN_MODEL,
  qwenBin,
  trustedDir,
  accountOf,
  promptOf,
  mapEffort,
  parseResult,
  qwenFetch,
  imageUrlsOf,
  readImage,
  materializeImages,
  streamQwen,
  withSlot,
  MAX_IMAGES,
  KEEPALIVE_MS,
  MAX_CONCURRENCY,
};

export default { id: PROVIDER, server: QwenCodeCliPlugin };
