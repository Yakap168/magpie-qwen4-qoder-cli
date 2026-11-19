/**
 * Qoder OAuth 凭证读取、刷新与写回。
 *
 * 凭证来源与 Qwen Code CLI 完全一致：
 *   ~/.qwen/qoder_oauth_creds.json
 *   { version: 1, accounts: { cn: { region, userId, userName, accessToken,
 *     refreshToken, expiresAt, refreshTokenExpiresAt, createdAt, updatedAt } } }
 *
 * 刷新协议（从 qwen-code 1.0.0-preview.2 二进制逆出并实测）：
 *   POST {openApiBaseUrl}/api/v1/deviceToken/refresh
 *   Content-Type: application/json
 *   body: { "refresh_token": "drt-..." }
 *   响应: device_token | token | access_token 三选一，另可带 refresh_token /
 *         expires_at / expires_in / refresh_token_expires_at / refresh_token_expires_in
 *
 * 刷新成功后会把新凭证原子写回同一文件（保留 schema 与其它字段），
 * 保证 Qwen Code CLI 与 DSH 插件共用同一份有效凭证。
 *
 * 并发/共存：Qwen Code CLI 也可能刷新同一文件。这里每次取 token 前都用
 * mtime+size 检查凭证文件是否变化，变化则重新加载；刷新写回前再次确认
 * refresh_token 未被其它进程轮换，避免把对方的新凭证覆盖回旧值。
 */
import { chmodSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** Qoder 地域端点。 */
export const QODER_REGIONS = {
  cn: {
    websiteBaseUrl: 'https://qoder.cn',
    openApiBaseUrl: 'https://openapi.qoder.com.cn',
    gatewayBaseUrl: 'https://gateway.qoder.com.cn/qsvr',
  },
  global: {
    websiteBaseUrl: 'https://qoder.com',
    openApiBaseUrl: 'https://openapi.qoder.sh',
    gatewayBaseUrl: 'https://api2.qoder.sh/qsvr',
  },
}

/** access token 默认有效期：30 天（与 qwen-code 内部常量一致）。 */
const DEFAULT_ACCESS_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** 提前刷新的余量：5 分钟。 */
const DEFAULT_REFRESH_SKEW_MS = 5 * 60 * 1000
/** 刷新请求超时：30 秒。 */
const REFRESH_TIMEOUT_MS = 30 * 1000

/** 凭证/刷新错误。 */
export class QoderAuthError extends Error {
  /**
   * @param {string} code 稳定的错误码：no_credentials / no_account / invalid_grant / http / invalid_response / cancelled
   * @param {string} message 面向用户的中文提示
   * @param {{status?: number, detail?: unknown}} [options]
   */
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'QoderAuthError'
    this.code = code
    this.status = options.status
    this.detail = options.detail
  }
}

/** 默认凭证路径：~/.qwen/qoder_oauth_creds.json。 */
export function defaultCredentialPath() {
  return path.join(homedir(), '.qwen', 'qoder_oauth_creds.json')
}

/** 规范化地域名，非法值回退到 cn。 */
export function normalizeRegion(region) {
  const value = String(region ?? '').trim().toLowerCase()
  return value === 'global' ? 'global' : 'cn'
}

/** 返回该地域的端点集合。 */
export function regionEndpoints(region) {
  return QODER_REGIONS[normalizeRegion(region)]
}

/** 把秒 / 毫秒 / ISO 字符串统一成毫秒时间戳；无法解析时返回 undefined。 */
export function parseExpiry(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return undefined
    if (value > 1e12) return Math.trunc(value)
    return Math.trunc(value * 1000)
  }
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) return parseExpiry(numeric)
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * 把 OAuth 的 `expires_in`（相对时长，通常以秒计）换算成绝对毫秒时间戳。
 * 与 {@link parseExpiry} 的区别：后者把数字当绝对时间，直接用在 expires_in 上
 * 会得到 1970 年，导致每个请求都触发刷新。
 * @param {unknown} value
 * @param {number} [now]
 * @returns {number | undefined}
 */
export function expiryFromDuration(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') return undefined
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return undefined
  // OAuth 的 expires_in 按秒计（RFC 6749）；30 天 = 2,592,000。
  return Math.trunc(now + number * 1000)
}

/** 读 JSON 文件，失败时给出可诊断错误。 */
function readJsonFile(filePath) {
  if (!existsSync(filePath)) {
    throw new QoderAuthError(
      'no_credentials',
      `未找到 Qwen Code 登录凭证：${filePath}。请先运行 qwen CLI，在交互界面用 /auth 完成 Qoder 登录。`,
    )
  }
  let text
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (error) {
    throw new QoderAuthError('no_credentials', `读取 Qwen Code 凭证失败：${filePath}（${error?.message ?? error}）`)
  }
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object')
    return parsed
  } catch (error) {
    throw new QoderAuthError('invalid_response', `Qwen Code 凭证文件不是合法 JSON：${filePath}（${error?.message ?? error}）`)
  }
}

/** 判断是否为超时/主动取消；这类错误重试没有意义。 */
function isAbortError(error) {
  return error?.name === 'AbortError' || error?.name === 'TimeoutError' || error?.code === 'ABORT_ERR'
}

/**
 * Qoder 出站请求的重试/退避包装：抛出的网络错误重试一次
 * （HTTP 5xx 是正常返回的响应，由调用方按状态码处理，不在此重试）。
 * @template T
 * @param {() => Promise<T>} operation
 */
async function withRetry(operation) {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof QoderAuthError && error.code === 'invalid_grant') throw error
    if (isAbortError(error)) throw error
    await new Promise((resolve) => setTimeout(resolve, 300))
    return operation()
  }
}

/** 取对象里的字符串字段（trim 后非空）。 */
function pickString(payload, keys) {
  const value = pickRaw(payload, keys)
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** 取对象里的原始字段。 */
function pickRaw(payload, keys) {
  if (!payload || typeof payload !== 'object') return undefined
  for (const key of keys) {
    const value = payload[key]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

/**
 * Qoder 凭证管理器。一个实例对应一个 region；刷新采用 single-flight，避免并发重复刷新。
 */
export class QoderAuth {
  /**
   * @param {{
   *   credentialPath?: string,
   *   region?: string,
   *   refreshSkewMs?: number,
   *   fetchImpl?: typeof fetch,
   *   logger?: {info?: Function, warn?: Function, error?: Function},
   *   now?: () => number,
   * }} [options]
   */
  constructor(options = {}) {
    this.credentialPath = options.credentialPath ?? defaultCredentialPath()
    this.region = normalizeRegion(options.region)
    this.refreshSkewMs = Number.isFinite(options.refreshSkewMs) ? options.refreshSkewMs : DEFAULT_REFRESH_SKEW_MS
    this.fetchImpl = options.fetchImpl ?? fetch
    this.logger = options.logger ?? console
    this.now = options.now ?? Date.now
    this._refreshing = undefined
    this._account = undefined
    this._accountKey = undefined
    this._signature = undefined
    this._refreshedAt = undefined
    this._lastError = undefined
  }

  /** 地域端点。 */
  get endpoints() {
    return QODER_REGIONS[this.region]
  }

  /** 凭证文件的轻量签名（mtime + size），用于发现 CLI 的并发刷新。 */
  _fileSignature() {
    try {
      const stat = statSync(this.credentialPath)
      return `${stat.mtimeMs}:${stat.size}`
    } catch {
      return undefined
    }
  }

  /** 丢弃内存缓存，下次访问时重新读盘。 */
  reload() {
    this._account = undefined
    this._accountKey = undefined
    this._signature = undefined
    return this.account
  }

  /**
   * 当前地域的账号凭证；磁盘文件变化或没有该地域账号时重新解析。
   * @returns {Record<string, any>}
   */
  get account() {
    const signature = this._fileSignature()
    if (this._account && signature !== undefined && signature === this._signature) return this._account
    const store = readJsonFile(this.credentialPath)
    const accounts = store.accounts && typeof store.accounts === 'object' ? store.accounts : {}
    let accountKey = this.region
    let account = accounts[accountKey]
    if (!account && Object.keys(accounts).length === 1) {
      accountKey = Object.keys(accounts)[0]
      account = accounts[accountKey]
      if (account?.region) this.region = normalizeRegion(account.region)
      else this.region = normalizeRegion(accountKey)
    }
    if (!account || typeof account !== 'object') {
      throw new QoderAuthError(
        'no_account',
        `Qwen Code 凭证中没有可用账号（region=${this.region}）。请运行 qwen CLI 并用 /auth 登录 Qoder 账号。`,
      )
    }
    if (!account.accessToken || !account.refreshToken) {
      throw new QoderAuthError(
        'no_account',
        'Qwen Code 凭证缺少 accessToken/refreshToken（可能未完成 Qoder 登录）。请运行 qwen CLI 重新认证。',
      )
    }
    this._account = account
    // 记住实际读到的 key（单账号兜底时可能与 region 不同），写回时不能覆盖错条目。
    this._accountKey = accountKey
    this._signature = signature
    return account
  }

  /** 最近一次错误（诊断用）。 */
  get lastError() {
    return this._lastError
  }

  /** 凭证状态摘要（不含敏感 token）。 */
  status() {
    try {
      const account = this.account
      const expiresAt = parseExpiry(account.expiresAt)
      return {
        credentialPath: this.credentialPath,
        region: this.region,
        hasAccount: true,
        userName: account.userName ?? '',
        userId: account.userId ?? '',
        accessTokenExpiresAt: expiresAt ?? null,
        accessTokenExpiresInMs: expiresAt ? expiresAt - this.now() : null,
        refreshTokenExpiresAt: parseExpiry(account.refreshTokenExpiresAt) ?? null,
        canRefresh: Boolean(account.refreshToken),
        refreshedAt: this._refreshedAt ?? null,
        lastError: this._lastError ? { code: this._lastError.code, message: this._lastError.message } : null,
      }
    } catch (error) {
      return {
        credentialPath: this.credentialPath,
        region: this.region,
        hasAccount: false,
        error: error instanceof Error ? error.message : String(error),
        lastError: this._lastError ? { code: this._lastError.code, message: this._lastError.message } : null,
      }
    }
  }

  /**
   * 取得可用的 access token；即将过期或强制刷新时先刷新并写回磁盘。
   * @param {{forceRefresh?: boolean, signal?: AbortSignal}} [options]
   * @returns {Promise<string>}
   */
  async getAccessToken(options = {}) {
    const account = this.account
    const expiresAt = parseExpiry(account.expiresAt)
    const stillValid = expiresAt !== undefined && expiresAt - this.now() > this.refreshSkewMs
    if (!options.forceRefresh && (stillValid || expiresAt === undefined)) {
      // 过期时间未知时先试当前 token；由上游 401 驱动一次强制刷新。
      return String(account.accessToken)
    }
    try {
      return await this.refresh({ signal: options.signal })
    } catch (error) {
      this._lastError = error instanceof Error ? error : new Error(String(error))
      if (options.forceRefresh) throw error
      // 自动刷新失败但旧 token 可能仍可用，交给上游 401 兜底提示。
      this.logger.warn?.(`[magpie-qwen4] token 刷新失败，沿用旧 token：${error?.message ?? error}`)
      return String(account.accessToken)
    }
  }

  /**
   * 用 refreshToken 换取新的 accessToken，成功后原子写回凭证文件。
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<string>}
   */
  async refresh(options = {}) {
    if (this._refreshing) return this._refreshing
    this._refreshing = (async () => {
      this.reload()
      const first = this.account
      try {
        return await this._doRefresh(first, options)
      } catch (error) {
        // 另一个进程（qwen CLI）可能刚轮换过 refresh_token：读盘后换新的再试一次。
        this.reload()
        const fresh = this.account
        if (error instanceof QoderAuthError && error.code === 'invalid_grant' && fresh.refreshToken !== first.refreshToken) {
          this.logger.info?.('[magpie-qwen4] 检测到凭证已被其它进程刷新，改用磁盘上的新 refresh_token 重试')
          return await this._doRefresh(fresh, options)
        }
        throw error
      }
    })().finally(() => {
      this._refreshing = undefined
    })
    return this._refreshing
  }

  /** @private 用给定账号的 refreshToken 刷新并写回。 */
  async _doRefresh(account, options = {}) {
    const url = `${this.endpoints.openApiBaseUrl}/api/v1/deviceToken/refresh`
    const signal = options.signal ?? AbortSignal.timeout(REFRESH_TIMEOUT_MS)
    this.logger.info?.(`[magpie-qwen4] 正在刷新 Qoder access token（region=${this.region}）`)
    let response
    try {
      response = await withRetry(() => this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ refresh_token: account.refreshToken }),
        signal,
      }))
    } catch (error) {
      throw this._decorate(new QoderAuthError('http', `Qoder token 刷新请求失败：${error?.message ?? error}`), error)
    }
    if (response.status === 400 || response.status === 401) {
      const detail = await response.text().catch(() => '')
      throw new QoderAuthError(
        'invalid_grant',
        'Qoder 拒绝了刷新请求（refresh_token 可能已失效）。请运行 qwen CLI 并用 /auth 重新登录。',
        { status: response.status, detail },
      )
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new QoderAuthError('http', `Qoder token 刷新失败：HTTP ${response.status}`, {
        status: response.status,
        detail,
      })
    }
    let payload
    try {
      payload = await response.json()
    } catch {
      throw new QoderAuthError('invalid_response', 'Qoder token 刷新返回了非法 JSON')
    }
    const accessToken = pickString(payload, ['device_token', 'token', 'access_token'])
    if (!accessToken) {
      throw new QoderAuthError('invalid_response', 'Qoder token 刷新响应中没有 access token', { detail: payload })
    }
    const now = this.now()
    const refreshToken = pickString(payload, ['refresh_token']) ?? String(account.refreshToken)
    // expires_at 是绝对时间；expires_in 是相对秒数，不能走 parseExpiry
    // （否则 30 天会被当成 1970 年，导致每个请求都刷新）。
    const expiresAt = parseExpiry(pickRaw(payload, ['expires_at']))
      ?? expiryFromDuration(pickRaw(payload, ['expires_in']), now)
      ?? now + DEFAULT_ACCESS_TOKEN_TTL_MS
    const refreshExpiresAt = parseExpiry(pickRaw(payload, ['refresh_token_expires_at']))
      ?? expiryFromDuration(pickRaw(payload, ['refresh_token_expires_in']), now)
    const nextAccount = {
      ...account,
      accessToken,
      refreshToken,
      expiresAt,
      ...(refreshExpiresAt !== undefined ? { refreshTokenExpiresAt: refreshExpiresAt } : {}),
      updatedAt: now,
    }
    const adopted = this._writeBack(nextAccount, account.refreshToken)
    this._account = adopted ?? nextAccount
    this._signature = this._fileSignature()
    this._refreshedAt = now
    this._lastError = undefined
    // 日志不能破坏返回路径：adopted 的磁盘账号可能没有可解析的 expiresAt。
    const loggedExpiry = parseExpiry(this._account.expiresAt)
    this.logger.info?.(`[magpie-qwen4] Qoder token 已刷新并写回${loggedExpiry ? `（过期时间 ${new Date(loggedExpiry).toISOString()}）` : ''}`)
    return String(this._account.accessToken)
  }

  /**
   * 原子写回凭证文件；若磁盘上的 refresh_token 已被其它进程换成新的，
   * 放弃本次写回并采用磁盘版本，避免覆盖对方的有效凭证。
   * @param {Record<string, any>} nextAccount
   * @param {string} expectedRefreshToken 发起刷新时使用的 refresh_token
   * @returns {Record<string, any> | undefined} 抢先写出的磁盘账号（如果有）
   * @private
   */
  _writeBack(nextAccount, expectedRefreshToken) {
    const filePath = this.credentialPath
    const store = readJsonFile(filePath)
    const accounts = store.accounts && typeof store.accounts === 'object' ? store.accounts : {}
    // 写回实际读取的账号 key，而不是可能被规范化过的 region。
    const accountKey = this._accountKey ?? this.region
    const current = accounts[accountKey]
    if (current && typeof current === 'object' && current.refreshToken && current.refreshToken !== expectedRefreshToken) {
      this.logger.info?.('[magpie-qwen4] 凭证文件已被其它进程更新，采用磁盘版本，跳过本次写回')
      return { ...current }
    }
    accounts[accountKey] = nextAccount
    const nextStore = { ...store, accounts }
    const text = `${JSON.stringify(nextStore, null, 2)}\n`
    const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
    try {
      writeFileSync(tmpPath, text, { encoding: 'utf8', mode: 0o600 })
      try {
        chmodSync(tmpPath, 0o600)
      } catch {
        // Windows 上 chmod 可能无效，忽略。
      }
      renameSync(tmpPath, filePath)
    } catch (error) {
      try {
        unlinkSync(tmpPath)
      } catch {
        // 忽略清理失败。
      }
      throw this._decorate(new QoderAuthError('invalid_response', `写回 Qwen Code 凭证失败：${error?.message ?? error}`), error)
    }
    return undefined
  }

  /** @private 保留底层错误便于诊断 */
  _decorate(authError, cause) {
    if (cause instanceof Error && cause.cause === undefined) authError.cause = cause
    this._lastError = authError
    return authError
  }
}
