import test from 'node:test'
import assert from 'node:assert/strict'
import {
  chatToResponses,
  contentText,
  createResponseTranslator,
  deriveSessionId,
  inlineImage,
  mapUsage,
  splitContent,
  sseEvents,
} from '../src/translate.mjs'

const MODEL_INFO = {
  reasoningEfforts: { off: 'none', low: 'low', high: 'high', xhigh: 'xhigh' },
  maxTokens: 128_000,
  input: ['text', 'image'],
}

test('chatToResponses：system→instructions，消息→input，工具→Responses 形状', async () => {
  const { payload, effort, toolCount } = await chatToResponses({
    model: 'qwen4-max',
    messages: [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '北京天气？' },
    ],
    tools: [{ type: 'function', function: { name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
    tool_choice: 'auto',
    reasoning_effort: 'low',
    max_tokens: 2048,
    temperature: 0.7,
    top_p: 0.9,
  }, { model: 'qmodel_latest', modelInfo: MODEL_INFO })

  assert.equal(payload.model, 'qmodel_latest')
  assert.equal(payload.instructions, '你是助手')
  assert.equal(payload.stream, true)
  assert.equal(payload.store, false)
  assert.deepEqual(payload.metadata, { session_type: 'qcode' })
  assert.deepEqual(payload.input, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '北京天气？' }] }])
  assert.deepEqual(payload.tools, [{ type: 'function', name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } }])
  assert.equal(payload.tool_choice, 'auto')
  assert.deepEqual(payload.reasoning, { effort: 'low' })
  assert.equal(payload.max_output_tokens, 2048)
  assert.equal(effort, 'low')
  assert.equal(toolCount, 1)
  // 上游不接受的字段不应出现。
  assert.equal('temperature' in payload, false)
  assert.equal('top_p' in payload, false)
  assert.equal('messages' in payload, false)
})

test('chatToResponses：assistant tool_calls 与 tool 结果按 call_id 配对', async () => {
  const { payload } = await chatToResponses({
    messages: [
      { role: 'user', content: '天气' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '晴 25°C' },
    ],
  }, { model: 'qmodel_latest', modelInfo: MODEL_INFO })
  assert.deepEqual(payload.input, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '天气' }] },
    { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"北京"}' },
    { type: 'function_call_output', call_id: 'call_1', output: '晴 25°C' },
  ])
})

test('chatToResponses：丢失 id 的 tool 结果按顺序配对；孤儿结果降级为 user 文本', async () => {
  const { payload } = await chatToResponses({
    messages: [
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_a', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', content: '结果A' },
      { role: 'tool', tool_call_id: 'call_unknown', content: '孤儿结果' },
    ],
  }, { model: 'qmodel_latest', modelInfo: MODEL_INFO })
  assert.equal(payload.input[1].type, 'function_call_output')
  assert.equal(payload.input[1].call_id, 'call_a')
  assert.equal(payload.input[2].type, 'message')
  assert.equal(payload.input[2].role, 'user')
  assert.match(payload.input[2].content[0].text, /孤儿结果/)
})

test('chatToResponses：tool_choice 各形态', async () => {
  const tools = [{ type: 'function', function: { name: 'f', parameters: {} } }, { type: 'function', function: { name: 'g', parameters: {} } }]
  const none = await chatToResponses({ messages: [{ role: 'user', content: 'hi' }], tools, tool_choice: 'none' }, { model: 'm', modelInfo: MODEL_INFO })
  assert.equal(none.payload.tools, undefined)
  assert.equal(none.toolCount, 0)
  const required = await chatToResponses({ messages: [{ role: 'user', content: 'hi' }], tools, tool_choice: 'required' }, { model: 'm', modelInfo: MODEL_INFO })
  assert.equal(required.payload.tool_choice, 'required')
  const named = await chatToResponses({ messages: [{ role: 'user', content: 'hi' }], tools, tool_choice: { type: 'function', function: { name: 'g' } } }, { model: 'm', modelInfo: MODEL_INFO })
  assert.deepEqual(named.payload.tool_choice, { type: 'function', name: 'g' })
  assert.deepEqual(named.payload.tools.map((t) => t.name), ['g'])
})

test('chatToResponses：思考档位钳制（medium→high，none 保留，缺省 high）', async () => {
  const base = { messages: [{ role: 'user', content: 'hi' }] }
  const medium = await chatToResponses({ ...base, reasoning_effort: 'medium' }, { model: 'm', modelInfo: MODEL_INFO })
  assert.equal(medium.effort, 'high')
  const off = await chatToResponses({ ...base, reasoningEffort: 'off' }, { model: 'm', modelInfo: MODEL_INFO })
  assert.deepEqual(off.payload.reasoning, { effort: 'none' })
  const missing = await chatToResponses(base, { model: 'm', modelInfo: MODEL_INFO })
  assert.equal(missing.effort, 'high')
  const nested = await chatToResponses({ ...base, reasoning: { effort: 'xhigh' } }, { model: 'm', modelInfo: MODEL_INFO })
  assert.equal(nested.effort, 'xhigh')
  // 模型关不掉思考时 none → 最低档。
  const noOff = await chatToResponses({ ...base, reasoning_effort: 'none' }, { model: 'm', modelInfo: { reasoningEfforts: { low: 'low', high: 'high' } } })
  assert.equal(noOff.effort, 'low')
})

test('chatToResponses：图片内联（data URL 保留，http 下载转 data）与数量上限', async () => {
  const dataUrl = 'data:image/png;base64,aGVsbG8='
  const seen = []
  const fetchImpl = async (url) => {
    seen.push(url)
    return new Response(Buffer.from('img'), { status: 200, headers: { 'content-type': 'image/jpeg' } })
  }
  const lookupImpl = async () => [{ address: '93.184.216.34', family: 4 }]
  const { payload, imageCount } = await chatToResponses({
    messages: [{ role: 'user', content: [
      { type: 'text', text: '看看' },
      { type: 'image_url', image_url: { url: dataUrl } },
      { type: 'image_url', image_url: { url: 'https://example.test/a.jpg' } },
    ] }],
  }, { model: 'm', modelInfo: MODEL_INFO, fetchImpl, lookupImpl })
  assert.equal(imageCount, 2)
  assert.deepEqual(seen, ['https://example.test/a.jpg'])
  const parts = payload.input[0].content
  assert.equal(parts[0].type, 'input_text')
  assert.equal(parts[1].image_url, dataUrl)
  assert.equal(parts[2].image_url, `data:image/jpeg;base64,${Buffer.from('img').toString('base64')}`)

  await assert.rejects(() => chatToResponses({
    messages: [{ role: 'user', content: Array.from({ length: 5 }, () => ({ type: 'image_url', image_url: { url: dataUrl } })) }],
  }, { model: 'm', modelInfo: MODEL_INFO }), /图片数量超过上限/)

  await assert.rejects(() => chatToResponses({
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl } }] }],
  }, { model: 'm', modelInfo: { input: ['text'] } }), /不支持图片输入/)
})

test('inlineImage：超大 data URL 拒绝', async () => {
  const big = `data:image/png;base64,${'A'.repeat(4 * 1024 * 1024)}`
  await assert.rejects(() => inlineImage(big, { maxBytes: 1024 }), /上限/)
})

test('deriveSessionId：同一对话稳定，不同对话不同；原始 key 不外泄', () => {
  const body = { messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], prompt_cache_key: 'secret-key' }
  const a = deriveSessionId(body)
  const b = deriveSessionId({ ...body, messages: [...body.messages, { role: 'assistant', content: 'x' }] })
  assert.equal(a, b)
  assert.notEqual(a, deriveSessionId({ messages: [{ role: 'user', content: '别的对话' }] }))
  assert.equal(a.includes('secret-key'), false)
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  const named = deriveSessionId(body, 'dsh-session-1')
  assert.equal(named, deriveSessionId({ messages: [] }, 'dsh-session-1'))
  assert.notEqual(named, a)
})

test('splitContent / contentText 兼容多种内容块', () => {
  assert.equal(contentText('abc'), 'abc')
  assert.equal(contentText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'ab')
  const { text, images } = splitContent([
    { type: 'text', text: '看图' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } },
    { type: 'input_image', image_url: 'https://e.test/i.png' },
    { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'yyyy' } },
  ])
  assert.equal(text, '看图')
  assert.deepEqual(images, ['data:image/png;base64,x', 'https://e.test/i.png', 'data:image/webp;base64,yyyy'])
})

// ---- 响应方向 ----

const TOOL_LOOP_EVENTS = [
  { type: 'response.created', response: { id: 'resp_1' } },
  { type: 'response.output_item.added', output_index: 0, item: { id: 'rs_1', type: 'reasoning' } },
  { type: 'response.reasoning_text.delta', item_id: 'rs_1', delta: '让我想想' },
  { type: 'response.reasoning_text.delta', item_id: 'rs_1', delta: '…调用工具' },
  { type: 'response.output_item.added', output_index: 1, item: { id: 'fc_1', type: 'function_call', call_id: 'call_abc', name: 'get_weather', arguments: '' } },
  { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: '{"city":' },
  { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: '"北京"}' },
  { type: 'response.function_call_arguments.done', item_id: 'fc_1', output_index: 1, arguments: '{"city":"北京"}' },
  { type: 'response.output_item.done', output_index: 1, item: { id: 'fc_1', type: 'function_call', call_id: 'call_abc', name: 'get_weather', arguments: '{"city":"北京"}' } },
  { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150, output_tokens_details: { reasoning_tokens: 12 } } } },
]

test('翻译器：思考增量→reasoning_content，工具增量→tool_calls，usage 真实值', () => {
  const translator = createResponseTranslator()
  const pieces = []
  for (const event of TOOL_LOOP_EVENTS) pieces.push(...translator.push(event))

  const reasoning = pieces.filter((p) => p.delta.reasoning_content).map((p) => p.delta.reasoning_content).join('')
  assert.equal(reasoning, '让我想想…调用工具')

  const toolStart = pieces.find((p) => p.delta.tool_calls?.[0]?.id)
  assert.equal(toolStart.delta.tool_calls[0].id, 'call_abc')
  assert.equal(toolStart.delta.tool_calls[0].function.name, 'get_weather')
  const args = pieces.filter((p) => p.delta.tool_calls?.[0]?.function?.arguments).map((p) => p.delta.tool_calls[0].function.arguments).join('')
  assert.equal(args, '{"city":"北京"}')

  const final = pieces.at(-1)
  assert.equal(final.finish_reason, 'tool_calls')
  assert.deepEqual(final.usage, { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, completion_tokens_details: { reasoning_tokens: 12 } })
  assert.equal(translator.state.completed, true)

  const result = translator.result()
  assert.deepEqual(result.toolCalls, [{ id: 'call_abc', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }])
  assert.equal(result.finish, 'tool_calls')
})

test('翻译器：正文增量与 completed→stop；incomplete(max tokens)→length', () => {
  const translator = createResponseTranslator()
  const pieces = []
  for (const event of [
    { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_1', type: 'message', role: 'assistant' } },
    { type: 'response.output_text.delta', item_id: 'msg_1', delta: '你好' },
    { type: 'response.output_text.delta', item_id: 'msg_1', delta: '！' },
    { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } },
  ]) pieces.push(...translator.push(event))
  assert.equal(pieces.filter((p) => p.delta.content).map((p) => p.delta.content).join(''), '你好！')
  assert.equal(pieces.at(-1).finish_reason, 'stop')
  assert.equal(translator.result().content, '你好！')

  const short = createResponseTranslator()
  short.push({ type: 'response.output_text.delta', delta: '半句' })
  const tail = short.push({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } })
  assert.equal(tail.at(-1).finish_reason, 'length')
})

test('翻译器：只有 done 没有 delta 时兜底补发全文与参数', () => {
  const translator = createResponseTranslator()
  const pieces = []
  for (const event of [
    { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_1', type: 'message', content: [{ type: 'output_text', text: '完整正文' }] } },
    { type: 'response.output_item.done', output_index: 1, item: { id: 'fc_1', type: 'function_call', call_id: 'call_x', name: 'f', arguments: '{"a":1}' } },
    { type: 'response.completed', response: { status: 'completed' } },
  ]) pieces.push(...translator.push(event))
  assert.equal(pieces.find((p) => p.delta.content)?.delta.content, '完整正文')
  const toolPieces = pieces.filter((p) => p.delta.tool_calls)
  assert.equal(toolPieces[0].delta.tool_calls[0].function.name, 'f')
  assert.equal(toolPieces.map((p) => p.delta.tool_calls[0].function.arguments ?? '').join(''), '{"a":1}')
  assert.equal(pieces.at(-1).finish_reason, 'tool_calls')
})

test('翻译器：failed/error 事件记录错误；finalize 兜底收尾', () => {
  const failed = createResponseTranslator()
  failed.push({ type: 'response.failed', response: { last_error: { message: '上游炸了' } } })
  assert.equal(failed.state.errored, '上游炸了')
  assert.equal(failed.finalize(), null)

  const cut = createResponseTranslator()
  cut.push({ type: 'response.output_text.delta', delta: '断流前' })
  const tail = cut.finalize()
  assert.equal(tail.finish_reason, 'stop')
  assert.equal(cut.result().content, '断流前')
})

test('翻译器：delta 先到（无 added）时 done 不重复补发全文', () => {
  const translator = createResponseTranslator()
  const pieces = []
  for (const event of [
    { type: 'response.output_text.delta', item_id: 'msg_1', delta: '你好' },
    { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_1', type: 'message', content: [{ type: 'output_text', text: '你好' }] } },
    { type: 'response.completed', response: { status: 'completed' } },
  ]) pieces.push(...translator.push(event))
  assert.equal(pieces.filter((p) => p.delta.content).map((p) => p.delta.content).join(''), '你好')
  assert.equal(translator.result().content, '你好')
})

test('mapUsage：缺字段兜底与缓存明细', () => {
  assert.equal(mapUsage(null), null)
  assert.deepEqual(mapUsage({ input_tokens: 10, output_tokens: 4 }), { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 })
  assert.deepEqual(mapUsage({ input_tokens: 10, output_tokens: 4, total_tokens: 14, input_tokens_details: { cached_tokens: 8 } }), {
    prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_tokens_details: { cached_tokens: 8 },
  })
})

test('sseEvents：跨块拼帧、CRLF、坏帧跳过', async () => {
  const text = 'event: response.created\r\ndata: {"type":"response.created"}\r\n\r\ndata: {"type":"response.output_text.delta","delta":"a"}\n\ndata: not-json\n\ndata: {"type":"response.completed"}\n\n'
  const bytes = Buffer.from(text, 'utf8')
  // 切成小块模拟网络分片。
  const chunks = []
  for (let i = 0; i < bytes.length; i += 7) chunks.push(bytes.subarray(i, i + 7))
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  const events = []
  for await (const event of sseEvents(body)) events.push(event)
  assert.deepEqual(events.map((e) => e.type), ['response.created', 'response.output_text.delta', 'response.completed'])
})

// ---- 审查回归 ----

test('sseEvents：结尾无空行的尾帧不丢（usage 保留）', async () => {
  const text = 'data: {"type":"response.output_text.delta","delta":"a"}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}\n'
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from(text, 'utf8'))
      controller.close()
    },
  })
  const events = []
  for await (const event of sseEvents(body)) events.push(event)
  assert.equal(events.at(-1).type, 'response.completed')
  assert.equal(events.at(-1).response.usage.total_tokens, 4)
})

test('sseEvents：提前 break 会取消上游 body', async () => {
  let cancelled = false
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from('data: {"type":"response.created"}\n\n', 'utf8'))
      // 保持打开，模拟上游在 completed 后不关连接。
    },
    cancel() {
      cancelled = true
    },
  })
  for await (const event of sseEvents(body)) {
    if (event.type === 'response.created') break
  }
  assert.equal(cancelled, true)
})

test('翻译器：incomplete(max_output_tokens) 带半截工具参数 → length 而非 tool_calls', () => {
  const translator = createResponseTranslator()
  translator.push({ type: 'response.output_item.added', output_index: 0, item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'write', arguments: '' } })
  translator.push({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"path":"a.txt","conte' })
  const pieces = translator.push({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } })
  assert.equal(pieces.at(-1).finish_reason, 'length')
  assert.equal(translator.result().finish, 'length')
  const filter = createResponseTranslator()
  const filtered = filter.push({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'content_filter' } } })
  assert.equal(filtered.at(-1).finish_reason, 'content_filter')
})

test('翻译器：未具名工具先缓冲，done 具名后一次性补发；始终无名则丢弃', () => {
  const translator = createResponseTranslator()
  const pieces = []
  for (const event of [
    { type: 'response.output_item.added', output_index: 0, item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"a":' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '1}' },
  ]) pieces.push(...translator.push(event))
  // 名字未知前不得下发任何 tool_calls 头。
  assert.equal(pieces.length, 0)
  for (const event of [
    { type: 'response.output_item.done', output_index: 0, item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'f', arguments: '{"a":1}' } },
    { type: 'response.completed', response: { status: 'completed' } },
  ]) pieces.push(...translator.push(event))
  const toolPieces = pieces.filter((p) => p.delta.tool_calls)
  assert.equal(toolPieces[0].delta.tool_calls[0].function.name, 'f')
  assert.equal(toolPieces.map((p) => p.delta.tool_calls[0].function.arguments ?? '').join(''), '{"a":1}')
  assert.equal(pieces.at(-1).finish_reason, 'tool_calls')

  const nameless = createResponseTranslator()
  nameless.push({ type: 'response.output_item.added', output_index: 0, item: { id: 'fc_x', type: 'function_call', call_id: 'call_x', arguments: '' } })
  nameless.push({ type: 'response.function_call_arguments.delta', item_id: 'fc_x', delta: '{}' })
  nameless.push({ type: 'response.completed', response: { status: 'completed' } })
  assert.match(nameless.state.errored, /未具名/)
  assert.equal(nameless.result().toolCalls, null)
})

test('翻译器：output_index 复用但 item_id 不同 → 两个独立调用', () => {
  const translator = createResponseTranslator()
  translator.push({ type: 'response.output_item.added', output_index: 0, item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'f', arguments: '' } })
  translator.push({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '{"x":1}' })
  translator.push({ type: 'response.output_item.added', output_index: 0, item: { id: 'fc_2', type: 'function_call', call_id: 'call_2', name: 'g', arguments: '' } })
  translator.push({ type: 'response.function_call_arguments.delta', item_id: 'fc_2', output_index: 0, delta: '{"y":2}' })
  translator.push({ type: 'response.completed', response: { status: 'completed' } })
  const calls = translator.result().toolCalls
  assert.equal(calls.length, 2)
  assert.equal(calls[0].function.arguments, '{"x":1}')
  assert.equal(calls[1].function.arguments, '{"y":2}')
})

test('chatToResponses：小预算未指定档位 → none；显式档位不受影响', async () => {
  const small = await chatToResponses({ messages: [{ role: 'user', content: '起个标题' }], max_tokens: 64 }, { model: 'm', modelInfo: MODEL_INFO })
  assert.deepEqual(small.payload.reasoning, { effort: 'none' })
  const explicit = await chatToResponses({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 64, reasoning_effort: 'high' }, { model: 'm', modelInfo: MODEL_INFO })
  assert.deepEqual(explicit.payload.reasoning, { effort: 'high' })
  const normal = await chatToResponses({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 4096 }, { model: 'm', modelInfo: MODEL_INFO })
  assert.deepEqual(normal.payload.reasoning, { effort: 'high' })
})

test('chatToResponses：悬空 function_call 自动补中断输出；非推理模型不发 reasoning', async () => {
  const { payload } = await chatToResponses({
    messages: [
      { role: 'user', content: '写文件' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_d', function: { name: 'write', arguments: '{}' } }] },
      { role: 'user', content: '算了，继续' },
    ],
  }, { model: 'm', modelInfo: MODEL_INFO })
  const output = payload.input.find((item) => item.type === 'function_call_output')
  assert.equal(output.call_id, 'call_d')
  assert.match(output.output, /中断/)

  const nonReasoning = await chatToResponses({ messages: [{ role: 'user', content: 'hi' }] }, { model: 'm', modelInfo: { reasoningEfforts: {} } })
  assert.equal('reasoning' in nonReasoning.payload, false)
})

test('chatToResponses：tool_choice 具名但工具不存在 → 400', async () => {
  await assert.rejects(() => chatToResponses({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'f', parameters: {} } }],
    tool_choice: { type: 'function', function: { name: 'not_exist' } },
  }, { model: 'm', modelInfo: MODEL_INFO }), /不在 tools 列表/)
})

test('inlineImage：SSRF 防护——回环/内网/元数据地址拒绝，非图片 content-type 拒绝', async () => {
  let fetched = 0
  const fetchImpl = async () => {
    fetched += 1
    return new Response('secret', { status: 200, headers: { 'content-type': 'text/plain' } })
  }
  for (const url of ['http://127.0.0.1:62795/api/secret', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/a.png', 'http://[::1]:9/x', 'http://localhost/a.png', 'ftp://x/a.png']) {
    await assert.rejects(() => inlineImage(url, { fetchImpl }), /拒绝|不支持/)
  }
  assert.equal(fetched, 0)
  // 公网域名解析到内网也拒绝（DNS rebinding）。
  await assert.rejects(() => inlineImage('https://evil.test/a.png', { fetchImpl, lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }] }), /拒绝/)
  assert.equal(fetched, 0)
  // 公网地址但返回 text/plain → 拒绝。
  await assert.rejects(() => inlineImage('https://public.test/a.png', { fetchImpl, lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }] }), /不是图片/)
  assert.equal(fetched, 1)
  // 坏 data URL → 400 而不是 502。
  await assert.rejects(() => inlineImage('data:text/plain,%zz'), (error) => error.statusCode === 400)
})