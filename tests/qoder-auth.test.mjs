import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { QoderAuth, expiryFromDuration, parseExpiry } from '../src/qoder-auth.mjs'

const NOW = 1_700_000_000_000

function makeStore(overrides = {}) {
  return {
    version: 1,
    accounts: {
      cn: {
        region: 'cn',
        userId: 'user-1',
        userName: 'tester',
        accessToken: 'old-token',
        refreshToken: 'rt-old',
        expiresAt: NOW - 1,
        refreshTokenExpiresAt: NOW + 30 * 24 * 3600 * 1000,
        createdAt: NOW - 1000,
        updatedAt: NOW - 1000,
        ...overrides,
      },
    },
  }
}

function setup(t, overrides) {
  const dir = mkdtempSync(path.join(tmpdir(), 'magpie-qwen4-auth-'))
  const credentialPath = path.join(dir, 'qoder_oauth_creds.json')
  writeFileSync(credentialPath, `${JSON.stringify(makeStore(overrides), null, 2)}\n`, 'utf8')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, credentialPath }
}

function readStore(credentialPath) {
  return JSON.parse(readFileSync(credentialPath, 'utf8'))
}

test('parseExpiry 与 expiryFromDuration 区分绝对时间和相对时长', () => {
  assert.equal(parseExpiry(1_700_000_000), 1_700_000_000_000)
  assert.equal(parseExpiry(1_700_000_000_000), 1_700_000_000_000)
  assert.equal(parseExpiry('2026-01-01T00:00:00Z'), Date.parse('2026-01-01T00:00:00Z'))
  assert.equal(parseExpiry(undefined), undefined)
  assert.equal(expiryFromDuration(3600, NOW), NOW + 3_600_000)
  assert.equal(expiryFromDuration(2_592_000, NOW), NOW + 2_592_000_000)
  assert.equal(expiryFromDuration(0, NOW), undefined)
})

test('refresh 用 expires_in 计算到期时间并原子写回', async (t) => {
  const { credentialPath } = setup(t)
  const calls = []
  const auth = new QoderAuth({
    credentialPath,
    region: 'cn',
    now: () => NOW,
    logger: { info() {}, warn() {}, error() {} },
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) })
      return new Response(JSON.stringify({
        device_token: 'new-token',
        refresh_token: 'rt-new',
        expires_in: 3600,
        refresh_token_expires_in: 86_400,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  })

  const token = await auth.getAccessToken()
  assert.equal(token, 'new-token')
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/api\/v1\/deviceToken\/refresh$/)
  assert.deepEqual(calls[0].body, { refresh_token: 'rt-old' })

  const store = readStore(credentialPath)
  assert.equal(store.accounts.cn.accessToken, 'new-token')
  assert.equal(store.accounts.cn.refreshToken, 'rt-new')
  assert.equal(store.accounts.cn.expiresAt, NOW + 3_600_000)
  assert.equal(store.accounts.cn.refreshTokenExpiresAt, NOW + 86_400_000)
  assert.equal(store.accounts.cn.updatedAt, NOW)
  assert.equal(store.accounts.cn.userId, 'user-1')
})

test('并发 forceRefresh 只打一次刷新请求', async (t) => {
  const { credentialPath } = setup(t)
  let calls = 0
  let release
  const pending = new Promise((resolve) => { release = resolve })
  const auth = new QoderAuth({
    credentialPath,
    region: 'cn',
    now: () => NOW,
    logger: { info() {}, warn() {}, error() {} },
    fetchImpl: async () => {
      calls += 1
      await pending
      return new Response(JSON.stringify({ device_token: 'new-token', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })

  const first = auth.getAccessToken({ forceRefresh: true })
  const second = auth.getAccessToken({ forceRefresh: true })
  release()
  assert.deepEqual(await Promise.all([first, second]), ['new-token', 'new-token'])
  assert.equal(calls, 1)
})

test('invalid_grant 时若磁盘 refresh_token 已被 CLI 轮换则重试', async (t) => {
  const { credentialPath } = setup(t)
  let calls = 0
  const auth = new QoderAuth({
    credentialPath,
    region: 'cn',
    now: () => NOW,
    logger: { info() {}, warn() {}, error() {} },
    fetchImpl: async (url, init) => {
      calls += 1
      const body = JSON.parse(init.body)
      if (calls === 1) {
        // 模拟 qwen CLI 在桥接刷新期间先一步轮换了 refresh_token。
        writeFileSync(credentialPath, `${JSON.stringify(makeStore({ refreshToken: 'rt-other' }), null, 2)}\n`, 'utf8')
        assert.deepEqual(body, { refresh_token: 'rt-old' })
        return new Response('invalid grant', { status: 401 })
      }
      assert.deepEqual(body, { refresh_token: 'rt-other' })
      return new Response(JSON.stringify({ device_token: 'new-token-2', refresh_token: 'rt-new', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })

  const token = await auth.getAccessToken()
  assert.equal(token, 'new-token-2')
  assert.equal(calls, 2)
  assert.equal(readStore(credentialPath).accounts.cn.refreshToken, 'rt-new')
})

test('凭证缺失时给出可读错误，且 status 不泄露 token', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'magpie-qwen4-auth-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const auth = new QoderAuth({
    credentialPath: path.join(dir, 'missing.json'),
    logger: { info() {}, warn() {}, error() {} },
  })
  await assert.rejects(() => auth.getAccessToken(), /未找到 Qwen Code 登录凭证/)
  const status = auth.status()
  assert.equal(status.hasAccount, false)
  assert.equal(JSON.stringify(status).includes('old-token'), false)
  assert.equal(JSON.stringify(status).includes('rt-old'), false)
})
