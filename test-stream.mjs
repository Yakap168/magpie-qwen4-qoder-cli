import { QwenCodeCliPlugin } from "./index.mjs";

const hooks = await QwenCodeCliPlugin();
const loader = await hooks.auth.loader(async () => ({ type: "api", key: "local" }));

const t0 = Date.now();
const res = await loader.fetch("http://127.0.0.1:9/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "qwen4-qoder/qwen4-max",
    messages: [{ role: "user", content: "3 个人 3 天做 3 个零件，9 个人 9 天做多少个？只给数字。" }],
    stream: true,
    max_tokens: 16,
  }),
});

console.log("status", res.status, "type", res.headers.get("content-type"));
const reader = res.body.getReader();
const decoder = new TextDecoder();
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  console.log(`+${Date.now() - t0}ms`, JSON.stringify(decoder.decode(value)));
}
