import fs from "node:fs";
import { QwenCodeCliPlugin } from "./index.mjs";

const imagePath = process.argv[2];
if (!imagePath) {
  console.error("usage: magpie-bun test-image.mjs <image>");
  process.exit(1);
}

const lower = imagePath.toLowerCase();
const mime = lower.endsWith(".jpg") || lower.endsWith(".jpeg")
  ? "image/jpeg"
  : lower.endsWith(".webp")
    ? "image/webp"
    : lower.endsWith(".gif")
      ? "image/gif"
      : "image/png";
const dataUrl = `data:${mime};base64,${fs.readFileSync(imagePath).toString("base64")}`;

const hooks = await QwenCodeCliPlugin();
const loader = await hooks.auth.loader(async () => ({ type: "api", key: "local" }));

const res = await loader.fetch("http://127.0.0.1:9/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "qwen4-qoder/qwen4-max",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "用一句中文描述这张图的主要内容。" },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    stream: false,
    max_tokens: 200,
  }),
});

console.log("status", res.status);
const text = await res.text();
try {
  console.log(JSON.parse(text).choices?.[0]?.message?.content || text);
} catch {
  console.log(text);
}
