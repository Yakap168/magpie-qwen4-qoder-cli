/**
 * OpenAI Chat Completions ↔ Qoder Responses 协议翻译。
 *
 * Magpie（AI SDK openai-compatible）发来的是 Chat Completions；
 * Qwen Code 的 Qoder 网关说的是 OpenAI Responses。本模块只做双向翻译，
 * 不实现任何 agent 逻辑：工具由 Magpie/外层 Agent 执行，文件由它们读写。
 *
 * 请求方向：messages → instructions + input（message/function_call/
 * function_call_output），tools → Responses function tools，
 * reasoning_effort → reasoning.effort（按模型档位钳制）。
 * 响应方向：Responses SSE 事件 → chat.completion.chunk
 * （content / reasoning_content / tool_calls 增量），usage 取上游真实值。
 */
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { promises as dns } from 'node:dns'
import { clampEffort, newCallId, normalizeEffort } from './models.mjs'

/** 提取内容里的纯文本（string / 内容块数组）。多段文本直接拼接，不添加原文没有的换行。 */
export function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part.text === 'string') return part.text
        return ''
      })
      .filter(Boolean)
      .join('')
  }
  if (content == null) return ''
  return JSON.stringify(content)
}

/** 从内容块里取出图片 URL（兼容 image_url / input_image / image / Anthropic source）。 */
export function imageUrlsOfContent(content) {
  const urls = []
  if (!Array.isArray(content)) return urls
  for (const part of content) {
    if (!part || typeof part === 'string') continue
    const type = part.type
    if (type !== 'image_url' && type !== 'input_image' && type !== 'image') continue
    let url = null
    if (typeof part.image_url === 'string') url = part.image_url
    else if (part.image_url && typeof part.image_url.url === 'string') url = part.image_url.url
    else if (typeof part.url === 'string') url = part.url
    else if (typeof part.image === 'string') url = part.image
    else if (part.source?.type === 'base64' && typeof part.source.data === 'string') {
      url = `data:${part.source.media_type || 'image/png'};base64,${part.source.data}`
    }
    if (url) urls.push(url)
  }
  return urls
}

/** 把内容拆成文本与图片 URL 两部分。 */
export function splitContent(content) {
  return { text: contentText(content), images: imageUrlsOfContent(content) }
}

/** 判断 IPv4/IPv6 字面量是否属于回环/内网/链路本地等不可外发地址。 */
export function isPrivateAddress(address) {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(address))
  if (v4) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    return a === 0 || a === 10 || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0)
      || (a === 198 && (b === 18 || b === 19))
      || a >= 224
  }
  const lower = String(address).toLowerCase()
  if (lower === '::1' || lower === '::') return true
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true // fc00::/7
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true // fe80::/10
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower)
  if (mapped) return isPrivateAddress(mapped[1])
  return false
}

/** 校验图片 URL 必须是公网 http(s)；回环/内网/链路本地一律拒绝（防 SSRF）。 */
async function assertPublicImageUrl(url, lookupImpl) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw Object.assign(new Error('无法识别的图片 URL'), { statusCode: 400 })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw Object.assign(new Error('不支持的图片 URL（仅 data: 与公网 http(s):）'), { statusCode: 400 })
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || isPrivateAddress(host)) {
    throw Object.assign(new Error('拒绝回环/内网图片地址'), { statusCode: 400 })
  }
  if (!isPrivateAddress(host) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && !host.includes(':')) {
    // 域名：解析后仍可能落到内网（DNS rebinding），逐个地址检查。
    let addresses
    try {
      addresses = await lookupImpl(host, { all: true })
    } catch {
      throw Object.assign(new Error(`图片域名无法解析：${host}`), { statusCode: 400 })
    }
    if ((addresses ?? []).some((entry) => isPrivateAddress(entry.address))) {
      throw Object.assign(new Error('拒绝解析到回环/内网地址的图片域名'), { statusCode: 400 })
    }
  }
  return parsed
}

/**
 * 把公网 http(s) 图片下载并内联成 data URL（网关不一定替我们取外链）；
 * data URL 原样保留。安全约束：
 *   - 仅公网 http(s)，回环/内网/链路本地/云元数据地址拒绝（含 DNS 解析结果）
 *   - 重定向逐跳重新校验，最多 3 跳
 *   - 响应必须是 image/*；先查 content-length，再边读边限流，超过上限立即中止
 * @param {string} url
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number, maxBytes?: number, lookupImpl?: Function}} [options]
 */
export async function inlineImage(url, options = {}) {
  const { fetchImpl = fetch, timeoutMs = 30_000, maxBytes = 20 * 1024 * 1024, lookupImpl = dns.lookup } = options
  if (typeof url !== 'string' || !url) throw Object.assign(new Error('空的图片 URL'), { statusCode: 400 })
  if (url.startsWith('data:')) {
    const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(url)
    if (!match) throw Object.assign(new Error('无法识别的图片 data URL'), { statusCode: 400 })
    let bytes
    try {
      bytes = match[2] ? Math.floor(match[3].length * 3 / 4) : Buffer.byteLength(decodeURIComponent(match[3]), 'utf8')
    } catch {
      throw Object.assign(new Error('无法识别的图片 data URL'), { statusCode: 400 })
    }
    if (bytes > maxBytes) throw Object.assign(new Error(`图片超过 ${Math.round(maxBytes / 1024 / 1024)} MB 上限`), { statusCode: 413 })
    return url
  }
  let current = url
  for (let hop = 0; hop <= 3; hop += 1) {
    await assertPublicImageUrl(current, lookupImpl)
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : undefined
    const response = await fetchImpl(current, { ...(signal ? { signal } : {}), redirect: 'manual' })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      try {
        await response.body?.cancel()
      } catch {
        // 忽略
      }
      if (!location || hop === 3) throw Object.assign(new Error('图片重定向次数过多或缺少 Location'), { statusCode: 400 })
      current = new URL(location, current).href
      continue
    }
    if (!response.ok) throw Object.assign(new Error(`图片下载失败：HTTP ${response.status}`), { statusCode: 400 })
    const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    if (!mime.startsWith('image/')) throw Object.assign(new Error(`图片 URL 返回的不是图片（content-type=${mime || '未知'}）`), { statusCode: 400 })
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) {
      try {
        await response.body?.cancel()
      } catch {
        // 忽略
      }
      throw Object.assign(new Error(`图片超过 ${Math.round(maxBytes / 1024 / 1024)} MB 上限`), { statusCode: 413 })
    }
    const reader = response.body.getReader()
    const chunks = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > maxBytes) {
        try {
          await reader.cancel()
        } catch {
          // 忽略
        }
        throw Object.assign(new Error(`图片超过 ${Math.round(maxBytes / 1024 / 1024)} MB 上限`), { statusCode: 413 })
      }
      chunks.push(Buffer.from(value))
    }
    return `data:${mime};base64,${Buffer.concat(chunks).toString('base64')}`
  }
  throw Object.assign(new Error('图片重定向次数过多'), { statusCode: 400 })
}

/**
 * Chat Completions 请求体 → Qoder Responses 请求体。
 * @param {Record<string, any>} body Chat Completions 请求
 * @param {{
 *   model: string,
 *   modelInfo?: {reasoningEfforts?: Record<string,string>, maxTokens?: number, input?: string[]},
 *   defaultEffort?: string,
 *   sessionType?: string,
 *   fetchImpl?: typeof fetch,
 *   maxImages?: number,
 *   maxImageBytes?: number,
 *   imageFetchTimeoutMs?: number,
 *   lookupImpl?: Function,
 * }} options
 * @returns {Promise<{payload: Record<string, any>, effort: string, imageCount: number, toolCount: number}>}
 */
export async function chatToResponses(body, options = {}) {
  const {
    model,
    modelInfo,
    defaultEffort = 'high',
    sessionType = 'qcode',
    fetchImpl = fetch,
    maxImages = 4,
    maxImageBytes = 20 * 1024 * 1024,
    imageFetchTimeoutMs = 30_000,
    lookupImpl,
  } = options
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求体必须是 JSON 对象')
  const messages = Array.isArray(body.messages) ? body.messages : []
  // 非视觉模型提前拒绝，避免先把图片下载下来再报错。
  if (modelInfo && !(modelInfo.input ?? ['text']).includes('image')
    && messages.some((message) => imageUrlsOfContent(message?.content).length > 0)) {
    throw Object.assign(new Error(`模型 ${model} 不支持图片输入`), { statusCode: 400 })
  }
  const instructions = []
  const input = []
  /** 按出现顺序记录 assistant 发起的调用，供 tool 结果配对。 */
  const pending = []
  let imageCount = 0

  const imagePart = async (url) => {
    imageCount += 1
    if (imageCount > maxImages) throw Object.assign(new Error(`图片数量超过上限（最多 ${maxImages} 张）`), { statusCode: 400 })
    return { type: 'input_image', image_url: await inlineImage(url, { fetchImpl, timeoutMs: imageFetchTimeoutMs, maxBytes: maxImageBytes, ...(lookupImpl ? { lookupImpl } : {}) }) }
  }

  for (const message of messages) {
    const role = message?.role || 'user'
    if (role === 'system' || role === 'developer') {
      const text = contentText(message?.content)
      if (text.trim()) instructions.push(text)
      continue
    }
    if (role === 'assistant') {
      const text = contentText(message?.content)
      if (text.trim()) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
      const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : []
      for (const call of calls) {
        const name = call?.function?.name || call?.name
        if (!name) continue
        const callId = String(call?.id || newCallId())
        let args = call?.function?.arguments ?? call?.arguments ?? '{}'
        if (typeof args !== 'string') args = JSON.stringify(args ?? {})
        pending.push({ id: callId, answered: false })
        input.push({ type: 'function_call', call_id: callId, name, arguments: args })
      }
      continue
    }
    if (role === 'tool' || role === 'function') {
      const { text, images } = splitContent(message?.content)
      const callId = message?.tool_call_id ? String(message.tool_call_id) : ''
      // 先按 id 配对；客户端丢了 id 时按顺序回答尚未应答的调用；
      // 都没有则降级成 user 文本，避免上游拒绝孤儿 function_call_output。
      let target = callId ? pending.find((p) => p.id === callId && !p.answered) : undefined
      if (!target) target = pending.find((p) => !p.answered)
      if (target) {
        target.answered = true
        input.push({ type: 'function_call_output', call_id: target.id, output: text })
      } else if (text.trim()) {
        input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: `[Tool result${callId ? ` for ${callId}` : ''}]\n${text}` }] })
      }
      if (images.length) {
        const parts = []
        for (const url of images) parts.push(await imagePart(url))
        input.push({ type: 'message', role: 'user', content: parts })
      }
      continue
    }
    // user（及其它未知角色按 user 处理）
    const { text, images } = splitContent(message?.content)
    const parts = []
    if (text.trim()) parts.push({ type: 'input_text', text })
    for (const url of images) parts.push(await imagePart(url))
    if (parts.length) input.push({ type: 'message', role: 'user', content: parts })
  }

  // 被中断的工具循环可能留下没有结果的 function_call；Responses 协议要求
  // call/output 一一配对，否则整条请求 400。为悬空调用补一个中断说明。
  for (const call of pending) {
    if (!call.answered) input.push({ type: 'function_call_output', call_id: call.id, output: '[工具执行被中断，没有输出]' })
  }

  // 工具：Chat 形状 {type:function, function:{...}} → Responses 形状 {type:function, name, ...}。
  let tools = []
  const choice = body.tool_choice
  if (choice !== 'none') {
    tools = (Array.isArray(body.tools) ? body.tools : [])
      .filter((tool) => tool?.function?.name)
      .map((tool) => ({
        type: 'function',
        name: tool.function.name,
        description: tool.function.description || '',
        parameters: tool.function.parameters || { type: 'object', properties: {} },
      }))
    if (choice && typeof choice === 'object') {
      const name = choice.function?.name || choice.name
      if (name) {
        const filtered = tools.filter((tool) => tool.name === name)
        if (filtered.length === 0) {
          throw Object.assign(new Error(`tool_choice 指定的工具 ${name} 不在 tools 列表中`), { statusCode: 400 })
        }
        tools = filtered
      }
    }
  }

  const max = Number(body.max_completion_tokens ?? body.max_tokens)
  const explicit = normalizeEffort(
    body.reasoning_effort ?? body.reasoningEffort ?? body.reasoning?.effort ?? body.thinking?.effort,
  )
  // 小预算（≤1024，常见于会话标题/分类请求）且未显式指定档位时关思考，
  // 否则思考会吃光预算，正文为空（对齐社区插件 plugins#643 的修复）。
  const smallBudget = Number.isFinite(max) && max > 0 && max <= 1024
  const requested = explicit ?? (smallBudget ? 'none' : normalizeEffort(defaultEffort) ?? 'high')
  const effort = clampEffort(requested, modelInfo?.reasoningEfforts)

  const payload = {
    model,
    input,
    stream: true,
    store: false,
    metadata: { session_type: sessionType },
  }
  // 非推理模型（目录明确无档位）不发 reasoning；未知模型原样发给上游裁决。
  const hasEffortMap = modelInfo ? Object.keys(modelInfo.reasoningEfforts ?? {}).length > 0 : true
  if (hasEffortMap) payload.reasoning = { effort }
  if (instructions.length > 0) payload.instructions = instructions.join('\n\n')
  if (tools.length > 0) {
    payload.tools = tools
    if (choice === 'required') payload.tool_choice = 'required'
    else if (choice && typeof choice === 'object') {
      const name = choice.function?.name || choice.name
      payload.tool_choice = name ? { type: 'function', name } : 'auto'
    } else payload.tool_choice = 'auto'
  }
  if (Number.isFinite(max) && max > 0) {
    payload.max_output_tokens = Math.min(Math.trunc(max), modelInfo?.maxTokens ?? 128_000)
  }
  return { payload, effort, imageCount, toolCount: tools.length }
}

/**
 * 推导稳定的上游会话 id（前缀缓存/日志关联）：
 * 具名会话（chat.headers 钩子）> prompt_cache_key > user > 对话开头哈希。
 * 客户端的原始 key 不会原样发给上游。
 */
export function deriveSessionId(body, named = '') {
  const clean = String(named ?? '').trim()
  let seed
  if (clean) seed = `session\0${clean}`
  else if (String(body?.prompt_cache_key ?? '').trim()) seed = `key\0${body.prompt_cache_key}`
  else if (String(body?.user ?? '').trim()) seed = `user\0${body.user}`
  else {
    const messages = Array.isArray(body?.messages) ? body.messages : []
    const system = messages.filter((m) => m?.role === 'system' || m?.role === 'developer').map((m) => contentText(m?.content))
    const firstUser = messages.find((m) => m?.role === 'user')
    seed = `chat\0${JSON.stringify([system, firstUser?.content ?? ''])}`
  }
  const hex = createHash('sha256').update(seed).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** 上游 usage → Chat Completions usage（真实值，不再估算）。 */
export function mapUsage(usage) {
  if (!usage || typeof usage !== 'object') return null
  const input = Number(usage.input_tokens) || 0
  const output = Number(usage.output_tokens) || 0
  const total = Number(usage.total_tokens) || input + output
  const result = { prompt_tokens: input, completion_tokens: output, total_tokens: total }
  const cached = Number(usage.input_tokens_details?.cached_tokens)
  if (Number.isFinite(cached) && cached > 0) result.prompt_tokens_details = { cached_tokens: cached }
  const reasoning = Number(usage.output_tokens_details?.reasoning_tokens)
  if (Number.isFinite(reasoning) && reasoning > 0) result.completion_tokens_details = { reasoning_tokens: reasoning }
  return result
}

/**
 * 创建 Responses SSE → Chat Completions 增量翻译器。
 * push(event) 返回要下发的 chunk 片段数组；同时累计完整结果供非流式聚合。
 *
 * 工具调用约束（对齐社区插件的实战修复）：
 *   - 绝不向客户端下发未具名的 tool_calls 头（plugins#579）：名字未知时先缓冲
 *     参数，等 output_item.done 带来名字再一次性补发；始终无名的调用丢弃。
 *   - item_id 优先于 output_index 定位调用；同一 output_index 换了 item_id
 *     视为新调用，不并入旧调用（plugins#930）。
 */
export function createResponseTranslator() {
  const toolByOutput = new Map()
  const toolByItem = new Map()
  const tools = []
  const textByItem = new Map()
  let nextTool = 0
  const state = {
    content: '',
    reasoning: '',
    tools,
    usage: null,
    finish: null,
    errored: null,
    completed: false,
    reasoningDeltas: 0,
  }

  const toolIndexFor = (event) => {
    if (event?.item_id && toolByItem.has(String(event.item_id))) return toolByItem.get(String(event.item_id))
    if (Number.isInteger(event?.output_index)) {
      const record = toolByOutput.get(event.output_index)
      if (record && (!event?.item_id || record.itemId === String(event.item_id))) return record.index
    }
    return undefined
  }
  const registerTool = (event, item) => {
    const index = nextTool++
    const tool = {
      id: String(item?.call_id || item?.id || newCallId()),
      name: String(item?.name || ''),
      args: '',
      argsEmitted: false,
      headerSent: false,
      itemId: item?.id ? String(item.id) : '',
    }
    tools[index] = tool
    if (tool.itemId) toolByItem.set(tool.itemId, index)
    if (Number.isInteger(event?.output_index)) toolByOutput.set(event.output_index, { index, itemId: tool.itemId })
    return index
  }
  const headerPiece = (index) => {
    const tool = tools[index]
    if (tool.headerSent || !tool.name) return null
    tool.headerSent = true
    return { delta: { tool_calls: [{ index, id: tool.id, type: 'function', function: { name: tool.name, arguments: '' } }] } }
  }
  const namedTools = () => tools.filter((tool) => tool.name)

  function push(event) {
    const out = []
    const type = event?.type
    if (!type) return out
    switch (type) {
      case 'response.output_item.added': {
        const item = event.item ?? {}
        if (item.type === 'function_call') {
          const index = registerTool(event, item)
          const header = headerPiece(index)
          if (header) out.push(header)
        } else if (item.type === 'message' && item.id) {
          textByItem.set(item.id, { streamed: false })
        }
        break
      }
      case 'response.output_text.delta': {
        const delta = typeof event.delta === 'string' ? event.delta : ''
        if (delta) {
          state.content += delta
          if (event.item_id) {
            // 即使没收到 output_item.added 也登记，避免 done 事件重复补发全文。
            const record = textByItem.get(event.item_id) ?? { streamed: false }
            record.streamed = true
            textByItem.set(event.item_id, record)
          }
          out.push({ delta: { content: delta } })
        }
        break
      }
      case 'response.reasoning_text.delta': {
        const delta = typeof event.delta === 'string' ? event.delta : ''
        if (delta) {
          state.reasoning += delta
          state.reasoningDeltas += 1
          out.push({ delta: { reasoning_content: delta } })
        }
        break
      }
      case 'response.function_call_arguments.delta': {
        const index = toolIndexFor(event)
        const delta = typeof event.delta === 'string' ? event.delta : ''
        if (index !== undefined && delta) {
          const tool = tools[index]
          tool.args += delta
          if (tool.headerSent) {
            tool.argsEmitted = true
            out.push({ delta: { tool_calls: [{ index, function: { arguments: delta } }] } })
          }
          // 名字未知：先缓冲，等具名后随头一起补发。
        }
        break
      }
      case 'response.function_call_arguments.done': {
        const index = toolIndexFor(event)
        if (index !== undefined && !tools[index].argsEmitted && typeof event.arguments === 'string' && event.arguments) {
          const tool = tools[index]
          tool.args = event.arguments
          if (tool.headerSent) {
            tool.argsEmitted = true
            out.push({ delta: { tool_calls: [{ index, function: { arguments: tool.args } }] } })
          }
        }
        break
      }
      case 'response.output_item.done': {
        const item = event.item ?? {}
        if (item.type === 'function_call') {
          let index = toolIndexFor(event)
          if (index === undefined) index = registerTool(event, item)
          const tool = tools[index]
          if (!tool.name && item.name) tool.name = String(item.name)
          const header = headerPiece(index)
          if (header) out.push(header)
          if (tool.headerSent && !tool.argsEmitted) {
            const args = typeof item.arguments === 'string' && item.arguments ? item.arguments : tool.args
            if (args) {
              tool.args = args
              tool.argsEmitted = true
              out.push({ delta: { tool_calls: [{ index, function: { arguments: args } }] } })
            }
          }
        } else if (item.type === 'message' && Array.isArray(item.content)) {
          const record = item.id ? textByItem.get(item.id) : undefined
          // 无 id 的 done 帧：只要已经流过正文就视为重复，不再补发。
          const alreadyStreamed = record ? record.streamed : state.content.length > 0
          if (!alreadyStreamed) {
            const full = item.content.filter((part) => part?.type === 'output_text').map((part) => part.text || '').join('')
            if (full) {
              state.content += full
              out.push({ delta: { content: full } })
            }
          }
        }
        break
      }
      case 'response.completed':
      case 'response.incomplete': {
        const response = event.response ?? {}
        state.usage = mapUsage(response.usage)
        const named = namedTools()
        // 只有未具名调用且没有其它输出：视为上游异常，不下发可执行的 tool_calls。
        if (tools.length > 0 && named.length === 0 && !state.content && !state.reasoning) {
          state.errored = '上游返回了未具名的工具调用，已丢弃'
          state.completed = true
          break
        }
        const reason = response.incomplete_details?.reason
        state.finish = type === 'response.incomplete' && reason === 'max_output_tokens'
          ? 'length'
          : type === 'response.incomplete' && reason === 'content_filter'
            ? 'content_filter'
            : named.length > 0 ? 'tool_calls' : 'stop'
        state.completed = true
        out.push({ delta: {}, finish_reason: state.finish, usage: state.usage })
        break
      }
      case 'response.failed': {
        const response = event.response ?? {}
        state.errored = response.last_error?.message || response.error?.message || 'Qoder 上游推理失败'
        state.completed = true
        break
      }
      case 'error': {
        state.errored = event.error?.message || event.message || 'Qoder 上游错误'
        state.completed = true
        break
      }
      default:
        break
    }
    return out
  }

  /** 流在没有 completed 事件的情况下结束：尽力补一个收尾 chunk。 */
  function finalize() {
    if (state.completed || state.errored) return null
    if (tools.length > 0 && namedTools().length === 0 && !state.content && !state.reasoning) {
      state.errored = '上游返回了未具名的工具调用，已丢弃'
      state.completed = true
      return null
    }
    state.finish = namedTools().length > 0 ? 'tool_calls' : 'stop'
    state.completed = true
    return { delta: {}, finish_reason: state.finish, usage: state.usage }
  }

  /** 非流式聚合结果（未具名调用不下发）。 */
  function result() {
    const named = namedTools()
    return {
      content: state.content || null,
      reasoning: state.reasoning || '',
      toolCalls: named.length > 0
        ? named.map((tool) => ({ id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.args } }))
        : null,
      usage: state.usage,
      finish: state.finish ?? (named.length > 0 ? 'tool_calls' : 'stop'),
      errored: state.errored,
    }
  }

  return { push, finalize, result, state }
}

/**
 * 把上游 SSE 字节流解析成事件对象序列。
 * 兼容 \n\n 与 \r\n\r\n 分隔；多行 data 按 SSE 规范用 \n 连接；
 * 流结束时 flush 残留尾帧（服务端可能在最后一个事件后直接关连接）；
 * 消费方提前 break 时取消上游 body，避免 socket 滞留。
 */
export async function* sseEvents(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const MAX_BUFFER = 16 * 1024 * 1024
  let buffer = ''
  let exhausted = false
  const parseFrame = (raw) => {
    const lines = []
    for (const line of raw.split('\n')) {
      if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /, ''))
    }
    const data = lines.join('\n').trim()
    if (!data || data === '[DONE]') return null
    try {
      return JSON.parse(data)
    } catch {
      return null // 忽略坏帧，继续读流。
    }
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        exhausted = true
        break
      }
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      if (buffer.length > MAX_BUFFER) throw new Error('SSE 缓冲超过 16MB 上限')
      let index
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const frame = parseFrame(raw)
        if (frame) yield frame
      }
    }
    buffer += decoder.decode().replace(/\r\n/g, '\n')
    if (buffer.trim()) {
      const frame = parseFrame(buffer)
      if (frame) yield frame
    }
  } finally {
    if (!exhausted) {
      try {
        await reader.cancel()
      } catch {
        // 忽略取消失败。
      }
    }
    reader.releaseLock?.()
  }
}