import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ensureOpenAIBaseUrl,
  modelIdOf,
  normalizeModelProfiles,
  normalizeRelayProviderValue,
} from '../index.js'

test('reads model ids from all supported plaza shapes', () => {
  assert.equal(modelIdOf('deepseek-v4.1-flash-1017'), 'deepseek-v4.1-flash-1017')
  assert.equal(modelIdOf({ id: 'deepseek-v4.1-flash-1017' }), 'deepseek-v4.1-flash-1017')
  assert.equal(modelIdOf({ model_id: 'deepseek-v4.1-flash-1017' }), 'deepseek-v4.1-flash-1017')
  assert.equal(modelIdOf({ name: 'deepseek-v4.1-flash-1017' }), 'deepseek-v4.1-flash-1017')
})

test('normalizes Claude relay routes to Anthropic Messages', () => {
  assert.equal(ensureOpenAIBaseUrl('https://qinghuaend.cn'), 'https://qinghuaend.cn/v1')
  assert.equal(ensureOpenAIBaseUrl('https://qinghuaend.cn/v1/'), 'https://qinghuaend.cn/v1')
  const provider = normalizeRelayProviderValue('qinghua-ccpro', {
    api: 'anthropic-messages',
    baseURL: 'https://qinghuaend.cn',
    models: [{ name: 'claude-opus-5-5' }],
  })
  assert.equal(provider.api, 'anthropic-messages')
  assert.equal(provider.baseURL, 'https://qinghuaend.cn')
  assert.deepEqual(provider.compat, { forceAdaptiveThinking: true })
  assert.deepEqual(provider.models[0].input, ['text', 'image'])
})

test('uses Responses for DeepSeek and keeps its larger output limit', () => {
  const provider = normalizeRelayProviderValue('qinghua-deepseek', {
    api: 'openai-completions',
    baseURL: 'https://qinghuaend.cn/v1',
    models: [{ name: 'deepseek-v4.1-flash-1017' }],
  })
  assert.equal(provider.api, 'openai-responses')
  assert.equal(provider.baseURL, 'https://qinghuaend.cn')
  assert.equal(provider.models[0].maxTokens, 384000)
  assert.equal(provider.compat, undefined)
})

test('preserves Claude model metadata and reasoning levels', () => {
  const models = normalizeModelProfiles(['claude-opus-5-5'], 'anthropic')
  assert.equal(models[0].id, 'claude-opus-5-5')
  assert.equal(models[0].name, 'claude-opus-5-5')
  assert.deepEqual(models[0].input, ['text', 'image'])
  assert.equal(models[0].maxTokens, 128000)
  assert.deepEqual(Object.keys(models[0].reasoningEfforts), ['low', 'medium', 'high', 'xhigh', 'max'])
})
