import test from 'node:test'
import assert from 'node:assert/strict'
import { createForwarder, sanitizeText } from '../src/forward.mjs'
import { deriveSessionId } from '../src/translate.mjs'
import { SESSION_HEADER } from '../src/models.mjs'

/** 假凭证管理器。 */
function fakeAuth() {
  const calls = []
  return {
    region: 'cn',
    calls,
    async getAccessToken(options = {}) {
      calls.push(options)
      return 'dt-faketoken123456'
    },
  }
}

/** 把事件数组做成上游 SSE Response。 */
function sseResponse(events, status = 200) {
  const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
  return new Response(text, { status, headers: { 'content-type': 'text/event-stream' } })
}

const OK_EVENTS = [
  { type: 'response.reasoning_text.delta', delta: '思考' },
  { type: 'response.output_text.delta', delta: '答案' },
  { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 11, output_tokens: 3, total_tokens: 14 } } },
]

/** 读完聊天 SSE，返回 data 帧对象数组。 */
async function readChatSse(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  const frames = []
  for (const raw of text.split('\n\n')) {
    const line = raw.split('\n').find((l) => l.startsWith('data:'))
    if (!line) continue
    const data = line.slice(5).trim()
    if (data === '[DONE]') {
      frames.push('[DONE]')
      continue
    }
    try {
      frames.push(JSON.parse(data))
    } catch {
      // 忽略坏帧
    }
  }
  return frames
}

function setup(t, { upstream, config = {} } = {}) {
  const seen = []
  const auth = fakeAuth()
  const forwarder = createForwarder({
    auth,
    logger: { info() {}, warn() {}, error() {} },
    fetchImpl: async (url, init) => {
      seen.push({ url, headers: init.headers, body: JSON.parse(init.body), signal: init.signal })
      return upstream(seen.length, init)
    },
    ...config,
  })
  return { forwarder, seen, auth }
}

test('流式转发：别名→qmodel_latest，网关头/必填字段齐全，SSE 翻译正确', async (t) => {
  const { forwarder, seen } = setup(t, { upstream: () => sseResponse(OK_EVENTS) })
  const response = await forwarder.chat({
    model: 'qwen4-qoder/qwen4-max',
    stream: true,
    messages: [{ role: 'user', content: '你好' }],
    reasoning_effort: 'low',
  })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /text\/event-stream/)

  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, 'https://gateway.qoder.com.cn/qsvr/api/v1/responses?AgentId=agent_common')
  assert.equal(seen[0].headers.Authorization, 'Bearer dt-faketoken123456')
  assert.equal(seen[0].headers['Cosy-ClientType'], '13')
  assert.equal(seen[0].headers['Cosy-Version'], '1.0.0-preview.2')
  assert.ok(seen[0].headers['X-Request-Id'])
  assert.ok(seen[0].headers['X-Session-Id'])
  assert.equal(seen[0].body.model, 'qmodel_latest')
  assert.equal(seen[0].body.stream, true)
  assert.equal(seen[0].body.store, false)
  assert.deepEqual(seen[0].body.metadata, { session_type: 'qcode' })
  assert.deepEqual(seen[0].body.reasoning, { effort: 'low' })

  const frames = await readChatSse(response)
  assert.equal(frames.at(-1), '[DONE]')
  const chunks = frames.filter((f) => f !== '[DONE]' && f.object === 'chat.completion.chunk')
  assert.deepEqual(chunks[0].choices[0].delta, { role: 'assistant' })
  assert.equal(chunks.map((c) => c.choices[0].delta.reasoning_content ?? '').join(''), '思考')
  assert.equal(chunks.map((c) => c.choices[0].delta.content ?? '').join(''), '答案')
  const last = chunks.at(-1)
  assert.equal(last.choices[0].finish_reason, 'stop')
  assert.deepEqual(last.usage, { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 })
  assert.equal(forwarder.stats.lastReasoningDeltas, 1)
})

test('非流式转发：聚合成 chat.completion，带 reasoning_content 与真实 usage', async (t) => {
  const { forwarder } = setup(t, { upstream: () => sseResponse(OK_EVENTS) })
  const response = await forwarder.chat({ model: 'qwen4-max', messages: [{ role: 'user', content: '你好' }] })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.object, 'chat.completion')
  assert.equal(body.choices[0].message.content, '答案')
  assert.equal(body.choices[0].message.reasoning_content, '思考')
  assert.equal(body.choices[0].finish_reason, 'stop')
  assert.deepEqual(body.usage, { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 })
})

test('上游 401：强制刷新 token 后重试一次', async (t) => {
  const { forwarder, seen, auth } = setup(t, {
    upstream: (n) => (n === 1 ? new Response('{"error":{"message":"expired"}}', { status: 401 }) : sseResponse(OK_EVENTS)),
  })
  const response = await forwarder.chat({ model: 'qwen4-max', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(response.status, 200)
  assert.equal(seen.length, 2)
  assert.equal(auth.calls.length, 2)
  assert.deepEqual(auth.calls[1], { forceRefresh: true })
  assert.equal(forwarder.stats.authRetries, 1)
})

test('持续 401：刷新重试后仍 401，保留 401 状态码供 Magpie 识别', async (t) => {
  const { forwarder, seen } = setup(t, {
    upstream: () => new Response('{"error":{"message":"token expired"}}', { status: 401 }),
  })
  const response = await forwarder.chat({ model: 'qwen4-max', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(response.status, 401)
  assert.equal(seen.length, 2)
  assert.equal(forwarder.stats.authRetries, 1)
})

test('付费确认：默认 402 拒绝；autoConfirmPaid 时带 Cosy-Paid-Confirmed 重试', async (t) => {
  const paidBody = JSON.stringify({ error: { message: 'paid model', subCode: 'MODEL_PAID_CONFIRM_REQUIRED' } })
  const refuse = setup(t, { upstream: () => new Response(paidBody, { status: 400 }) })
  const denied = await refuse.forwarder.chat({ model: 'qmodel_latest', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(denied.status, 402)
  const deniedBody = await denied.json()
  assert.equal(deniedBody.error.code, 'model_paid_confirm_required')
  assert.equal(refuse.seen.length, 1)

  const allowed = setup(t, {
    config: { autoConfirmPaid: true },
    upstream: (n, init) => {
      if (n === 1) return new Response(paidBody, { status: 400 })
      assert.equal(init.headers['Cosy-Paid-Confirmed'], 'true')
      return sseResponse(OK_EVENTS)
    },
  })
  const ok = await allowed.forwarder.chat({ model: 'qmodel_latest', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(ok.status, 200)
  assert.equal(allowed.seen.length, 2)
  assert.equal(allowed.forwarder.stats.paidRetries, 1)
})

test('上游错误脱敏：dt-/Bearer 片段不回传', async (t) => {
  const { forwarder } = setup(t, {
    upstream: () => new Response(JSON.stringify({ error: { message: 'token dt-abcdef123456789 invalid, Bearer sk-abcdefghijklmnop1234' } }), { status: 400 }),
  })
  const response = await forwarder.chat({ model: 'qwen4-max', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(response.status, 400)
  const body = await response.json()
  assert.equal(body.error.message.includes('dt-abcdef123456789'), false)
  assert.equal(body.error.message.includes('sk-abcdefghijklmnop1234'), false)
  assert.match(body.error.message, /\[REDACTED\]/)
  assert.equal(forwarder.stats.lastError.includes('dt-abcdef123456789'), false)
})

test('sanitizeText 覆盖常见凭证形态', () => {
  const text = 'dt-abcdefgh123 drt-abcdefgh123 gho_abcdefgh123 Bearer abc.def.ghi sk-abcdefghijklmnop1234 key-abcdefghijklmnop1234'
  const clean = sanitizeText(text)
  for (const secret of ['dt-abcdefgh123', 'drt-abcdefgh123', 'gho_abcdefgh123', 'abc.def.ghi', 'sk-abcdefghijklmnop1234', 'key-abcdefghijklmnop1234']) {
    assert.equal(clean.includes(secret), false)
  }
})

test('流中 response.failed：下发错误帧后收尾', async (t) => {
  const { forwarder } = setup(t, {
    upstream: () => sseResponse([
      { type: 'response.output_text.delta', delta: '半句' },
      { type: 'response.failed', response: { last_error: { message: '上游内部错误' } } },
    ]),
  })
  const response = await forwarder.chat({ model: 'qwen4-max', stream: true, messages: [{ role: 'user', content: 'hi' }] })
  const frames = await readChatSse(response)
  const error = frames.find((f) => f !== '[DONE]' && f.error)
  assert.match(error.error.message, /上游内部错误/)
  assert.equal(frames.at(-1), '[DONE]')
})

test('fetch 入口：/models、坏 JSON、会话头传递', async (t) => {
  const { forwarder, seen } = setup(t, { upstream: () => sseResponse(OK_EVENTS) })
  const models = await forwarder.fetch('http://127.0.0.1:9/v1/models')
  const list = await models.json()
  assert.equal(list.object, 'list')
  assert.ok(list.data.some((m) => m.id === 'qwen4-max'))
  assert.ok(list.data.some((m) => m.id === 'qfmodel'))

  const bad = await forwarder.fetch('http://127.0.0.1:9/v1/chat/completions', { method: 'POST', body: '{bad json' })
  assert.equal(bad.status, 400)

  const body = { model: 'qwen4-max', messages: [{ role: 'user', content: 'hi' }] }
  const ok = await forwarder.fetch('http://127.0.0.1:9/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { [SESSION_HEADER]: 'dsh-session-42' },
  })
  assert.equal(ok.status, 200)
  assert.equal(seen.at(-1).headers['X-Session-Id'], deriveSessionId(body, 'dsh-session-42'))
  // 内部会话头不能发给上游。
  assert.equal(SESSION_HEADER in seen.at(-1).headers, false)
})

test('客户端已断开：返回 499 且不打下游', async (t) => {
  const { forwarder, seen } = setup(t, {
    upstream: (n, init) => {
      if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      return sseResponse(OK_EVENTS)
    },
  })
  const controller = new AbortController()
  controller.abort()
  const response = await forwarder.chat({ model: 'qwen4-max', messages: [{ role: 'user', content: 'hi' }] }, { signal: controller.signal })
  assert.equal(response.status, 499)
  assert.equal(seen.length, 0)
})

test('未知模型 id 原样透传；qfmodel 用目录档位（medium 合法）', async (t) => {
  const { forwarder, seen } = setup(t, { upstream: () => sseResponse(OK_EVENTS) })
  await forwarder.chat({ model: 'brand-new-model', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'medium' })
  assert.equal(seen[0].body.model, 'brand-new-model')
  // 无模型信息时档位原样透传，由上游裁决。
  assert.deepEqual(seen[0].body.reasoning, { effort: 'medium' })

  await forwarder.chat({ model: 'qfmodel', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'medium' })
  assert.equal(seen[1].body.model, 'qfmodel')
  assert.deepEqual(seen[1].body.reasoning, { effort: 'medium' })
})

// ---- 审查回归 ----

test('流式返回后客户端再 abort：上游信号仍被中止（不继续烧额度）', async (t) => {
  const encoder = new TextEncoder()
  const { forwarder, seen } = setup(t, {
    upstream: () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"response.created"}\n\n'))
        // 保持打开，模拟上游还在生成。
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  })
  const client = new AbortController()
  const response = await forwarder.chat(
    { model: 'qwen4-max', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    { signal: client.signal },
  )
  assert.equal(response.status, 200)
  assert.equal(seen[0].signal.aborted, false)
  client.abort()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(seen[0].signal.aborted, true)
})

test('fetch 入口：Uint8Array body 可解析；未知路径 404', async (t) => {
  const { forwarder, seen } = setup(t, { upstream: () => sseResponse(OK_EVENTS) })
  const body = { model: 'qwen4-max', messages: [{ role: 'user', content: 'hi' }] }
  const ok = await forwarder.fetch('http://127.0.0.1:9/v1/chat/completions', {
    method: 'POST',
    body: new TextEncoder().encode(JSON.stringify(body)),
  })
  assert.equal(ok.status, 200)
  assert.equal(seen[0].body.model, 'qmodel_latest')
  assert.deepEqual(seen[0].body.input[0].content, [{ type: 'input_text', text: 'hi' }])

  const notFound = await forwarder.fetch('http://127.0.0.1:9/v1/embeddings', { method: 'POST', body: '{}' })
  assert.equal(notFound.status, 404)
})

test('上游超大非 JSON 错误体：错误消息被截断，不放大进响应/日志', async (t) => {
  const huge = 'x'.repeat(1024 * 1024)
  const { forwarder } = setup(t, { upstream: () => new Response(huge, { status: 502 }) })
  const response = await forwarder.chat({ model: 'qwen4-max', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(response.status, 502)
  const body = await response.json()
  assert.ok(body.error.message.length <= 600, `message length ${body.error.message.length}`)
  assert.ok(forwarder.stats.lastError.length <= 600)
})

test('region 漂移：auth.region 纠正后网关跟随（global token 不发 CN 网关）', async (t) => {
  const auth = fakeAuth()
  const seen = []
  const forwarder = createForwarder({
    auth,
    logger: { info() {}, warn() {}, error() {} },
    fetchImpl: async (url, init) => {
      seen.push(url)
      return sseResponse(OK_EVENTS)
    },
  })
  await forwarder.chat({ model: 'qwen4-max', messages: [{ role: 'user', content: 'hi' }] })
  assert.match(seen[0], /^https:\/\/gateway\.qoder\.com\.cn\//)
  auth.region = 'global'
  await forwarder.chat({ model: 'qwen4-max', messages: [{ role: 'user', content: 'hi' }] })
  assert.match(seen[1], /^https:\/\/api2\.qoder\.sh\//)
  assert.match(forwarder.gatewayBaseUrl, /^https:\/\/api2\.qoder\.sh\//)
})

test('错误 code 字段脱敏：dt- 片段不回传客户端', async (t) => {
  const { forwarder } = setup(t, {
    upstream: () => new Response(JSON.stringify({ error: { message: 'bad request', code: 'dt-abcdef123456789' } }), { status: 400 }),
  })
  const response = await forwarder.chat({ model: 'qwen4-max', messages: [{ role: 'user', content: 'hi' }] })
  const body = await response.json()
  assert.equal(body.error.code.includes('dt-abcdef123456789'), false)
})