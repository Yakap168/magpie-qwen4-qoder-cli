import test from 'node:test'
import assert from 'node:assert/strict'
import { CATALOG_PATH, fetchModelCatalog, modelsFromCatalog, reasoningEffortsFrom } from '../src/catalog.mjs'

const payload = {
  qcode: [
    {
      key: 'qmodel_latest',
      display_name: 'Qwen4-Max',
      format: 'openai',
      enable: true,
      status: 'idle',
      is_vl: true,
      is_reasoning: true,
      max_input_tokens: 1_000_000,
      price_factor: 0.4,
      thinking_config: {
        disabled: {},
        enabled: { efforts: { xhigh: {}, high: { is_default: true }, low: {} }, is_default: true },
      },
    },
    {
      key: 'qmodel_38max',
      display_name: 'Qwen3.8-Max',
      format: 'openai',
      enable: true,
      is_vl: true,
      is_reasoning: true,
      max_input_tokens: 180_000,
      thinking_config: {
        disabled: {},
        enabled: { efforts: { xhigh: {}, low: {}, medium: { is_default: true } } },
      },
    },
    {
      key: 'qfmodel',
      display_name: 'Qwen3.8-Flash',
      format: 'openai',
      enable: true,
      is_vl: true,
      is_reasoning: true,
      is_free: true,
      max_input_tokens: 180_000,
      thinking_config: {
        disabled: {},
        enabled: { efforts: { xhigh: {}, low: {}, medium: { is_default: true } } },
      },
    },
    { key: 'disabled-model', enable: false, format: 'openai' },
    { key: 'other-format', enable: true, format: 'anthropic' },
    { not_a_model: true },
  ],
}

test('目录映射保留真实上下文、视觉能力与思考档位', () => {
  const models = modelsFromCatalog(payload)
  assert.deepEqual(models.map((model) => model.id), ['qmodel_latest', 'qmodel_38max', 'qfmodel'])

  const latest = models[0]
  assert.equal(latest.name, 'Qwen4-Max')
  assert.equal(latest.contextWindow, 1_000_000)
  assert.equal(latest.maxTokens, 128_000)
  assert.deepEqual(latest.input, ['text', 'image'])
  assert.deepEqual(latest.reasoningEfforts, { off: 'none', low: 'low', high: 'high', xhigh: 'xhigh' })

  const max38 = models[1]
  assert.equal(max38.contextWindow, 180_000)
  assert.deepEqual(max38.reasoningEfforts, { off: 'none', low: 'low', medium: 'medium', xhigh: 'xhigh' })

  const flash = models[2]
  assert.equal(flash.contextWindow, 180_000)
  assert.equal(flash.isFree, true)
  assert.match(flash.description, /免费额度模型/)
})

test('目录缺 thinking_config 时给推理模型保守档位', () => {
  assert.deepEqual(reasoningEffortsFrom({ is_reasoning: true }), {
    off: 'none',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
  })
  assert.deepEqual(reasoningEffortsFrom({ is_reasoning: false }), {})
  assert.deepEqual(reasoningEffortsFrom({ thinking_config: { enabled: { efforts: { low: {} } } } }), { low: 'low' })
})

test('modelsFromCatalog 对异常输入返回空数组', () => {
  assert.deepEqual(modelsFromCatalog(null), [])
  assert.deepEqual(modelsFromCatalog({ qcode: 'nope' }), [])
  assert.deepEqual(modelsFromCatalog({}), [])
})

test('fetchModelCatalog 带 Qoder 鉴权头并解析目录', async () => {
  const seen = []
  const models = await fetchModelCatalog({
    auth: { getAccessToken: async () => 'token-1' },
    gatewayBaseUrl: 'https://gateway.example.test/qsvr/',
    clientType: '13',
    clientVersion: '1.0.0-preview.2',
    fetchImpl: async (url, init) => {
      seen.push({ url, headers: init.headers })
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, `https://gateway.example.test/qsvr${CATALOG_PATH}`)
  assert.equal(seen[0].headers.Authorization, 'Bearer token-1')
  assert.equal(seen[0].headers['Cosy-ClientType'], '13')
  assert.equal(seen[0].headers['Cosy-Version'], '1.0.0-preview.2')
  assert.equal(models.length, 3)
})

test('fetchModelCatalog 在上游失败时抛错', async () => {
  await assert.rejects(() => fetchModelCatalog({
    auth: { getAccessToken: async () => 'token-1' },
    gatewayBaseUrl: 'https://gateway.example.test/qsvr',
    fetchImpl: async () => new Response('nope', { status: 503 }),
  }), /HTTP 503/)
})

test('fetchModelCatalog 错误体脱敏：token 片段不进错误消息/日志', async () => {
  await assert.rejects(() => fetchModelCatalog({
    auth: { getAccessToken: async () => 'token-1' },
    gatewayBaseUrl: 'https://gateway.example.test/qsvr',
    fetchImpl: async () => new Response('invalid token: dt-abcdef123456789', { status: 401 }),
  }), (error) => {
    assert.match(error.message, /HTTP 401/)
    assert.equal(error.message.includes('dt-abcdef123456789'), false)
    assert.match(error.message, /\[REDACTED\]/)
    return true
  })
})

test('目录保留键 __proto__ 被过滤，不能当模型 id', () => {
  const models = modelsFromCatalog({ qcode: [
    { key: '__proto__', enable: true, format: 'openai', display_name: 'evil' },
    { key: 'qfmodel', enable: true, format: 'openai', display_name: 'Flash', is_free: true },
  ] })
  assert.deepEqual(models.map((m) => m.id), ['qfmodel'])
})
