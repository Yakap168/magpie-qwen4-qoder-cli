// magpie-qwen4-qoder-cli 3.x — 直接转发型 Magpie Provider 插件。
//
// 不再为每条请求启动 qwen CLI 进程，而是复用 Qwen Code 的 Qoder 登录凭证
// （~/.qwen/qoder_oauth_creds.json），把 Chat Completions 请求翻译成
// OpenAI Responses 后直接发给 Qwen Code 的 Qoder 网关，走 Qwen Code 自己的
// 限时免费额度。设计对齐 dsh-qwencode（DSH 的 qwencode 插件）：
//
//   - 原生工具调用（Responses function tools），不再是 prompt 注入 JSON
//   - 原生逐 token 流式：正文 / 思考（reasoning_content）/ 工具参数增量
//   - 真实 usage（上游 input/output tokens），不再估算
//   - token 过期前自动刷新并原子写回，与 qwen CLI 共用同一份凭证
//   - 模型目录实时拉取（qcode catalog），思考档位按模型钳制
//   - 错误脱敏；不监听任何端口；不记录 prompt
//
// Provider id: qwen4-qoder。旧模型 id qwen4-max 保留为别名（→ qmodel_latest）。
// 工具与文件仍由 Magpie/外层 Agent（如 DSH）执行，插件只做协议/鉴权适配。

import { QoderAuth } from './src/qoder-auth.mjs'
import { fetchModelCatalog } from './src/catalog.mjs'
import { createForwarder } from './src/forward.mjs'
import {
  ALIAS_MODEL,
  DUMMY_BASE,
  PROVIDER,
  PROVIDER_NAME,
  SESSION_HEADER,
  magpieModelsFromCatalog,
  staticMagpieModels,
} from './src/models.mjs'

const ICON =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjE3LjUgMjcuNyAxMzUuNiAxMzUuNiI+CiAgPHBhdGggZmlsbD0iIzA4MkRGRiIgZD0iTTEzMC4wNiw0My42NmgtMzMuMzdjMC0xLjQyLS4zNy0yLjg0LTEuMS00LjExbC00LjQ3LTcuNzRjLTEuNDctMi41NC00LjE4LTQuMTEtNy4xMi00LjExaC04LjkzYy0yLjk0LDAtNS42NSwxLjU3LTcuMTIsNC4xMWwtMTMuNjgsMjMuNjljLTEuNDcsMi41NC0xLjQ3LDUuNjcsMCw4LjIybDQuNDcsNy43NGMxLjQ3LDIuNTQsNC4xOCw0LjExLDcuMTIsNC4xMWg2NC4xOWMyLjk0LDAsNS42NS0xLjU3LDcuMTItNC4xMWw0LjQ3LTcuNzRjMS40Ny0yLjU0LDEuNDctNS42NywwLTguMjJsLTQuNDctNy43NGMtMS40Ny0yLjU0LTQuMTgtNC4xMS03LjEyLTQuMTFaIiAvPgogIDxwYXRoIGZpbGw9IiMwODJERkYiIGQ9Ik0xOS43NSw4My42NmwxNi42OCwyOC45Yy0xLjIzLjcxLTIuMjcsMS43NC0zLjAxLDMuMDFsLTQuNDcsNy43NGMtMS40NywyLjU0LTEuNDcsNS42NywwLDguMjJsNC40Nyw3Ljc0YzEuNDcsMi41NCw0LjE4LDQuMTEsNy4xMiw0LjExaDI3LjM1YzIuOTQsMCw1LjY1LTEuNTcsNy4xMi00LjExbDQuNDctNy43NGMxLjQ3LTIuNTQsMS40Ny01LjY3LDAtOC4yMmwtMzIuMS01NS41OWMtMS40Ny0yLjU0LTQuMTgtNC4xMS03LjEyLTQuMTFoLTguOTNjLTIuOTQsMC01LjY1LDEuNTctNy4xMiw0LjExbC00LjQ3LDcuNzRjLTEuNDcsMi41NC0xLjQ3LDUuNjcsMCw4LjIyWiIgLz4KICA8cGF0aCBmaWxsPSIjMDgyREZGIiBkPSJNMTA5LjU1LDE1OS4xOWwxNi42OC0yOC45YzEuMjMuNzEsMi42NCwxLjEsNC4xMSwxLjFoOC45M2MyLjk0LDAsNS42NS0xLjU3LDcuMTItNC4xMWw0LjQ3LTcuNzRjMS40Ny0yLjU0LDEuNDctNS42NywwLTguMjJsLTEzLjY4LTIzLjY5Yy0xLjQ3LTIuNTQtNC4xOC00LjExLTcuMTItNC4xMWgtOC45M2MtMi45NCwwLTUuNjUsMS41Ny03LjEyLDQuMTFsLTMyLjEsNTUuNTljLTEuNDcsMi41NC0xLjQ3LDUuNjcsMCw4LjIybDQuNDcsNy43NGMxLjQ3LDIuNTQsNC4xOCw0LjExLDcuMTIsNC4xMWg4LjkzYzIuOTQsMCw1LjY1LTEuNTcsNy4xMi00LjExWiIgLz4KPC9zdmc+Cg=='

function envNumber(name, fallback, min = 1) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value >= min ? value : fallback
}

const MAX_CONCURRENCY = Math.max(1, Math.trunc(envNumber('MAGPIE_QWEN_CONCURRENCY', 4)))
const CATALOG_TIMEOUT_MS = envNumber('MAGPIE_QWEN_CATALOG_TIMEOUT_MS', 5_000)

/** 与 qwen CLI 共用同一份凭证；刷新/写回逻辑见 src/qoder-auth.mjs。 */
const auth = new QoderAuth({
  region: process.env.MAGPIE_QWEN_REGION,
  credentialPath: process.env.MAGPIE_QWEN_CREDS || undefined,
})

const forwarder = createForwarder({
  auth,
  region: process.env.MAGPIE_QWEN_REGION,
  gatewayBaseUrl: process.env.MAGPIE_QWEN_GATEWAY || undefined,
  defaultEffort: process.env.MAGPIE_QWEN_DEFAULT_EFFORT || 'high',
  autoConfirmPaid: process.env.MAGPIE_QWEN_AUTO_CONFIRM_PAID === '1',
  keepaliveMs: envNumber('MAGPIE_QWEN_KEEPALIVE_MS', 15_000),
  upstreamIdleTimeoutMs: envNumber('MAGPIE_QWEN_UPSTREAM_IDLE_MS', 600_000),
  debug: ['1', 'true'].includes(String(process.env.MAGPIE_QWEN_DEBUG ?? '').trim().toLowerCase()),
})

/** 目录缓存与 single-flight 刷新；TTL 内直接复用，避免每次列模型都打网关。 */
const CATALOG_TTL_MS = 5 * 60 * 1000
let catalogModels = null
let catalogAt = 0
let catalogPromise = null

async function refreshCatalog() {
  if (catalogModels && Date.now() - catalogAt < CATALOG_TTL_MS) return catalogModels
  if (catalogPromise) return catalogPromise
  catalogPromise = (async () => {
    try {
      const models = await fetchModelCatalog({
        auth,
        gatewayBaseUrl: forwarder.gatewayBaseUrl,
        timeoutMs: CATALOG_TIMEOUT_MS,
      })
      if (models.length > 0) {
        catalogModels = models
        catalogAt = Date.now()
        forwarder.setModels(models)
        return models
      }
    } catch (error) {
      console.warn(`[${PROVIDER}] 模型目录拉取失败，沿用内置模型表：${error?.message ?? error}`)
    }
    return null
  })().finally(() => {
    catalogPromise = null
  })
  return catalogPromise
}

/** Magpie 1.x 插件入口（default.server）。 */
export async function QwenCodeDirectPlugin() {
  // 启动时后台拉一次目录，让首批请求就能用上真实的思考档位/上下文上限。
  refreshCatalog().catch(() => {})
  return {
    // magpie 把会话 id（DSH 的 x-deepseek-harness-session-id 等）在这里告知；
    // 放进内部头传给 loader 的 fetch，用于稳定的上游 X-Session-Id（前缀缓存）。
    async 'chat.headers'(input, output) {
      if (input?.model?.providerID !== PROVIDER && input?.provider?.info?.id !== PROVIDER) return
      const session = String(input?.sessionID ?? '').trim()
      // magpie 自造的 "magpie-<24hex>" 不算具名会话。
      if (!session || /^magpie-[0-9a-f]{24}$/.test(session)) return
      if (output?.headers) output.headers[SESSION_HEADER] = session.slice(0, 128)
    },

    config(cfg) {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: PROVIDER_NAME,
        npm: '@ai-sdk/openai-compatible',
        api: DUMMY_BASE,
        models: staticMagpieModels(),
      }
    },

    auth: {
      provider: PROVIDER,
      icon: ICON,
      maxConcurrency: MAX_CONCURRENCY,
      methods: [
        {
          type: 'api',
          label: 'Qwen Code local sign-in (Qoder)',
          placeholder: 'local',
        },
      ],
      async loader(getAuth) {
        const account = await getAuth()
        if (!account || account.type !== 'api') return {}
        return {
          baseURL: DUMMY_BASE,
          apiKey: account.key || 'local',
          headers: {},
          fetch: (input, init) => forwarder.fetch(input, init),
        }
      },
      async usage(getAuth) {
        const account = await getAuth()
        if (!account || account.type !== 'api') {
          return { error: 'Add an account with any value (for example: local)', signIn: 'kept' }
        }
        const status = auth.status()
        return {
          plan: 'Qwen Code limited-free (direct)',
          user: status.userName || status.userId || 'local Qwen Code',
          // 健康账号不带 error，避免 Magpie 账号页常驻报错；余额提示见 README。
          ...(status.hasAccount ? {} : { error: status.error }),
          windows: [],
          resets: [],
        }
      },
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth: account } = {}) {
        const fallback = provider?.models ?? staticMagpieModels()
        try {
          const models = await refreshCatalog()
          return magpieModelsFromCatalog(models ?? catalogModels) ?? fallback
        } catch {
          return magpieModelsFromCatalog(catalogModels) ?? fallback
        }
      },
    },
  }
}

/** 兼容旧导入名（0.x 叫 QwenCodeCliPlugin）。 */
export const QwenCodeCliPlugin = QwenCodeDirectPlugin

export const _internal = {
  PROVIDER,
  ALIAS_MODEL,
  auth,
  forwarder,
  refreshCatalog,
  get catalogModels() {
    return catalogModels
  },
  get catalogAt() {
    return catalogAt
  },
  MAX_CONCURRENCY,
}

export default { id: PROVIDER, server: QwenCodeDirectPlugin }