import test from 'node:test'
import assert from 'node:assert/strict'
import {
  apply,
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

test('normalizes Claude relay routes to OpenAI Responses', () => {
  assert.equal(ensureOpenAIBaseUrl('https://qinghuaend.cn'), 'https://qinghuaend.cn/v1')
  assert.equal(ensureOpenAIBaseUrl('https://qinghuaend.cn/v1/'), 'https://qinghuaend.cn/v1')
  const provider = normalizeRelayProviderValue('qinghua-ccpro', {
    api: 'anthropic-messages',
    baseURL: 'https://qinghuaend.cn/v1',
    models: [{ name: 'claude-opus-5-5' }],
  })
  assert.equal(provider.api, 'openai-responses')
  assert.equal(provider.baseURL, 'https://qinghuaend.cn')
  assert.equal(provider.compat, undefined)
  assert.deepEqual(provider.models[0].input, ['text', 'image'])
})

test('normalizes GPT relay routes to OpenAI Responses', () => {
  const provider = normalizeRelayProviderValue('qinghua-gpt-key', {
    api: 'openai-completions',
    baseURL: 'https://qinghuaend.cn/v1',
    models: [{ id: 'gpt-6.1-sol' }],
  })
  assert.equal(provider.api, 'openai-responses')
  assert.equal(provider.baseURL, 'https://qinghuaend.cn')
  assert.equal(provider.compat, undefined)
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

test('migrates Gemini Responses routes to the Chat Completions bridge idempotently', () => {
  const provider = normalizeRelayProviderValue('qinghua-gemini', {
    api: 'openai-responses',
    apiKeyEnv: 'GEMINI_KEY',
    baseURL: 'https://qinghuaend.cn/v1/',
    headers: { 'x-custom': 'kept' },
    models: [{ name: 'gemini-4-argon' }, { id: 'gemini-4-carbon' }],
    compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: false },
  })
  assert.equal(provider.api, 'openai-completions')
  assert.equal(provider.baseURL, 'https://qinghuaend.cn/v1')
  assert.equal(provider.apiKeyEnv, 'GEMINI_KEY')
  assert.deepEqual(provider.headers, { 'x-custom': 'kept' })
  assert.equal(provider.compat.thinkingFormat, 'openai')
  assert.equal(provider.compat.supportsReasoningEffort, true)
  assert.equal(provider.compat.requiresThinkingAsText, false)
  assert.equal(provider.compat.maxTokensField, 'max_tokens')
  for (const model of provider.models) {
    assert.deepEqual(model.input, ['text', 'image'])
    assert.deepEqual(model.reasoningEfforts, { low: 'low', high: 'high' })
  }
  assert.deepEqual(normalizeRelayProviderValue('qinghua-gemini', provider), provider)
})

test('detects Gemini by model id even when the route has a custom group name', () => {
  const provider = normalizeRelayProviderValue('qinghua-google-paid', {
    api: 'openai-responses', baseURL: 'https://qinghuaend.cn',
    models: [{ id: 'gemini-4-carbon' }],
  })
  assert.equal(provider.api, 'openai-completions')
  assert.deepEqual(provider.models[0].reasoningEfforts, { low: 'low', high: 'high' })
  assert.deepEqual(normalizeModelProfiles(['future-model'], 'gemini')[0].reasoningEfforts, { low: 'low', high: 'high' })
})

test('provisions Gemini keys and models via the same action used by Settings', async (t) => {
  const credentials = new Map([['QINGHUA_RELAY_SESSION', JSON.stringify({ accessToken: 'fixture-session' })]])
  const providers = {}
  const groups = [
    { id: 11, name: 'gemini', platform: 'gemini', models: [{ name: 'gemini-4-argon' }, { name: 'gemini-4-carbon' }] },
    { id: 2, name: 'GPT', platform: 'openai', models: [{ id: 'gpt-6.1-sol' }] },
    { id: 3, name: 'ccpro', platform: 'anthropic', models: [{ name: 'claude-opus-5-5' }] },
    { id: 8, name: 'DeepSeek', platform: 'deepseek', models: ['deepseek-v4.1-flash-1017'] },
  ]
  let keyCreates = 0
  let handler
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname
    let data
    if (path.endsWith('/groups/available')) data = groups
    else if (path.endsWith('/model-plaza')) data = { groups }
    else if (path.endsWith('/keys') && options.method === 'POST') {
      keyCreates++
      data = { key: `fixture-key-${JSON.parse(options.body).group_id}` }
    } else if (path.endsWith('/keys')) data = []
    else throw new Error(`Unexpected network call: ${path}`)
    return Response.json({ code: 0, data })
  }
  const ctx = {
    effect: (fn) => fn(),
    on: () => () => {},
    credentials: {
      resolve: async (ref) => credentials.has(ref) ? { value: credentials.get(ref) } : undefined,
      describe: async (ref) => ({ configured: credentials.has(ref) }),
      set: async (ref, value) => { credentials.set(ref, value) },
      unset: async (ref) => { credentials.delete(ref) },
    },
    settings: {
      describe: () => [{ ns: 'fixture-llm-pi-ai', value: { providers } }],
      mutate: async (_ns, ops) => {
        for (const op of ops) {
          if (op.op === 'set') providers[op.path[1]] = op.value
          else delete providers[op.path[1]]
        }
      },
    },
    connection: { fetch: { register: (route) => { handler = route.fetch; return () => {} } } },
  }
  apply(ctx)
  const sync = async () => {
    const response = await handler(new Request('https://dsh.test/api/qinghua.relay', {
      method: 'POST', body: JSON.stringify({ action: 'provision' }),
    }))
    return response.json()
  }
  const first = await sync()
  assert.equal(first.ok, true)
  assert.deepEqual(first.data.failures, [])
  assert.equal(first.data.imported.find(group => group.route === 'qinghua-gemini').models, 2)
  assert.equal(providers['qinghua-gemini'].api, 'openai-completions')
  assert.equal(providers['qinghua-gemini'].baseURL, 'https://qinghuaend.cn/v1')
  assert.equal(providers['qinghua-gemini'].compat.thinkingFormat, 'openai')
  assert.equal(credentials.get('QINGHUA_GEMINI_API_KEY'), 'fixture-key-11')
  for (const route of ['qinghua-gpt', 'qinghua-ccpro', 'qinghua-deepseek']) {
    assert.equal(providers[route].api, 'openai-responses')
    assert.equal(providers[route].compat, undefined)
  }
  const second = await sync()
  assert.equal(second.ok, true)
  assert.equal(second.data.created.length, 0)
  assert.equal(keyCreates, 4)
})
