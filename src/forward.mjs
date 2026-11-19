/**
 * 直接转发核心：把翻译好的 Responses 请求直接发给 Qwen Code 的 Qoder 网关，
 * 把上游 SSE 翻译回 Chat Completions 响应。
 *
 * 设计对齐 dsh-qwencode 的桥接（src/bridge.mjs）：
 *   - 动态 access token（QoderAuth：过期前刷新、401 强制刷新重试一次）
 *   - AgentId query、metadata.session_type、Cosy-* 头
 *   - MODEL_PAID_CONFIRM_REQUIRED 默认拒绝（402），可配置自动确认
 *   - 错误消息脱敏（dt-/drt-/Bearer/sk- 等凭证片段不回传）
 *   - 上游空闲超时与客户端断开中止
 * 区别：Magpie 的 loader 自带 fetch 拦截，这里不再起本地 HTTP 服务，
 * 没有任何监听端口，token 只存在于进程内与 ~/.qwen 凭证文件。
 */
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { QoderAuthError, normalizeRegion, regionEndpoints } from './qoder-auth.mjs'
import { chatToResponses, createResponseTranslator, deriveSessionId, sseEvents } from './translate.mjs'
import {
  ALIAS_MODEL,
  BUILTIN_MODELS,
  DEFAULT_UPSTREAM_MODEL,
  PROVIDER,
  SESSION_HEADER,
  findModel,
  normalizeEffort,
  resolveUpstreamModel,
} from './models.mjs'

/** 转发默认配置。 */
export const DEFAULT_FORWARD_CONFIG = {
  region: undefined,
  gatewayBaseUrl: undefined,
  agentId: 'agent_common',
  sessionType: 'qcode',
  clientType: '13',
  clientVersion: '1.0.0-preview.2',
  defaultEffort: 'high',
  autoConfirmPaid: false,
  keepaliveMs: 15_000,
  upstreamIdleTimeoutMs: 600_000,
  maxImages: 4,
  maxImageBytes: 20 * 1024 * 1024,
  imageFetchTimeoutMs: 30_000,
  debug: false,
  models: BUILTIN_MODELS,
}

/** 上游错误体里的"付费确认"标记。 */
const PAID_CONFIRM_SUBCODE = 'MODEL_PAID_CONFIRM_REQUIRED'

/** 去敏任意文本：抹掉疑似凭证与 Bearer。 */
export function sanitizeText(value) {
  if (typeof value !== 'string') return value
  return value
    .replace(/\b(?:dt|drt)-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/\bgho_[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/\b(sk|key)-[A-Za-z0-9_-]{16,}/g, '[REDACTED]')
}

/** 从上游错误体提取可读错误（只保留脱敏短消息，不回传完整响应体）。 */
export function describeUpstreamError(status, text) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return { message: sanitizeText(String(text ?? '').trim() || `Qoder 网关返回 HTTP ${status}`).slice(0, 500), code: undefined, subCode: undefined, param: undefined }
  }
  const error = body?.error && typeof body.error === 'object' ? body.error : body
  const rawMessage = typeof error?.message === 'string' && error.message.trim()
    ? error.message.trim()
    : typeof body?.message === 'string' && body.message.trim() ? body.message.trim() : `Qoder 网关返回 HTTP ${status}`
  return {
    message: sanitizeText(rawMessage).slice(0, 500),
    // 结构化字段同样可能夹带凭证片段，一并脱敏。
    code: typeof error?.code === 'string' ? sanitizeText(error.code) : undefined,
    subCode: typeof error?.subCode === 'string' ? sanitizeText(error.subCode) : undefined,
    param: typeof error?.param === 'string' ? sanitizeText(error.param) : undefined,
  }
}

/** 读取上游错误体，限制最大字节数，避免异常上游把大 body 放大进错误/日志。 */
async function readErrorBody(upstream, limit = 64 * 1024) {
  try {
    const reader = upstream.body?.getReader()
    if (!reader) return ''
    const chunks = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      chunks.push(Buffer.from(value))
      if (total >= limit) {
        try {
          await reader.cancel()
        } catch {
          // 忽略
        }
        break
      }
    }
    return Buffer.concat(chunks).toString('utf8').slice(0, limit)
  } catch {
    return ''
  }
}

/** OpenAI 风格错误响应。 */
function errorResponse(status, message, code) {
  return new Response(
    JSON.stringify({ error: { message: String(message ?? 'Qoder 转发失败'), type: 'qoder_upstream_error', ...(code ? { code } : {}) } }),
    { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } },
  )
}

/** JSON 响应。 */
function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * 创建转发器。
 * @param {Partial<typeof DEFAULT_FORWARD_CONFIG> & {
 *   auth: import('./qoder-auth.mjs').QoderAuth,
 *   fetchImpl?: typeof fetch,
 *   logger?: {info?: Function, warn?: Function, error?: Function},
 * }} userConfig
 */
export function createForwarder(userConfig = {}) {
  const config = { ...DEFAULT_FORWARD_CONFIG, ...userConfig }
  const logger = config.logger ?? console
  const auth = config.auth
  if (!auth || typeof auth.getAccessToken !== 'function') throw new Error('createForwarder 需要 QoderAuth 实例')
  const fixedGateway = config.gatewayBaseUrl ? String(config.gatewayBaseUrl).replace(/\/+$/, '') : undefined
  // 网关地址跟随 auth.region 动态解析：QoderAuth 首次读凭证时可能把 region
  // 从缺省 cn 纠正成账号实际地域（如 global），固定缓存会把 global token 发到 CN 网关。
  const currentGatewayBaseUrl = () => fixedGateway ?? regionEndpoints(normalizeRegion(auth.region)).gatewayBaseUrl.replace(/\/+$/, '')
  const fetchImpl = config.fetchImpl ?? fetch

  const stats = {
    requests: 0,
    success: 0,
    failed: 0,
    authRetries: 0,
    paidRetries: 0,
    lastRequestAt: null,
    lastModel: null,
    lastEffort: null,
    lastUpstreamStatus: null,
    lastTraceId: null,
    lastError: null,
    lastReasoningDeltas: 0,
    lastToolCalls: 0,
  }

  const currentModels = () => (Array.isArray(config.models) && config.models.length > 0 ? config.models : BUILTIN_MODELS)

  const upstreamUrl = () => `${currentGatewayBaseUrl()}/api/v1/responses?${new URLSearchParams({ AgentId: config.agentId }).toString()}`

  function upstreamHeaders(token, requestId, sessionId, forcePaidConfirmation) {
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'Cosy-ClientType': String(config.clientType),
      'Cosy-Version': String(config.clientVersion),
      'X-Request-Id': requestId,
      'X-Session-Id': sessionId,
      'X-Request-Set-Id': randomUUID(),
    }
    if (forcePaidConfirmation) headers['Cosy-Paid-Confirmed'] = 'true'
    return headers
  }

  /** 调试日志：只记归一化后的档位元数据，不记 prompt，也不记客户端可控的原始对象。 */
  function logEffort(body, chosen) {
    if (!config.debug) return
    try {
      fs.appendFileSync(
        path.join(os.tmpdir(), 'magpie-qwen4-qoder-effort.log'),
        `${JSON.stringify({
          at: new Date().toISOString(),
          requested: normalizeEffort(body?.reasoning_effort ?? body?.reasoningEffort ?? body?.reasoning?.effort ?? body?.thinking?.effort),
          chosen,
        })}\n`,
      )
    } catch {
      // 调试日志失败不影响请求。
    }
  }

  /** 调上游；401 刷新重试一次；付费确认按配置处理。失败抛带 statusCode 的错误。 */
  async function callUpstream(payload, { sessionId, requestId, signal, forcePaidConfirmation = false, retriedAuth = false }) {
    if (signal?.aborted) throw Object.assign(new Error('请求已中止'), { name: 'AbortError' })
    let token
    try {
      token = await auth.getAccessToken({ forceRefresh: retriedAuth })
    } catch (error) {
      const message = error instanceof QoderAuthError ? error.message : `获取 Qoder 凭证失败：${error?.message ?? error}`
      throw Object.assign(new Error(sanitizeText(message)), { statusCode: 401, code: error instanceof QoderAuthError ? error.code : 'auth_failed' })
    }
    const upstream = await fetchImpl(upstreamUrl(), {
      method: 'POST',
      headers: upstreamHeaders(token, requestId, sessionId, forcePaidConfirmation),
      body: JSON.stringify(payload),
      signal,
      redirect: 'follow',
    })
    stats.lastUpstreamStatus = upstream.status
    stats.lastTraceId = upstream.headers.get('sw-trace-id') ?? upstream.headers.get('x-request-id') ?? null
    if (upstream.status === 401 && !retriedAuth) {
      stats.authRetries += 1
      logger.warn?.(`[${PROVIDER}] 上游 401，强制刷新 token 后重试一次`)
      try {
        await upstream.body?.cancel()
      } catch {
        // 忽略
      }
      return callUpstream(payload, { sessionId, requestId: randomUUID(), signal, forcePaidConfirmation, retriedAuth: true })
    }
    if (!upstream.ok) {
      const text = await readErrorBody(upstream)
      const detail = describeUpstreamError(upstream.status, text)
      if (detail.subCode === PAID_CONFIRM_SUBCODE) {
        if (config.autoConfirmPaid === true && !forcePaidConfirmation) {
          stats.paidRetries += 1
          logger.warn?.(`[${PROVIDER}] 上游要求付费确认，autoConfirmPaid=true，附带 Cosy-Paid-Confirmed 重试一次`)
          return callUpstream(payload, { sessionId, requestId: randomUUID(), signal, forcePaidConfirmation: true })
        }
        throw Object.assign(
          new Error(`模型 ${payload.model} 需要付费确认（MODEL_PAID_CONFIRM_REQUIRED）：该模型会消耗付费额度，插件默认不自动确认。请换用免费模型（qfmodel），或设置环境变量 MAGPIE_QWEN_AUTO_CONFIRM_PAID=1。`),
          { statusCode: 402, code: 'model_paid_confirm_required' },
        )
      }
      // 401/402/403/429 保留原状态码，便于 Magpie 识别鉴权失效/付费/限流并提示重新登录或退避。
      const status = [401, 402, 403, 429].includes(upstream.status)
        ? upstream.status
        : upstream.status >= 500 ? 502 : 400
      throw Object.assign(new Error(`Qoder 推理失败：${detail.message}`), {
        statusCode: status,
        code: detail.code,
      })
    }
    return upstream
  }

  /** 流式：上游 Responses SSE → chat.completion.chunk SSE。 */
  function streamResponse(upstream, { requestedModel, controller }) {
    const id = `chatcmpl-qwen4-${randomUUID()}`
    const created = Math.floor(Date.now() / 1000)
    const model = requestedModel || `${PROVIDER}/${ALIAS_MODEL}`
    const translator = createResponseTranslator()
    const encoder = new TextEncoder()
    let keepalive = null
    let idleTimer = null
    let closed = false
    let lastForward = Date.now()

    const stream = new ReadableStream({
      start(streamController) {
        const sendRaw = (text) => {
          try {
            streamController.enqueue(encoder.encode(text))
            lastForward = Date.now()
          } catch {
            // 流已关闭。
          }
        }
        const chunk = (delta, finish = null, usage = null) => ({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...(usage ? { usage } : {}),
        })
        const send = (value) => sendRaw(`data: ${JSON.stringify(value)}\n\n`)
        const finishStream = () => {
          if (closed) return
          closed = true
          if (keepalive) clearInterval(keepalive)
          if (idleTimer) clearTimeout(idleTimer)
          try {
            streamController.close()
          } catch {
            // 已关闭。
          }
        }
        const armIdle = () => {
          if (idleTimer) clearTimeout(idleTimer)
          idleTimer = setTimeout(() => {
            if (closed) return
            logger.warn?.(`[${PROVIDER}] 上游流空转超过 ${config.upstreamIdleTimeoutMs}ms，主动中断`)
            send({ error: { message: '上游流空闲超时', type: 'qoder_upstream_error' } })
            sendRaw('data: [DONE]\n\n')
            controller.abort(new Error('上游流空闲超时'))
            finishStream()
          }, config.upstreamIdleTimeoutMs)
          idleTimer.unref?.()
        }

        // 首个上游字节到达前先发 role 块与心跳，客户端 idle 计时不会误判死连接。
        send(chunk({ role: 'assistant' }))
        keepalive = setInterval(() => {
          if (!closed && Date.now() - lastForward >= config.keepaliveMs) send(chunk({}))
        }, Math.max(1_000, config.keepaliveMs))
        keepalive.unref?.()

        ;(async () => {
          try {
            armIdle()
            for await (const event of sseEvents(upstream.body)) {
              if (closed) break
              armIdle()
              for (const piece of translator.push(event)) {
                send(chunk(piece.delta, piece.finish_reason ?? null, piece.usage ?? null))
              }
              if (translator.state.errored) {
                send({ error: { message: sanitizeText(translator.state.errored), type: 'qoder_upstream_error' } })
                break
              }
              if (translator.state.completed) break
            }
            if (!closed) {
              const tail = translator.finalize()
              if (tail) send(chunk(tail.delta, tail.finish_reason, tail.usage))
              sendRaw('data: [DONE]\n\n')
            }
          } catch (error) {
            if (!closed) {
              stats.lastError = sanitizeText(error?.message || String(error))
              send({ error: { message: stats.lastError, type: 'qoder_upstream_error' } })
              sendRaw('data: [DONE]\n\n')
            }
          } finally {
            stats.lastReasoningDeltas = translator.state.reasoningDeltas
            stats.lastToolCalls = translator.result().toolCalls?.length ?? 0
            if (translator.state.completed && !translator.state.errored) stats.success += 1
            finishStream()
          }
        })()
      },
      cancel() {
        closed = true
        controller.abort()
        if (keepalive) clearInterval(keepalive)
        if (idleTimer) clearTimeout(idleTimer)
      },
    })

    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    })
  }

  /** 非流式：上游仍是 SSE（网关要求），聚合成一个 chat.completion。 */
  async function aggregateResponse(upstream, { requestedModel, controller }) {
    const translator = createResponseTranslator()
    let idleTimer = null
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => controller.abort(new Error('上游流空闲超时')), config.upstreamIdleTimeoutMs)
      idleTimer.unref?.()
    }
    try {
      armIdle()
      for await (const event of sseEvents(upstream.body)) {
        armIdle()
        translator.push(event)
        if (translator.state.completed || translator.state.errored) break
      }
    } catch (error) {
      if (controller.signal.aborted && /空闲超时/.test(String(controller.signal.reason?.message ?? error?.message ?? ''))) {
        throw Object.assign(new Error('上游流空闲超时'), { statusCode: 504 })
      }
      throw error
    } finally {
      if (idleTimer) clearTimeout(idleTimer)
      stats.lastReasoningDeltas = translator.state.reasoningDeltas
      stats.lastToolCalls = translator.result().toolCalls?.length ?? 0
    }
    if (translator.state.errored) {
      throw Object.assign(new Error(sanitizeText(translator.state.errored)), { statusCode: 502 })
    }
    const result = translator.result()
    const message = { role: 'assistant', content: result.content }
    if (result.reasoning) message.reasoning_content = result.reasoning
    if (result.toolCalls) message.tool_calls = result.toolCalls
    return jsonResponse({
      id: `chatcmpl-qwen4-${randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: requestedModel || `${PROVIDER}/${ALIAS_MODEL}`,
      choices: [{ index: 0, message, finish_reason: result.finish }],
      usage: result.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    })
  }

  /** 一次 Chat Completions 请求 → Response。 */
  async function chat(body, { signal, sessionHint } = {}) {
    stats.requests += 1
    stats.lastRequestAt = new Date().toISOString()
    const requestedModel = typeof body?.model === 'string' ? body.model : ''
    const upstreamId = resolveUpstreamModel(requestedModel)
    const modelInfo = findModel(currentModels(), upstreamId)
      ?? (upstreamId === DEFAULT_UPSTREAM_MODEL ? findModel(BUILTIN_MODELS, DEFAULT_UPSTREAM_MODEL) : undefined)

    // 客户端信号与内部中止（流 cancel / 空闲超时）合并后交给上游 fetch。
    // 用 AbortSignal.any 而不是手动监听：流式 Response 返回后客户端再 abort
    // 也能传到上游，避免已取消的请求继续消耗免费额度。
    const controller = new AbortController()
    const combined = signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([controller.signal, signal])
      : controller.signal
    try {
      const { payload, effort, toolCount } = await chatToResponses(body, {
        model: upstreamId,
        modelInfo,
        defaultEffort: config.defaultEffort,
        sessionType: config.sessionType,
        fetchImpl,
        maxImages: config.maxImages,
        maxImageBytes: config.maxImageBytes,
        imageFetchTimeoutMs: config.imageFetchTimeoutMs,
        ...(config.lookupImpl ? { lookupImpl: config.lookupImpl } : {}),
      })
      stats.lastModel = upstreamId
      stats.lastEffort = effort
      logEffort(body, effort)
      const sessionId = deriveSessionId(body, sessionHint)
      const requestId = randomUUID()
      logger.info?.(`[${PROVIDER}] 直接转发 model=${upstreamId} effort=${effort} tools=${toolCount} stream=${Boolean(body?.stream)}`)
      const upstream = await callUpstream(payload, { sessionId, requestId, signal: combined })
      if (body?.stream) return streamResponse(upstream, { requestedModel, controller })
      const response = await aggregateResponse(upstream, { requestedModel, controller })
      stats.success += 1
      return response
    } catch (error) {
      stats.failed += 1
      stats.lastError = sanitizeText(error?.message || String(error))
      const idle = /空闲超时/.test(String(combined.reason?.message ?? error?.message ?? ''))
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : combined.aborted ? (idle ? 504 : 499) : 502
      logger.error?.(`[${PROVIDER}] 转发失败：${stats.lastError}`)
      return errorResponse(status, stats.lastError, error?.code)
    }
  }

  /** /v1/models：当前模型表（含别名）。 */
  function modelsResponse() {
    const models = currentModels()
    const data = models.map((model) => ({
      id: model.id,
      object: 'model',
      created: 0,
      owned_by: 'qwen-code',
      display_name: model.name,
      context_length: model.contextWindow,
      max_output_tokens: model.maxTokens,
    }))
    if (!models.some((model) => model.id === ALIAS_MODEL)) {
      data.unshift({ id: ALIAS_MODEL, object: 'model', created: 0, owned_by: 'qwen-code', display_name: 'Qwen4-Max (Qwen Code)' })
    }
    return jsonResponse({ object: 'list', data })
  }

  /** Magpie loader 的自定义 fetch 入口。 */
  async function fetchEntry(input, init = {}) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : typeof input?.url === 'string' ? input.url : ''
    if (/\/models(?:\?|$)/.test(url)) return modelsResponse()
    if (!/\/chat\/completions(?:\?|$)/.test(url)) return errorResponse(404, `未知路径：${url || '(空)'}`, 'not_found')

    const isRequest = typeof Request !== 'undefined' && input instanceof Request
    let raw = init.body
    if (raw == null && isRequest) raw = await input.text()
    // AI SDK 通常发字符串 body；兼容字节与流式 body，避免静默转发空对话。
    if (raw instanceof Uint8Array || raw instanceof ArrayBuffer) {
      raw = new TextDecoder().decode(raw)
    } else if (raw && typeof raw === 'object' && typeof raw.getReader === 'function') {
      const reader = raw.getReader()
      const chunks = []
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(Buffer.from(value))
      }
      raw = Buffer.concat(chunks).toString('utf8')
    }
    let body = {}
    if (typeof raw === 'string' && raw.trim()) {
      try {
        body = JSON.parse(raw)
      } catch {
        return errorResponse(400, '请求体不是合法 JSON', 'invalid_json')
      }
    } else if (raw && typeof raw === 'object') {
      body = raw
    }

    // chat.headers 钩子放进来的会话 id（仅内部使用，不发给上游）。
    let sessionHint = ''
    try {
      const headers = new Headers(isRequest ? input.headers : undefined)
      new Headers(init.headers ?? {}).forEach((value, key) => headers.set(key, value))
      sessionHint = headers.get(SESSION_HEADER) ?? ''
    } catch {
      // 头解析失败不影响转发。
    }
    const signal = init.signal ?? (isRequest ? input.signal : undefined)
    return chat(body, { signal, sessionHint })
  }

  return {
    config,
    stats,
    get gatewayBaseUrl() {
      return currentGatewayBaseUrl()
    },
    get models() {
      return currentModels()
    },
    /** 目录拉取成功后替换模型表；空数组忽略。 */
    setModels(next) {
      if (!Array.isArray(next) || next.length === 0) return false
      config.models = next
      return true
    },
    chat,
    fetch: fetchEntry,
  }
}