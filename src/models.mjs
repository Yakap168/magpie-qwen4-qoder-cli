/**
 * 模型表：内置默认 + Qoder 目录 → Magpie 模型条目。
 *
 * 内部模型条目与 dsh-qwencode 的 DEFAULT_MODELS 同形：
 *   { id, name, contextWindow, maxTokens, input, reasoningEfforts, isFree? }
 * Magpie 侧再转成它认识的 provider.models 形状（api/limit/capabilities/variants）。
 *
 * 兼容约定：旧模型 id `qwen4-max` 保留为别名，上游等价于 `qmodel_latest`。
 */
import { randomUUID } from 'node:crypto'

/** Provider id（与 0.x 保持一致，Magpie 账号/路由配置不用迁移）。 */
export const PROVIDER = 'qwen4-qoder'
export const PROVIDER_NAME = 'Qwen4-Max via Qwen Code'
/** 旧版模型 id，作为别名保留。 */
export const ALIAS_MODEL = 'qwen4-max'
/** 别名与缺省请求映射到的上游模型。 */
export const DEFAULT_UPSTREAM_MODEL = 'qmodel_latest'
/** 自定义 fetch 拦截一切请求，这个地址只是占位，不会真的连接。 */
export const DUMMY_BASE = 'http://127.0.0.1:9/v1'
/** chat.headers 钩子把会话 id 传给 loader fetch 用的内部头（不会发给上游）。 */
export const SESSION_HEADER = 'x-magpie-qwen4-session'

/** 与 Qwen Code 模型目录一致的内置模型表（目录拉取失败时的兜底）。 */
export const BUILTIN_MODELS = [
  {
    id: 'qmodel_latest',
    name: 'Qwen4-Max',
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    input: ['text', 'image'],
    reasoningEfforts: { off: 'none', low: 'low', high: 'high', xhigh: 'xhigh' },
    description: 'Qwen4-Max（Qwen Code 限时免费额度）',
  },
  {
    id: 'qmodel_latest_preview',
    name: 'Qwen4-Max-Preview',
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    input: ['text', 'image'],
    reasoningEfforts: { off: 'none', low: 'low', high: 'high', xhigh: 'xhigh' },
    description: 'Qwen4-Max 预览版',
  },
  {
    id: 'qmodel_38max',
    name: 'Qwen3.8-Max',
    // 目录 max_input_tokens=180000；context_config 的 1M 是账号预设，不是模型上限。
    contextWindow: 180_000,
    maxTokens: 128_000,
    input: ['text', 'image'],
    reasoningEfforts: { off: 'none', low: 'low', medium: 'medium', xhigh: 'xhigh' },
    description: 'Qwen3.8-Max',
  },
  {
    id: 'qfmodel',
    name: 'Qwen3.8-Flash',
    contextWindow: 180_000,
    maxTokens: 128_000,
    input: ['text', 'image'],
    reasoningEfforts: { off: 'none', low: 'low', medium: 'medium', xhigh: 'xhigh' },
    description: 'Qwen3.8-Flash（免费额度模型）',
    isFree: true,
  },
]

/** 思考档位从低到高的顺序（用于就近钳制）。 */
export const EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** 把请求里的各种写法规一化成标准档位；无法识别返回 null。 */
export function normalizeEffort(value) {
  const effort = String(value ?? '').trim().toLowerCase()
  if (!effort) return null
  if (effort === 'off' || effort === 'disabled') return 'none'
  if (effort === 'mid') return 'medium'
  if (effort === 'extra-high') return 'xhigh'
  return EFFORT_LEVELS.includes(effort) ? effort : null
}

/**
 * 把请求档位钳制到模型实际支持的档位：
 * 支持则原样；不支持取最近档位（平手取更高）；
 * 请求 none 但模型关不掉思考时取最低档。
 * @param {string} requested 归一化后的档位
 * @param {Record<string, string>} [efforts] 模型的 reasoningEfforts 映射
 */
export function clampEffort(requested, efforts) {
  const allowed = new Set(Object.values(efforts ?? {}))
  if (allowed.size === 0) return requested
  if (allowed.has(requested)) return requested
  if (requested === 'none') {
    return EFFORT_LEVELS.find((level) => level !== 'none' && allowed.has(level)) ?? 'none'
  }
  const index = EFFORT_LEVELS.indexOf(requested)
  if (index < 0) return EFFORT_LEVELS.find((level) => allowed.has(level)) ?? 'none'
  let best
  let bestDistance = Infinity
  for (const level of EFFORT_LEVELS) {
    if (level === 'none' || !allowed.has(level)) continue
    const distance = Math.abs(EFFORT_LEVELS.indexOf(level) - index)
    if (distance < bestDistance || (distance === bestDistance && EFFORT_LEVELS.indexOf(level) > EFFORT_LEVELS.indexOf(best))) {
      best = level
      bestDistance = distance
    }
  }
  return best ?? 'none'
}

/** 内部模型条目 → Magpie 模型条目。 */
export function magpieModel(model) {
  const efforts = model.reasoningEfforts ?? {}
  const variants = {}
  if (efforts.off) variants.none = { reasoningEffort: 'none' }
  for (const level of EFFORT_LEVELS) {
    if (level !== 'none' && efforts[level]) variants[level] = { reasoningEffort: level }
  }
  const image = (model.input ?? ['text']).includes('image')
  const reasoning = Object.keys(efforts).length > 0
  return {
    id: model.id,
    name: model.name,
    api: { id: model.id, url: DUMMY_BASE, npm: '@ai-sdk/openai-compatible' },
    status: 'active',
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: model.contextWindow, output: model.maxTokens },
    options: {},
    headers: {},
    // Magpie provider-list 形状。
    attachment: image,
    modalities: { input: model.input ?? ['text'], output: ['text'] },
    reasoning,
    tool_call: true,
    free: Boolean(model.isFree),
    // OpenCode / AI SDK 运行时形状。
    capabilities: {
      temperature: false,
      reasoning,
      attachment: image,
      toolcall: true,
      input: { text: true, image, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: '2026-11-19',
    variants,
  }
}

/** 别名条目：id 换成 qwen4-max，其余跟随 qmodel_latest。 */
function aliasModel(base) {
  return magpieModel({
    ...base,
    id: ALIAS_MODEL,
    name: 'Qwen4-Max (Qwen Code)',
    description: '兼容旧配置的别名，等价于 qmodel_latest',
  })
}

/** 内置模型表（含别名）→ Magpie 模型 map。null 原型防止异常 id 写原型。 */
export function staticMagpieModels() {
  const map = Object.create(null)
  for (const model of BUILTIN_MODELS) map[model.id] = magpieModel(model)
  map[ALIAS_MODEL] = aliasModel(BUILTIN_MODELS.find((m) => m.id === DEFAULT_UPSTREAM_MODEL) ?? BUILTIN_MODELS[0])
  return map
}

/** 目录模型表（含别名）→ Magpie 模型 map。空目录返回 null，由调用方兜底。 */
export function magpieModelsFromCatalog(models) {
  if (!Array.isArray(models) || models.length === 0) return null
  const map = Object.create(null)
  for (const model of models) {
    if (model.id === '__proto__' || model.id === 'constructor' || model.id === 'prototype') continue
    map[model.id] = magpieModel(model)
  }
  const base = models.find((m) => m.id === DEFAULT_UPSTREAM_MODEL) ?? models[0]
  map[ALIAS_MODEL] = aliasModel(base)
  return map
}

/** 请求里的模型名 → 上游模型 id（剥掉 provider 前缀、别名映射）。 */
export function resolveUpstreamModel(requested) {
  let id = String(requested ?? '').trim()
  if (id.startsWith(`${PROVIDER}/`)) id = id.slice(PROVIDER.length + 1)
  if (!id || id === ALIAS_MODEL) return DEFAULT_UPSTREAM_MODEL
  return id
}

/** 在模型表里找条目；找不到返回 undefined（未知 id 原样发给上游，由上游裁决）。 */
export function findModel(models, id) {
  return (models ?? []).find((model) => model.id === id)
}

/** 生成工具调用 id（客户端历史里丢失 id 时的兜底）。 */
export function newCallId() {
  return `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`
}