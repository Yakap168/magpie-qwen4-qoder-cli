import { QwenCodeCliPlugin } from "./index.mjs";

const hooks = await QwenCodeCliPlugin();
const loader = await hooks.auth.loader(async () => ({ type: "api", key: "local" }));

const prompt = "3 个人 3 天做 3 个零件，9 个人 9 天做多少个？只给数字。";
const cases = [
  ["default-high", {}],
  ["none", { reasoning_effort: "none" }],
  ["low-camel", { reasoningEffort: "low" }],
  ["xhigh-object", { reasoning: { effort: "xhigh" } }],
];

for (const [name, extra] of cases) {
  const t0 = Date.now();
  const res = await loader.fetch("http://127.0.0.1:9/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "qwen4-qoder/qwen4-max",
      messages: [{ role: "user", content: prompt }],
      stream: false,
      max_tokens: 16,
      ...extra,
    }),
  });
  const text = await res.text();
  let content = "";
  try {
    content = JSON.parse(text).choices?.[0]?.message?.content || "";
  } catch {}
  console.log(name, "status", res.status, "ms", Date.now() - t0, "content", JSON.stringify(content));
}
