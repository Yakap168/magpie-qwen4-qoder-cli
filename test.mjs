import { QwenCodeCliPlugin, _internal } from "./index.mjs";

const hooks = await QwenCodeCliPlugin();
const loader = await hooks.auth.loader(async () => ({ type: "api", key: "local" }));

console.log("qwen bin:", _internal.qwenBin());
console.log("cwd:", _internal.trustedDir());
console.log("account:", _internal.accountOf());

const body = {
  model: "qwen4-qoder/qwen4-max",
  messages: [{ role: "user", content: "只回复 OK" }],
  stream: false,
};

const res = await loader.fetch("http://127.0.0.1:9/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
console.log("non-stream status:", res.status);
console.log((await res.text()).slice(0, 1200));

const sres = await loader.fetch("http://127.0.0.1:9/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ...body, stream: true }),
});
console.log("stream status:", sres.status);
console.log((await sres.text()).slice(0, 800));
