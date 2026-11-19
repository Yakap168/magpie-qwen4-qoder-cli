import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ALIAS_MODEL,
  BUILTIN_MODELS,
  PROVIDER,
  clampEffort,
  findModel,
  magpieModel,
  magpieModelsFromCatalog,
  normalizeEffort,
  resolveUpstreamModel,
  staticMagpieModels,
} from '../src/models.mjs'

test('normalizeEffort：各种写法归一化', () => {
  assert.equal(normalizeEffort('OFF'), 'none')
  assert.equal(normalizeEffort('disabled'), 'none')
  assert.equal(normalizeEffort('none'), 'none')
  assert.equal(normalizeEffort('minimal'), 'minimal')
  assert.equal(normalizeEffort('low'), 'low')
  assert.equal(normalizeEffort('mid'), 'medium')
  assert.equal(normalizeEffort('HIGH'), 'high')
  assert.equal(normalizeEffort('extra-high'), 'xhigh')
  assert.equal(normalizeEffort('max'), 'max')
  assert.equal(normalizeEffort('bogus'), null)
  assert.equal(normalizeEffort(undefined), null)
})

test('clampEffort：支持原样、不支持就近（平手取高）、none 特判', () => {
  const efforts = { off: 'none', low: 'low', high: 'high', xhigh: 'xhigh' }
  assert.equal(clampEffort('low', efforts), 'low')
  assert.equal(clampEffort('none', efforts), 'none')
  assert.equal(clampEffort('medium', efforts), 'high')
  assert.equal(clampEffort('minimal', efforts), 'low')
  assert.equal(clampEffort('max', efforts), 'xhigh')
  // 关不掉思考的模型：none → 最低档。
  assert.equal(clampEffort('none', { low: 'low', high: 'high' }), 'low')
  // 无档位信息：原样透传。
  assert.equal(clampEffort('medium', {}), 'medium')
  assert.equal(clampEffort('medium', undefined), 'medium')
})

test('resolveUpstreamModel：别名与 provider 前缀', () => {
  assert.equal(resolveUpstreamModel('qwen4-max'), 'qmodel_latest')
  assert.equal(resolveUpstreamModel(`${PROVIDER}/qwen4-max`), 'qmodel_latest')
  assert.equal(resolveUpstreamModel(''), 'qmodel_latest')
  assert.equal(resolveUpstreamModel(undefined), 'qmodel_latest')
  assert.equal(resolveUpstreamModel('qfmodel'), 'qfmodel')
  assert.equal(resolveUpstreamModel(`${PROVIDER}/qfmodel`), 'qfmodel')
})

test('magpieModel：variants 来自真实档位，能力标志一致', () => {
  const latest = magpieModel(BUILTIN_MODELS[0])
  assert.equal(latest.id, 'qmodel_latest')
  assert.deepEqual(Object.keys(latest.variants).sort(), ['high', 'low', 'none', 'xhigh'])
  assert.deepEqual(latest.variants.none, { reasoningEffort: 'none' })
  assert.equal(latest.attachment, true)
  assert.equal(latest.tool_call, true)
  assert.equal(latest.reasoning, true)
  assert.equal(latest.capabilities.toolcall, true)
  assert.equal(latest.capabilities.input.image, true)
  assert.equal(latest.limit.context, 1_000_000)
  assert.equal(latest.api.npm, '@ai-sdk/openai-compatible')

  const flash = magpieModel(findModel(BUILTIN_MODELS, 'qfmodel'))
  assert.deepEqual(Object.keys(flash.variants).sort(), ['low', 'medium', 'none', 'xhigh'])
  assert.equal(flash.free, true)
  assert.equal(flash.limit.context, 180_000)
})

test('staticMagpieModels / magpieModelsFromCatalog：都含别名；空目录返回 null', () => {
  const staticMap = staticMagpieModels()
  assert.ok(staticMap[ALIAS_MODEL])
  assert.ok(staticMap.qmodel_latest)
  assert.ok(staticMap.qfmodel)
  assert.equal(staticMap[ALIAS_MODEL].api.id, ALIAS_MODEL)

  const catalogMap = magpieModelsFromCatalog([
    { id: 'qmodel_latest', name: 'Qwen4-Max', contextWindow: 1_000_000, maxTokens: 128_000, input: ['text', 'image'], reasoningEfforts: { off: 'none', low: 'low', high: 'high', xhigh: 'xhigh' } },
    { id: 'qfmodel', name: 'Qwen3.8-Flash', contextWindow: 180_000, maxTokens: 128_000, input: ['text', 'image'], reasoningEfforts: { off: 'none', low: 'low', medium: 'medium', xhigh: 'xhigh' }, isFree: true },
  ])
  assert.ok(catalogMap[ALIAS_MODEL])
  assert.ok(catalogMap.qfmodel)
  assert.equal(magpieModelsFromCatalog([]), null)
  assert.equal(magpieModelsFromCatalog(null), null)
})