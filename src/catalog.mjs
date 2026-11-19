/**
 * Qoder / Qwen Code 模型目录。
 *
 * Qwen Code 1.0 在登录后会请求：
 *   GET {gatewayBaseUrl}/api/v3/model/list?categories=qcode
 * 返回的 `qcode` 数组里每个模型带 display_name、max_input_tokens、is_vl、
 * is_reasoning、is_free 与 thinking_config（实际支持的思考档位）。
 *
 * 插件以这份目录为准；拉取失败时才退回 src/models.mjs 的内置模型表。
 * 这样 Qwen 上新模型、调整上下文或思考档位时不需要升级插件。
 */
import { sanitizeText } from './forward.mjs'

/** 目录接口路径（与 qwen-code 1.0.0-preview.2 一致）。 */
export const CATALOG_PATH = '/api/v3/model/list?categories=qcode'

/** 思考档位的展示顺序；Qoder 的键与 OpenAI effort 值同名。 */
const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** 目录没有输出上限时的保守默认值（Qwen 目录目前不返回该字段）。 */
const DEFAULT_MAX_OUTPUT = 128_000

/** 正整数，否则 undefined。 */
function positive(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : undefined
}

/**
 * 从 thinking_config 推导 DSH 的 reasoningEfforts 映射。
 * `off` 映射到 Responses 协议的 `none`；`disabled` 不存在时不给 off。
 * @param {Record<string, any>} row
 * @returns {Record<string, string>}
 */
export function reasoningEffortsFrom(row) {
  const efforts = {}
  const thinking = row && typeof row === 'object' ? row.thinking_config : undefined
  if (thinking && typeof thinking === 'object' && thinking.disabled && typeof thinking.disabled === 'object') {
    efforts.off = 'none'
  }
  const enabled = thinking && typeof thinking === 'object' ? thinking.enabled : undefined
  const levels = enabled && typeof enabled === 'object' ? enabled.efforts : undefined
  if (levels && typeof levels === 'object' && !Array.isArray(levels)) {
    for (const level of EFFORT_ORDER) {
      if (Object.hasOwn(levels, level)) efforts[level] = level
    }
  }
  // 目录说它是推理模型，但没给档位表（旧目录/新字段）：给出保守的通用档位，
  // 至少让用户能开/关；具体档位是否被上游接受由上游决定。
  if (Object.keys(efforts).length === 0 && row?.is_reasoning === true) {
    efforts.off = 'none'
    efforts.low = 'low'
    efforts.medium = 'medium'
    efforts.high = 'high'
    efforts.xhigh = 'xhigh'
  }
  return efforts
}

/**
 * 把目录里的一行转成插件的模型条目；不可用/非 OpenAI 形状的行返回 undefined。
 * @param {Record<string, any>} row
 * @returns {Record<string, any> | undefined}
 */
export function modelFromCatalogRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return undefined
  if (typeof row.key !== 'string' || row.key.length === 0) return undefined
  // 防御恶意/异常目录：保留键不能当模型 id（避免原型写入）。
  if (row.key === '__proto__' || row.key === 'constructor' || row.key === 'prototype') return undefined
  if (row.enable === false) return undefined
  if (typeof row.format === 'string' && row.format !== 'openai') return undefined

  const id = row.key
  const name = typeof row.display_name === 'string' && row.display_name.length > 0 ? row.display_name : id
  // max_input_tokens 是模型真实输入上限；context_config 是账号计划里可选的
  // 上下文预设（可能对 180K 的模型也列出 1M），不能拿它当模型上限。
  const contextWindow = positive(row.max_input_tokens)
    ?? positive(row.context_config?.['1M']?.token_count)
    ?? 1_000_000
  const maxTokens = positive(row.max_output_tokens)
    ?? positive(row.max_tokens)
    ?? DEFAULT_MAX_OUTPUT
  const input = row.is_vl === true ? ['text', 'image'] : ['text']
  const reasoningEfforts = reasoningEffortsFrom(row)
  const traits = []
  if (row.is_free === true) traits.push('免费额度模型')
  if (reasoningEfforts.off) traits.push('可关闭思考')
  if (Object.keys(reasoningEfforts).some((level) => level !== 'off')) traits.push('支持思考档位')

  const model = {
    id,
    name,
    contextWindow,
    maxTokens,
    input,
    reasoningEfforts,
  }
  if (traits.length > 0) model.description = `${name}（${traits.join('，')}）`
  if (row.is_free === true) model.isFree = true
  const priceFactor = Number(row.price_factor)
  if (Number.isFinite(priceFactor)) model.priceFactor = priceFactor
  return model
}

/**
 * 解析目录响应。只取 `qcode` 数组；任何异常形状都返回空数组，由调用方决定回退。
 * @param {unknown} payload
 * @returns {Array<Record<string, any>>}
 */
export function modelsFromCatalog(payload) {
  const rows = payload && typeof payload === 'object' && Array.isArray(payload.qcode) ? payload.qcode : []
  const seen = new Set()
  const models = []
  for (const row of rows) {
    const model = modelFromCatalogRow(row)
    if (!model || seen.has(model.id)) continue
    seen.add(model.id)
    models.push(model)
  }
  return models
}

/**
 * 用当前 Qoder 凭证拉取模型目录。
 * @param {{
 *   auth: { getAccessToken: (options?: {forceRefresh?: boolean}) => Promise<string> },
 *   gatewayBaseUrl: string,
 *   clientType?: string,
 *   clientVersion?: string,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   logger?: {warn?: Function, info?: Function},
 * }} options
 * @returns {Promise<Array<Record<string, any>>>}
 */
export async function fetchModelCatalog(options) {
  const {
    auth,
    gatewayBaseUrl,
    clientType = '13',
    clientVersion = '1.0.0-preview.2',
    fetchImpl = fetch,
    timeoutMs = 5_000,
    logger,
  } = options ?? {}
  if (!auth || typeof auth.getAccessToken !== 'function') throw new Error('缺少 Qoder 凭证管理器')
  if (typeof gatewayBaseUrl !== 'string' || gatewayBaseUrl.length === 0) throw new Error('缺少 Qoder 网关地址')

  const token = await auth.getAccessToken()
  const url = `${String(gatewayBaseUrl).replace(/\/+$/, '')}${CATALOG_PATH}`
  const signal = AbortSignal.timeout(Math.max(1_000, Number(timeoutMs) || 5_000))
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Cosy-ClientType': String(clientType),
      'Cosy-Version': String(clientVersion),
    },
    signal,
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    // 上游错误体可能回显 token 片段；脱敏并截断后才允许进日志/错误消息。
    throw new Error(`Qoder 模型目录返回 HTTP ${response.status}${detail ? `：${sanitizeText(detail).slice(0, 300)}` : ''}`)
  }
  let payload
  try {
    payload = await response.json()
  } catch {
    throw new Error('Qoder 模型目录返回了非法 JSON')
  }
  const models = modelsFromCatalog(payload)
  if (models.length === 0) {
    logger?.warn?.('[magpie-qwen4] Qoder 模型目录为空，沿用内置模型表')
  }
  return models
}
