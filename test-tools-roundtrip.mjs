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

async function call(messages, stream = false) {
  const res = await loader.fetch("http://127.0.0.1:9/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "qwen4-qoder/qwen4-max",
      messages,
      tools,
      tool_choice: "auto",
      stream,
      max_tokens: 200,
    }),
  });
  const text = await res.text();
  if (stream) return text;
  return JSON.parse(text);
}

const first = await call([{ role: "user", content: "查一下北京天气" }]);
console.log("first:", JSON.stringify(first.choices?.[0]?.message, null, 2));
const callInfo = first.choices?.[0]?.message?.tool_calls?.[0];
if (!callInfo) process.exit(2);

const second = await call([
  { role: "user", content: "查一下北京天气" },
  {
    role: "assistant",
    content: null,
    tool_calls: [callInfo],
  },
  {
    role: "tool",
    tool_call_id: callInfo.id,
    content: "北京：晴，18°C，西北风 2 级。",
  },
]);
console.log("second:", JSON.stringify(second.choices?.[0]?.message, null, 2));
console.log("usage:", JSON.stringify(second.usage));
