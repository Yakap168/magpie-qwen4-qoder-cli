/**
 * 端到端自测：用真实 Qwen Code 凭证直连 Qoder 网关。
 * 运行：node scripts/selftest.mjs
 * 覆盖：目录拉取 / 流式文本 / 思考增量 / 原生工具两轮回环 / 非流式 / 图片 / 免费模型。
 * 不打印任何 token；失败时给出脱敏错误。
 */
import { Buffer } from 'node:buffer'
import { deflateSync } from 'node:zlib'
import { QwenCodeDirectPlugin, _internal } from '../index.mjs'
import { sanitizeText } from '../src/forward.mjs'

const { forwarder, refreshCatalog } = _internal
const results = []

function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 读聊天 SSE，聚合出完整结果。 */
async function collectStream(response) {
  if (response.status !== 200) {
    const text = await response.text()
    throw new Error(`HTTP ${response.status}: ${sanitizeText(text).slice(0, 300)}`)
  }
  const started = Date.now()
  let firstByteMs = null
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let reasoning = ''
  let usage = null
  let finish = null
  const tools = []
  let frames = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (firstByteMs === null) firstByteMs = Date.now() - started
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
    let index
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const line = raw.split('\n').find((l) => l.startsWith('data:'))
      if (!line) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') continue
      let frame
      try {
        frame = JSON.parse(data)
      } catch {
        continue
      }
      frames += 1
      if (frame.error) throw new Error(`流内错误：${sanitizeText(frame.error.message)}`)
      const choice = frame.choices?.[0]
      if (!choice) continue
      const delta = choice.delta ?? {}
      if (typeof delta.content === 'string') content += delta.content
      if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content
      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          const slot = tools[call.index] ?? (tools[call.index] = { id: '', name: '', args: '' })
          if (call.id) slot.id = call.id
          if (call.function?.name) slot.name += call.function.name
          if (typeof call.function?.arguments === 'string') slot.args += call.function.arguments
        }
      }
      if (choice.finish_reason) finish = choice.finish_reason
      if (frame.usage) usage = frame.usage
    }
  }
  return { content, reasoning, tools, usage, finish, frames, firstByteMs, totalMs: Date.now() - started }
}

/** 通过插件真实 loader.fetch 发请求（与 Magpie 运行时同一条路径）。 */
async function chatViaPlugin(body) {
  const hooks = await QwenCodeDirectPlugin()
  const cfg = { provider: {} }
  await hooks.config(cfg)
  const loader = await hooks.auth.loader(async () => ({ type: 'api', key: 'local' }))
  return loader.fetch('http://127.0.0.1:9/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** 生成纯色 PNG（不依赖图像库）。 */
function solidPng(width, height, [r, g, b]) {
  const crcTable = []
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  const crc32 = (buf) => {
    let c = 0xffffffff
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2 // truecolor
  const raw = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3)
    raw[row] = 0
    for (let x = 0; x < width; x += 1) {
      raw[row + 1 + x * 3] = r
      raw[row + 2 + x * 3] = g
      raw[row + 3 + x * 3] = b
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

async function main() {
  console.log('== magpie-qwen4-qoder-cli 3.0.1 直接转发端到端自测 ==')

  // 1. 模型目录
  try {
    const models = await refreshCatalog()
    if (!models || models.length === 0) throw new Error('目录为空')
    record('模型目录', true, models.map((m) => `${m.id}(ctx=${m.contextWindow}${m.isFree ? ',免费' : ''})`).join(' '))
  } catch (error) {
    record('模型目录', false, sanitizeText(error.message))
  }

  // 2. 流式文本（关思考，最快路径）
  try {
    const response = await chatViaPlugin({
      model: 'qwen4-max',
      stream: true,
      reasoning_effort: 'none',
      messages: [{ role: 'user', content: '只回复两个字母：OK' }],
    })
    const result = await collectStream(response)
    const ok = /OK/i.test(result.content) && result.finish === 'stop' && result.usage?.total_tokens > 0
    record('流式文本(别名 qwen4-max, effort=none)', ok, `首字节 ${result.firstByteMs}ms 总 ${result.totalMs}ms 帧 ${result.frames} usage=${JSON.stringify(result.usage)} 正文="${result.content.trim().slice(0, 40)}"`)
  } catch (error) {
    record('流式文本(别名 qwen4-max, effort=none)', false, sanitizeText(error.message))
  }

  // 3. 思考增量（reasoning_content）
  try {
    const response = await chatViaPlugin({
      model: 'qmodel_latest',
      stream: true,
      reasoning_effort: 'low',
      messages: [{ role: 'user', content: '9.11 和 9.9 哪个大？一句话回答。' }],
    })
    const result = await collectStream(response)
    const ok = result.reasoning.length > 0 && result.content.length > 0
    record('思考增量 reasoning_content', ok, `思考 ${result.reasoning.length} 字符 正文="${result.content.trim().slice(0, 60)}"`)
  } catch (error) {
    record('思考增量 reasoning_content', false, sanitizeText(error.message))
  }

  // 4. 原生工具两轮回环
  try {
    const tools = [{
      type: 'function',
      function: {
        name: 'get_weather',
        description: '查询指定城市的当前天气',
        parameters: { type: 'object', properties: { city: { type: 'string', description: '城市名' } }, required: ['city'] },
      },
    }]
    const first = await collectStream(await chatViaPlugin({
      model: 'qmodel_latest',
      stream: true,
      reasoning_effort: 'none',
      messages: [{ role: 'user', content: '北京现在天气怎么样？用工具查。' }],
      tools,
      tool_choice: 'auto',
    }))
    const call = first.tools[0]
    if (first.finish !== 'tool_calls' || !call?.name) throw new Error(`第一轮未返回 tool_calls（finish=${first.finish}）`)
    const args = JSON.parse(call.args)
    const second = await collectStream(await chatViaPlugin({
      model: 'qmodel_latest',
      stream: true,
      reasoning_effort: 'none',
      messages: [
        { role: 'user', content: '北京现在天气怎么样？用工具查。' },
        { role: 'assistant', content: null, tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: call.args } }] },
        { role: 'tool', tool_call_id: call.id, content: '{"weather":"晴","temp_c":25}' },
      ],
      tools,
    }))
    const ok = /晴|25/.test(second.content) && second.finish === 'stop'
    record('原生工具两轮回环', ok, `第一轮 ${call.name}(${JSON.stringify(args)}) id=${call.id.slice(0, 12)}… 第二轮="${second.content.trim().slice(0, 60)}"`)
  } catch (error) {
    record('原生工具两轮回环', false, sanitizeText(error.message))
  }

  // 5. 非流式聚合
  try {
    const response = await chatViaPlugin({
      model: 'qfmodel',
      stream: false,
      reasoning_effort: 'none',
      messages: [{ role: 'user', content: '只回复两个字母：OK' }],
    })
    if (response.status !== 200) throw new Error(`HTTP ${response.status}: ${sanitizeText(await response.text()).slice(0, 200)}`)
    const body = await response.json()
    const ok = body.object === 'chat.completion' && /OK/i.test(body.choices?.[0]?.message?.content ?? '') && body.usage?.total_tokens > 0
    record('非流式聚合(qfmodel)', ok, `finish=${body.choices?.[0]?.finish_reason} usage=${JSON.stringify(body.usage)}`)
  } catch (error) {
    record('非流式聚合(qfmodel)', false, sanitizeText(error.message))
  }

  // 6. 图片输入（内联 data URL）
  try {
    const png = solidPng(16, 16, [220, 30, 30])
    const response = await chatViaPlugin({
      model: 'qmodel_latest',
      stream: true,
      reasoning_effort: 'none',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '这张图片是什么颜色？只答颜色。' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
        ],
      }],
    })
    const result = await collectStream(response)
    const ok = /红|red/i.test(result.content)
    record('图片输入(16x16 纯红 PNG)', ok, `回答="${result.content.trim().slice(0, 40)}"`)
  } catch (error) {
    record('图片输入(16x16 纯红 PNG)', false, sanitizeText(error.message))
  }

  // 7. 免费模型 + medium 档位
  try {
    const response = await chatViaPlugin({
      model: 'qfmodel',
      stream: true,
      reasoning_effort: 'medium',
      messages: [{ role: 'user', content: '只回复两个字母：OK' }],
    })
    const result = await collectStream(response)
    record('免费模型 qfmodel + medium', /OK/i.test(result.content), `思考 ${result.reasoning.length} 字符 usage=${JSON.stringify(result.usage)}`)
  } catch (error) {
    record('免费模型 qfmodel + medium', false, sanitizeText(error.message))
  }

  console.log('\n== 转发统计 ==')
  const stats = { ...forwarder.stats }
  delete stats.lastTraceId
  console.log(JSON.stringify(stats, null, 2))
  const failed = results.filter((r) => !r.ok)
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`)
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error('自测异常：', sanitizeText(error?.stack || String(error)))
  process.exit(1)
})