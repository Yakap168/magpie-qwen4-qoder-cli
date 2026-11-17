import { QwenCodeCliPlugin } from "./index.mjs";

const tools = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the current weather for a city.",
      parameters: {
        type: "object",
        properties: { city: { type: "string", description: "City name" } },
        required: ["city"],
      },
    },
  },
];

const hooks = await QwenCodeCliPlugin();
const loader = await hooks.auth.loader(async () => ({ type: "api", key: "local" }));
const base = {
  model: "qwen4-qoder/qwen4-max",
  messages: [{ role: "user", content: "查一下北京天气" }],
  tools,
  tool_choice: "auto",
  max_tokens: 100,
};

for (const stream of [false, true]) {
  const res = await loader.fetch("http://127.0.0.1:9/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...base, stream }),
  });
  console.log("=== stream:", stream, "status:", res.status);
  if (!stream) {
    console.log((await res.text()).slice(0, 1200));
  } else {
    console.log((await res.text()).slice(0, 1600));
  }
}
