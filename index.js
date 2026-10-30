/**
 * Host half of @local/qinghua-relay.
 *
 * Talks to the 情话中转站 deployment (Sub2API at https://qinghuaend.cn,
 * HTTP API under /api/v1, envelope `{ code, message, data }`):
 *   - email verification code registration / password login (JWT access + refresh)
 *   - one relay API key per model group (GPT / ccpro / ccmax / DeepSeek ...)
 *   - imports each group as a pi-ai provider route in the DSH Models settings,
 *     using the model plaza as the authoritative per-group model list
 *   - balance, payment orders, order polling
 *
 * The browser half calls the single route `POST /api/qinghua.relay`.
 */

/** 情话中转站 official endpoint; users only install the plugin, no configuration needed. */
const DEFAULT_BASE_URL = 'https://qinghuaend.cn'
const SESSION_REF = 'QINGHUA_RELAY_SESSION'
const ROUTE_PATH = '/api/qinghua.relay'
const ROUTE_PREFIX = 'qinghua-'

/** Imported models declare vision input, a 1M window and the upstream output limit. */
const CONTEXT_WINDOW = 1000000
const DEEPSEEK_MAX_TOKENS = 384000
const STANDARD_MAX_TOKENS = 128000
const REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Claude 5.5 only exposes effort levels accepted by the upstream adaptive-thinking API. */
const CLAUDE_ADAPTIVE_PATTERN = /claude-(?:opus|sonnet|haiku)-5-5|claude-fable-5/i
const needsAdaptiveThinking = (modelId) => CLAUDE_ADAPTIVE_PATTERN.test(String(modelId || ''))
const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'group'
const credentialRef = (group) => `QINGHUA_${slug(group).replace(/-/g, '_').toUpperCase()}_API_KEY`
const keyName = (group) => `DSH \u00b7 ${group}`

function normaliseBaseUrl(value) {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_BASE_URL
  return raw.replace(/\/+$/, '')
}

/** The relay exposes every supported chat group through its OpenAI Responses endpoint. */
function protocolFor(platform) {
  const value = String(platform || '').toLowerCase()
  if (value.includes('gemini')) return 'gemini'
  return 'openai-responses'
}

const DEEPSEEK_MODEL_PATTERN = /(^|[\/:_-])deepseek([\/:_-]|$)/i
const isDeepSeekModel = (modelId) => DEEPSEEK_MODEL_PATTERN.test(String(modelId || ''))
const lookupName = (value) => String(value || '').trim().toLowerCase()

function modelIdOf(model) {
  if (typeof model === 'string') return model.trim()
  if (!model || typeof model !== 'object') return ''
  for (const key of ['id', 'model', 'model_id', 'modelId', 'name']) {
    const value = typeof model[key] === 'string' ? model[key].trim() : ''
    if (value) return value
  }
  return ''
}

function uniqueModelIds(models) {
  return [...new Set(models.map(modelIdOf).filter(Boolean))]
}

function ensureOpenAIBaseUrl(value) {
  const base = String(value || DEFAULT_BASE_URL).replace(/\/+$/, '')
  return base.endsWith('/v1') ? base : `${base}/v1`
}

function relayOrigin(value) {
  return String(value || DEFAULT_BASE_URL).replace(/\/+$/, '').replace(/\/v1$/i, '')
}

function asArray(value, ...keys) {
  if (Array.isArray(value)) return value
  for (const key of keys) if (value && Array.isArray(value[key])) return value[key]
  return []
}

function modelProfile(modelId, platform = '') {
  const levels = needsAdaptiveThinking(modelId) ? CLAUDE_EFFORT_LEVELS : REASONING_LEVELS
  const deepseek = String(platform).toLowerCase().includes('deepseek') || isDeepSeekModel(modelId)
  return {
    id: modelId,
    name: modelId,
    contextWindow: CONTEXT_WINDOW,
    input: ['text', 'image'],
    maxTokens: deepseek ? DEEPSEEK_MAX_TOKENS : STANDARD_MAX_TOKENS,
    reasoningEfforts: Object.fromEntries(levels.map((level) => [level, level])),
  }
}

function normalizeModelProfiles(models, platform = '') {
  return models.map((model) => {
    const id = modelIdOf(model)
    if (!id) return null
    const original = model && typeof model === 'object' ? model : {}
    return { ...original, ...modelProfile(id, platform) }
  }).filter(Boolean)
}

function normalizeRelayProviderValue(route, value) {
  if (!value || typeof value !== 'object') return value
  const models = Array.isArray(value.models) ? value.models : []
  const ids = uniqueModelIds(models)
  const deepseek = ids.some(isDeepSeekModel) || /deepseek/i.test(route)
  const normalized = {
    ...value,
    api: 'openai-responses',
    baseURL: relayOrigin(value.baseURL),
    models: normalizeModelProfiles(models, deepseek ? 'deepseek' : ''),
  }
  delete normalized.compat
  return normalized
}

function createApi(baseUrl, fetchImpl) {
  async function call(path, { method = 'GET', body, token, signal } = {}) {
    const headers = { accept: 'application/json' }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (token) headers.authorization = `Bearer ${token}`
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
    const text = await response.text()
    let payload = null
    try { payload = text ? JSON.parse(text) : null } catch { /* non-JSON */ }
    if (!response.ok) {
      const error = new Error((payload && (payload.message || (payload.error && payload.error.message))) || `中转站请求失败（HTTP ${response.status}）`)
      error.status = response.status
      error.code = (payload && (payload.code || (payload.error && payload.error.code))) || 'relay_http_error'
      throw error
    }
    if (payload && typeof payload.code === 'number' && payload.code !== 0) {
      const error = new Error(payload.message || '中转站返回错误')
      error.code = payload.code
      error.status = 400
      throw error
    }
    return payload && Object.prototype.hasOwnProperty.call(payload, 'data') ? payload.data : payload
  }
  return { call }
}

/** Locate the live `llm-pi-ai` settings namespace without hard-coding the profile entry id. */
function findPiAiNamespace(ctx) {
  const descriptors = ctx.settings.describe()
  const scored = descriptors.map((descriptor) => {
    const schema = descriptor.schema || {}
    const value = descriptor.value || {}
    const hasProviders = Boolean((schema.properties && schema.properties.providers) || value.providers !== undefined)
    const named = /pi-ai/i.test(String(descriptor.ns))
    return { descriptor, rank: hasProviders && named ? 3 : hasProviders ? 2 : named ? 1 : 0 }
  }).filter((entry) => entry.rank > 0).sort((a, b) => b.rank - a.rank)
  if (!scored.length) throw new Error('没有找到 llm-pi-ai 配置项，无法导入模型路由。')
  return scored[0].descriptor.ns
}

/** Families that are not chat models and must not appear in the composer picker. */
const NON_CHAT_PATTERN = /seedance|sora|dall-?e|gpt-image|image-|imagen|tts|audio|whisper|transcri|embed|rerank|moderation|veo|kling/i

/**
 * 老版本插件可能缺少 Claude 的自适应思考兼容标记。这里在加载时静默迁移：
 * DeepSeek 走站点 OpenAI Responses（`/v1/responses`）；Claude 分组走原生
 * Anthropic Messages（`/v1/messages`）并启用 adaptive thinking；GPT 分组走
 * OpenAI 兼容接口。
 */
async function migrateRelayRoutes(ctx) {
  try {
    const ns = findPiAiNamespace(ctx)
    const descriptor = ctx.settings.describe().find((entry) => entry.ns === ns)
    const providers = (descriptor && descriptor.value && descriptor.value.providers) || {}
    const ops = []
    for (const [route, value] of Object.entries(providers)) {
      if (!route.startsWith(ROUTE_PREFIX) || !value || !Array.isArray(value.models)) continue
      const normalized = normalizeRelayProviderValue(route, value)
      if (JSON.stringify(normalized) !== JSON.stringify(value)) {
        ops.push({ op: 'set', path: ['providers', route], value: normalized })
      }
    }
    if (ops.length) await ctx.settings.mutate(ns, ops)
  } catch { /* settings not ready; provision will write the corrected compat later */ }
}

export const inject = ['connection', 'credentials', 'settings']

export function apply(ctx, config = {}) {
  const baseUrl = normaliseBaseUrl(config.baseUrl)
  const api = createApi(`${baseUrl}/api/v1`, fetch)
  void migrateRelayRoutes(ctx)

  // Optional: routes whose reasoning channel should not be shown (an upstream model
  // that dumps draft answers / tool-call JSON into its CoT reads as noise).
  // Empty by default — every route shows its reasoning; opt in via patch config.
  const hideReasoning = new Set(
    (Array.isArray(config.hideReasoning) ? config.hideReasoning : []).map(String),
  )
  ctx.effect(() => ctx.on('llm/stream', (options, next) => {
    const provider = options && options.provider
    if (!provider || !hideReasoning.has(provider)) return next()
    const source = next()
    return (async function* filtered() {
      for await (const chunk of source) {
        if (!chunk) continue
        if (chunk.type === 'reasoning-delta') continue
        if (chunk.type === 'block-start' && chunk.blockType === 'reasoning') continue
        if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'reasoning') continue
        yield chunk
      }
    })()
  }))

  const readSession = async () => {
    const resolved = await ctx.credentials.resolve(SESSION_REF)
    if (!resolved) return null
    try {
      const parsed = JSON.parse(resolved.value)
      if (parsed && typeof parsed.accessToken === 'string') return parsed
    } catch { /* legacy plain token */ }
    return { accessToken: resolved.value, refreshToken: null }
  }
  const writeSession = (session) => ctx.credentials.set(SESSION_REF, JSON.stringify(session))
  const clearSession = () => ctx.credentials.unset(SESSION_REF)

  async function refreshSession(session) {
    if (!session || !session.refreshToken) throw Object.assign(new Error('登录状态已失效，请重新登录。'), { code: 'session_expired' })
    const data = await api.call('/auth/refresh', { method: 'POST', body: { refresh_token: session.refreshToken } })
    const next = {
      accessToken: data.access_token || data.accessToken,
      refreshToken: data.refresh_token || data.refreshToken || session.refreshToken,
    }
    if (!next.accessToken) throw Object.assign(new Error('登录状态已失效，请重新登录。'), { code: 'session_expired' })
    await writeSession(next)
    return next
  }

  /** Authenticated call with one transparent refresh retry. */
  async function authed(path, options = {}) {
    const session = await readSession()
    if (!session) throw Object.assign(new Error('请先登录情话中转站账号。'), { code: 'not_logged_in' })
    try {
      return await api.call(path, { ...options, token: session.accessToken })
    } catch (error) {
      if (error.status !== 401) throw error
      const next = await refreshSession(session).catch(async (failure) => {
        await clearSession().catch(() => {})
        throw failure
      })
      return api.call(path, { ...options, token: next.accessToken })
    }
  }

  async function profile() {
    const data = await authed('/user/profile')
    const user = (data && data.user) || data || {}
    return {
      email: user.email || '',
      username: user.username || '',
      balance: Number(user.balance ?? user.quota ?? 0),
      frozen: Number(user.frozen_balance ?? 0),
      totalRecharged: Number(user.total_recharged ?? 0),
      status: user.status || 'active',
    }
  }

  async function listGroups() {
    const data = await authed('/groups/available')
    return asArray(data, 'groups', 'items', 'list')
  }

  async function listKeys() {
    const data = await authed('/keys')
    return asArray(data, 'keys', 'items', 'list')
  }

  /** Authoritative group -> model list, including groups the gateway lists globally. */
  async function modelPlaza() {
    try {
      const data = await api.call('/model-plaza')
      return asArray(data, 'groups', 'items', 'list')
    } catch {
      return []
    }
  }

  /** Fallback discovery: model plaza is authoritative; this only fills older deployments. */
  async function modelsForKey(secret) {
    try {
      const response = await fetch(`${baseUrl}/v1/models`, {
        headers: { accept: 'application/json', authorization: `Bearer ${secret}` },
      })
      if (!response.ok) return []
      const payload = await response.json()
      const list = asArray(payload, 'data', 'models', 'items')
      const ids = list.map((entry) => (typeof entry === 'string' ? entry : entry && (entry.id || entry.name))).filter(Boolean)
      return ids
    } catch {
      return []
    }
  }

  async function account() {
    const session = await readSession()
    if (!session) return { connected: false }
    const me = await profile()
    const keys = await listKeys().catch(() => [])
    return { connected: true, user: me, balance: me.balance, keys }
  }

  async function sendCode(email) {
    return api.call('/auth/send-verify-code', { method: 'POST', body: { email } })
  }

  async function register({ email, password, code }) {
    const data = await api.call('/auth/register', { method: 'POST', body: { email, password, verify_code: code } })
    const session = { accessToken: data.access_token || data.accessToken, refreshToken: data.refresh_token || data.refreshToken || null }
    if (!session.accessToken) throw new Error('注册成功但没有拿到登录凭据，请到中转站网页登录。')
    await writeSession(session)
    return data
  }

  async function login({ email, password }) {
    const data = await api.call('/auth/login', { method: 'POST', body: { email, password } })
    const session = { accessToken: data.access_token || data.accessToken, refreshToken: data.refresh_token || data.refreshToken || null }
    if (!session.accessToken) throw new Error('登录成功但没有拿到登录凭据。')
    await writeSession(session)
    return data
  }

  async function provision() {
    const groups = await listGroups()
    if (!groups.length) throw new Error('中转站当前没有可用的模型分组，请联系站长。')
    const plaza = await modelPlaza()
    const plazaById = new Map(plaza.map((entry) => [String(entry.id), entry]))
    const plazaByName = new Map(plaza.map((entry) => [lookupName(entry.name), entry]))
    const keys = await listKeys()

    const imported = []
    const created = []
    const failures = []
    const liveRoutes = new Set()

    for (const group of groups) {
      const groupName = group.name || String(group.id)
      const plazaGroup = plazaById.get(String(group.id)) || plazaByName.get(lookupName(groupName)) || null
      const platform = String((plazaGroup && plazaGroup.platform) || group.platform || '').toLowerCase()
      const protocol = protocolFor(platform)
      if (protocol === 'gemini') {
        failures.push({ group: groupName, code: 'unsupported_platform', message: 'Gemini 分组暂不支持导入 DSH。' })
        continue
      }

      const ref = credentialRef(groupName)
      let secret = null
      const configured = await ctx.credentials.describe(ref).then((info) => info.configured).catch(() => false)
      if (configured) {
        const resolved = await ctx.credentials.resolve(ref).catch(() => null)
        if (resolved) secret = resolved.value
      }
      if (!secret) {
        const candidate = keys.find((entry) => {
          const candidateGroupID = entry && (entry.group_id ?? (entry.group && entry.group.id))
          return String(candidateGroupID || '') === String(group.id) && typeof entry.key === 'string' && entry.key && !/[*\u2026]/.test(entry.key)
        }) || keys.find((entry) => entry.name === keyName(groupName))
        if (candidate && typeof candidate.key === 'string' && candidate.key && !/[*\u2026]/.test(candidate.key)) secret = candidate.key
      }
      if (!secret) {
        try {
          const taken = new Set(keys.map((entry) => entry.name))
          let name = keyName(groupName)
          let suffix = 2
          while (taken.has(name)) name = `${keyName(groupName)} ${suffix++}`
          const createdKey = await authed('/keys', { method: 'POST', body: { name, group_id: group.id } })
          const record = createdKey || {}
          secret = typeof record === 'string' ? record : record.key
          if (!secret || /[*\u2026]/.test(secret)) throw Object.assign(new Error('中转站没有返回 Key 明文。'), { code: 'missing_secret' })
          keys.push({ ...record, name, key: secret, group_id: group.id })
          created.push({ group: groupName, protocol })
        } catch (error) {
          failures.push({ group: groupName, code: error.code || 'key_create_failed', message: error.message })
          continue
        }
      }
      await ctx.credentials.set(ref, secret)

      const plazaModels = plazaGroup ? asArray(plazaGroup, 'models') : []
      const modelIds = uniqueModelIds(plazaModels)
      const fallback = modelIds.length ? [] : await modelsForKey(secret)
      // A chat route cannot serve video/image/TTS/embedding models; keep them out of the picker.
      const finalIds = (modelIds.length ? modelIds : fallback).filter((id) => !NON_CHAT_PATTERN.test(id))
      if (!finalIds.length) {
        failures.push({ group: groupName, code: 'no_chat_models', message: '该分组只有非对话模型，已跳过。' })
        continue
      }

      const route = `${ROUTE_PREFIX}${slug(groupName)}`
      const deepseek = finalIds.some(isDeepSeekModel) || /deepseek/i.test(groupName)
      const api = 'openai-responses'
      liveRoutes.add(route)
      imported.push({
        group: groupName,
        platform,
        protocol: api,
        route,
        ref,
        baseURL: relayOrigin(baseUrl),
        api,
        models: finalIds,
      })
    }

    if (!imported.length) {
      throw Object.assign(new Error(failures.length ? failures[0].message : '没有可导入的模型分组。'), { code: 'nothing_to_import', failures })
    }

    const ns = findPiAiNamespace(ctx)
    const descriptor = ctx.settings.describe().find((entry) => entry.ns === ns)
    const existing = (descriptor && descriptor.value && descriptor.value.providers) || {}

    const ops = imported.map((entry) => ({
      op: 'set',
      path: ['providers', entry.route],
      value: {
        displayName: `情话中转站 \u00b7 ${entry.group}`,
        api: entry.api,
        baseURL: entry.baseURL,
        apiKeyEnv: entry.ref,
        ...(entry.compat ? { compat: entry.compat } : {}),
        models: normalizeModelProfiles(entry.models, entry.platform),
      },
    }))

    // A group removed on the site must disappear here too, together with its key reference.
    const removed = []
    for (const [routeName, profileValue] of Object.entries(existing)) {
      if (!routeName.startsWith(ROUTE_PREFIX) || liveRoutes.has(routeName)) continue
      removed.push(routeName)
      ops.push({ op: 'unset', path: ['providers', routeName] })
      const staleRef = profileValue && profileValue.apiKeyEnv
      if (staleRef) await ctx.credentials.unset(staleRef).catch(() => {})
    }
    await ctx.settings.mutate(ns, ops)

    return {
      namespace: ns,
      imported: imported.map((entry) => ({
        group: entry.group,
        protocol: entry.protocol,
        route: entry.route,
        models: entry.models.length,
      })),
      created,
      removed,
      failures,
      baseUrl,
    }
  }

  async function paymentConfig() {
    return authed('/payment/config')
  }

  async function createOrder({ amount, paymentType }) {
    return authed('/payment/orders', { method: 'POST', body: { amount: Number(amount), payment_type: paymentType, order_type: 'balance' } })
  }

  async function verifyOrder(id) {
    return authed('/payment/orders/verify', { method: 'POST', body: { order_id: id } })
  }

  async function listOrders() {
    const data = await authed('/payment/orders/my')
    return asArray(data, 'orders', 'items', 'list')
  }

  const actions = {
    status: async () => ({ ...(await account().catch(() => ({ connected: false }))), baseUrl }),
    'send-code': async ({ email }) => sendCode(email),
    register: async (payload) => ({ ...(await register(payload)) }),
    login: async (payload) => {
      await login(payload)
      return { ok: true }
    },
    logout: async () => {
      await clearSession()
      return { ok: true }
    },
    account,
    provision,
    'payment-config': paymentConfig,
    'create-order': createOrder,
    'verify-order': async ({ id }) => verifyOrder(id),
    'list-orders': listOrders,
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let payload = {}
      try { payload = await request.json() } catch { payload = {} }
      const action = payload && payload.action
      const handler = actions[action]
      const respond = (status, value) => new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
      if (!handler) return respond(404, { ok: false, error: { code: 'unknown_action', message: `未知操作：${String(action)}` } })
      if (!baseUrl) {
        return respond(200, { ok: false, error: { code: 'missing_base_url', message: '请先在插件配置里填写中转站地址 baseUrl（例如 https://你的域名）。' } })
      }
      try {
        return respond(200, { ok: true, data: await handler(payload) })
      } catch (error) {
        return respond(200, {
          ok: false,
          error: { code: error.code || 'relay_error', message: error.message || String(error), status: error.status || 500 },
        })
      }
    },
  }))
}

export {
  ensureOpenAIBaseUrl,
  modelIdOf,
  normalizeModelProfiles,
  normalizeRelayProviderValue,
}
