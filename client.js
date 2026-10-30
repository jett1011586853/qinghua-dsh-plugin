/**
 * Client half of @local/qinghua-relay: one Settings page ("中转站账户") that signs a
 * DSH user into the 情话中转站 (Sub2API) deployment, provisions one relay key per
 * model group, imports the groups into the Models page, and pays for top-ups.
 */

window.__ModuleLoader__.load({
  id: '@local/qinghua-relay',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const ENDPOINT = 'api/qinghua.relay'
    const UPDATE_API = 'https://api.github.com/repos/jett1011586853/qinghua-dsh-plugin/commits/main'
    const UPDATE_TARBALL = 'https://codeload.github.com/jett1011586853/qinghua-dsh-plugin/tar.gz'

    const requestId = () => {
      if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID()
      return `qinghua-update-${Date.now()}-${Math.random().toString(36).slice(2)}`
    }

    async function latestPluginTarget() {
      try {
        const response = await fetch(UPDATE_API, {
          headers: { accept: 'application/vnd.github+json' },
          cache: 'no-store',
        })
        if (response.ok) {
          const payload = await response.json()
          const sha = typeof payload.sha === 'string' ? payload.sha.trim() : ''
          if (sha) return { spec: `${UPDATE_TARBALL}/${sha}`, label: sha.slice(0, 7) }
        }
      } catch { /* use the branch tarball when the GitHub API is unavailable */ }
      return { spec: `${UPDATE_TARBALL}/refs/heads/main?dsh_update=${Date.now()}`, label: 'main' }
    }

    async function updatePlugin(remote) {
      const manager = remote && remote.pluginManager
      if (!manager || typeof manager.installBundle !== 'function') {
        throw new Error('当前 DSH 没有可用的插件安装接口，请先更新 DSH 后再试。')
      }
      const target = await latestPluginTarget()
      const result = await manager.installBundle(target.spec, {
        enabled: true,
        saveExact: true,
        requestId: requestId(),
      })
      if (!result || result.ok === false) {
        throw new Error((result && result.error && result.error.message) || '插件更新失败，请打开插件管理器查看安装日志。')
      }
      const change = result.ok === true ? result.value : result
      return { target, change }
    }

    async function rpc(action, payload) {
      const response = await fetch(new URL(ENDPOINT, document.baseURI), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...(payload || {}) }),
      })
      const text = await response.text()
      let body = null
      try { body = text ? JSON.parse(text) : null } catch { /* non-JSON */ }
      if (!response.ok || !body) throw new Error(`插件后端无响应（HTTP ${response.status}）`)
      if (body.ok === false) {
        const error = new Error((body.error && body.error.message) || '请求失败')
        error.code = body.error && body.error.code
        throw error
      }
      return body.data
    }

    const money = (value) => {
      const number = Number(value)
      return Number.isFinite(number) ? number.toFixed(2) : '--'
    }

    /** Payment providers answer with an image data URL, a QR image URL or a pay-page URL. */
    const pickPayTarget = (order) => {
      if (!order) return null
      let image = null
      let link = null
      for (const [key, value] of Object.entries(order)) {
        if (typeof value !== 'string') continue
        if (value.startsWith('data:image')) { image = image || value; continue }
        if (!/^https?:\/\//.test(value)) continue
        if (/qr|code_url|qrcode/i.test(key) || /qr/i.test(value)) image = image || value
        else if (/url|pay|checkout|link/i.test(key)) link = link || value
      }
      if (!image && !link) return null
      if (image && /^https?:\/\//.test(image) && !/\.(png|jpe?g|webp|gif)(\?|$)/i.test(image)) {
        link = link || image
        image = null
      }
      return { image, link }
    }

    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 0 24px' },
      card: { border: '1px solid var(--dsw-alias-border-neutral, #e5e7eb)', borderRadius: 12, padding: 16, background: 'var(--dsw-alias-bg-elevated, transparent)', display: 'flex', flexDirection: 'column', gap: 12 },
      title: { fontSize: 15, fontWeight: 600, margin: 0 },
      hint: { fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-fg-secondary, #6b7280)', margin: 0 },
      row: { display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' },
      field: { display: 'flex', flexDirection: 'column', gap: 6, flex: '1 1 220px' },
      label: { fontSize: 12, color: 'var(--dsw-alias-fg-secondary, #6b7280)' },
      input: { height: 34, padding: '0 10px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-neutral, #d1d5db)', background: 'var(--dsw-alias-bg-input, transparent)', color: 'inherit', fontSize: 13 },
      button: { height: 34, padding: '0 14px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-neutral, #d1d5db)', background: 'var(--dsw-alias-bg-elevated, transparent)', color: 'inherit', fontSize: 13, cursor: 'pointer' },
      primary: { height: 34, padding: '0 14px', borderRadius: 8, border: '1px solid transparent', background: 'var(--dsw-alias-accent-brand, #2563eb)', color: '#fff', fontSize: 13, cursor: 'pointer' },
      tabs: { display: 'flex', gap: 4, padding: 3, borderRadius: 8, background: 'var(--dsw-alias-bg-sunken, rgba(0,0,0,0.04))', width: 'fit-content' },
      tab: { border: 'none', background: 'transparent', padding: '5px 14px', borderRadius: 6, fontSize: 13, cursor: 'pointer', color: 'inherit' },
      tabActive: { background: 'var(--dsw-alias-bg-elevated, #fff)', fontWeight: 600 },
      metric: { display: 'flex', gap: 24, flexWrap: 'wrap' },
      metricItem: { display: 'flex', flexDirection: 'column', gap: 2 },
      metricValue: { fontSize: 22, fontWeight: 600 },
      metricLabel: { fontSize: 12, color: 'var(--dsw-alias-fg-secondary, #6b7280)' },
      error: { fontSize: 12, color: 'var(--dsw-alias-fg-danger, #dc2626)', background: 'var(--dsw-alias-bg-danger-subtle, rgba(220,38,38,0.08))', padding: '8px 10px', borderRadius: 8 },
      notice: { fontSize: 12, color: 'var(--dsw-alias-fg-success, #15803d)', background: 'var(--dsw-alias-bg-success-subtle, rgba(21,128,61,0.08))', padding: '8px 10px', borderRadius: 8, whiteSpace: 'pre-wrap' },
      list: { display: 'flex', flexDirection: 'column', gap: 6, margin: 0, padding: 0, listStyle: 'none' },
      listItem: { display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, padding: '6px 0', borderBottom: '1px dashed var(--dsw-alias-border-neutral, #e5e7eb)' },
      qr: { width: 200, height: 200, objectFit: 'contain', borderRadius: 8, border: '1px solid var(--dsw-alias-border-neutral, #e5e7eb)', background: '#fff' },
      muted: { fontSize: 12, color: 'var(--dsw-alias-fg-secondary, #6b7280)' },
    }

    const css = '.qh-relay input::placeholder{color:var(--dsw-alias-fg-tertiary,#9ca3af)}.qh-relay button:disabled{opacity:.55;cursor:not-allowed}'

    const Section = ({ children }) => h('div', { style: styles.card }, children)
    const Field = ({ label, children }) => h('div', { style: styles.field }, h('span', { style: styles.label }, label), children)
    const TextInput = (props) => h('input', {
      style: styles.input,
      value: props.value,
      type: props.type || 'text',
      placeholder: props.placeholder || '',
      autoComplete: props.autoComplete || 'off',
      onChange: (event) => props.onChange(event.target.value),
    })

    function AuthPanel({ onDone, setBusy, setError, setNotice }) {
      const [mode, setMode] = useState('register')
      const [email, setEmail] = useState('')
      const [password, setPassword] = useState('')
      const [code, setCode] = useState('')
      const [countdown, setCountdown] = useState(0)
      const timer = useRef(null)

      useEffect(() => () => { if (timer.current) clearInterval(timer.current) }, [])

      const startCountdown = () => {
        setCountdown(60)
        if (timer.current) clearInterval(timer.current)
        timer.current = setInterval(() => {
          setCountdown((value) => {
            if (value <= 1) { clearInterval(timer.current); timer.current = null; return 0 }
            return value - 1
          })
        }, 1000)
      }

      const sendCode = async () => {
        setError(''); setNotice(''); setBusy(true)
        try {
          await rpc('send-code', { email })
          setNotice('验证码已发送到邮箱，请查收（含垃圾箱）。')
          startCountdown()
        } catch (error) {
          setError(error.message)
        } finally { setBusy(false) }
      }

      const submit = async () => {
        setError(''); setNotice(''); setBusy(true)
        try {
          if (mode === 'register') await rpc('register', { email, password, code })
          else await rpc('login', { email, password })
          await onDone()
        } catch (error) {
          setError(error.message)
        } finally { setBusy(false) }
      }

      return h(Section, null,
        h('div', { style: styles.tabs },
          h('button', { style: { ...styles.tab, ...(mode === 'register' ? styles.tabActive : null) }, onClick: () => setMode('register') }, '注册'),
          h('button', { style: { ...styles.tab, ...(mode === 'login' ? styles.tabActive : null) }, onClick: () => setMode('login') }, '登录')),
        h('p', { style: styles.hint }, mode === 'register'
          ? '用邮箱注册情话中转站；注册成功后点「创建 Key 并导入模型」，会自动建好各分组的 Key 并接入 DSH。'
          : '用已注册的邮箱和密码登录。'),
        h('div', { style: styles.row },
          h(Field, { label: '邮箱' }, h(TextInput, { value: email, onChange: setEmail, placeholder: 'you@example.com', type: 'email' })),
          h(Field, { label: '密码' }, h(TextInput, { value: password, onChange: setPassword, type: 'password', autoComplete: 'new-password' })),
          mode === 'register'
            ? h(Field, { label: '邮箱验证码' },
              h('div', { style: styles.row },
                h(TextInput, { value: code, onChange: setCode, placeholder: '6 位数字' }),
                h('button', { style: styles.button, disabled: countdown > 0, onClick: sendCode }, countdown > 0 ? `${countdown}s` : '发送验证码')))
            : null),
        h('div', { style: styles.row }, h('button', { style: styles.primary, onClick: submit }, mode === 'register' ? '注册并继续' : '登录')),
      )
    }

    function AccountPanel({ status, reload, setBusy, setError, setNotice }) {
      const [result, setResult] = useState(null)
      const user = status.user || {}
      const keys = status.keys || []

      const provision = async () => {
        setError(''); setNotice(''); setResult(null); setBusy(true)
        try {
          const data = await rpc('provision')
          setResult(data)
          const lines = [`已同步 ${data.imported.length} 条模型路由到「设置 → 模型」：`]
          for (const entry of data.imported) lines.push(`· ${entry.group}（${entry.protocol}）→ ${entry.route}，${entry.models} 个模型`)
          if (data.removed && data.removed.length) lines.push(`已移除站点上不存在的分组：${data.removed.join('、')}`)
          for (const failure of data.failures || []) lines.push(`· ${failure.group} 未导入：${failure.message}`)
          setNotice(lines.join('\n'))
          await reload()
        } catch (error) {
          setError(error.message)
        } finally { setBusy(false) }
      }

      return h(Section, null,
        h('h3', { style: styles.title }, '账号'),
        h('div', { style: styles.metric },
          h('div', { style: styles.metricItem },
            h('span', { style: styles.metricValue }, `$${money(status.balance)}`),
            h('span', { style: styles.metricLabel }, '可用余额')),
          h('div', { style: styles.metricItem },
            h('span', { style: styles.metricValue }, String(keys.length)),
            h('span', { style: styles.metricLabel }, '已有 Key'))),
        h('p', { style: styles.hint }, user.email || ''),
        keys.length
          ? h('ul', { style: styles.list }, keys.slice(0, 8).map((key) => h('li', { key: key.id, style: styles.listItem },
            h('span', null, `${key.name || key.id}`),
            h('span', { style: styles.muted }, key.status || 'active'))))
          : h('p', { style: styles.hint }, '还没有 Key，点下面的按钮自动创建。'),
        h('div', { style: styles.row },
          h('button', { style: styles.primary, onClick: provision }, '同步分组与模型'),
          h('button', { style: styles.button, onClick: async () => { setBusy(true); try { await rpc('logout'); await reload() } finally { setBusy(false) } } }, '退出登录')),
        result ? h('p', { style: styles.hint }, `模型路由写入配置项 ${result.namespace}。DeepSeek 使用 Responses，Claude 使用 Anthropic Messages，GPT 使用 OpenAI 兼容协议。`) : null,
      )
    }

    function TopupPanel({ setBusy, setError, setNotice, reload }) {
      const [config, setConfig] = useState(null)
      const [method, setMethod] = useState('')
      const [amount, setAmount] = useState('50')
      const [order, setOrder] = useState(null)
      const [orders, setOrders] = useState([])

      const methods = useMemo(() => {
        if (!config) return []
        const list = Array.isArray(config.methods) ? config.methods : Array.isArray(config) ? config : []
        return list
          .map((entry) => ({
            id: entry.payment_type || entry.id || entry.type || entry.method,
            name: entry.name || entry.label || entry.display_name || entry.payment_type || entry.id,
            enabled: entry.enabled !== false,
          }))
          .filter((entry) => entry.id)
      }, [config])

      const load = useCallback(async () => {
        try {
          const data = await rpc('payment-config')
          setConfig(data)
          const first = (Array.isArray(data.methods) ? data.methods : [])
            .map((entry) => entry.payment_type || entry.id || entry.type || entry.method)
            .filter(Boolean)[0]
          setMethod((current) => current || first || 'wxpay')
          const mine = await rpc('list-orders').catch(() => null)
          if (mine) setOrders(Array.isArray(mine) ? mine : (mine.orders || []))
        } catch (error) {
          setConfig({ methods: [] })
        }
      }, [])

      useEffect(() => { load() }, [load])

      const create = async () => {
        setError(''); setNotice(''); setBusy(true)
        try {
          const data = await rpc('create-order', { amount, paymentType: method || 'wxpay' })
          const created = (data && (data.order || data)) || null
          setOrder(created)
          setNotice('订单已创建。请按下方金额完成支付；到账后站长会核验入账，可点「刷新订单状态」查看。')
        } catch (error) {
          setError(error.message)
        } finally { setBusy(false) }
      }

      const refresh = async () => {
        if (!order || !order.id) return
        setBusy(true)
        try {
          const data = await rpc('verify-order', { id: order.id })
          const next = (data && (data.order || data)) || order
          setOrder(next)
          setNotice(`订单状态：${next.status || '未知'}`)
          await reload()
        } catch (error) {
          setError(error.message)
        } finally { setBusy(false) }
      }

      const payTarget = order ? pickPayTarget(order) : null
      return h(Section, null,
        h('h3', { style: styles.title }, '充值'),
        h('p', { style: styles.hint }, '支付走本站已开启的渠道（你的站点目前是码支付的微信通道）。生成订单后会给收银台链接或二维码，付款后点「刷新订单状态」。'),
        h('div', { style: styles.row },
          h(Field, { label: '金额（元）' }, h(TextInput, { value: amount, onChange: setAmount, type: 'number' })),
          h(Field, { label: '支付方式' },
            methods.length
              ? h('select', { style: styles.input, value: method, onChange: (event) => setMethod(event.target.value) },
                methods.map((entry) => h('option', { key: entry.id, value: entry.id }, `${entry.name}${entry.enabled ? '' : '（未启用）'}`)))
              : h('select', { style: styles.input, value: method, onChange: (event) => setMethod(event.target.value) },
                [['wxpay', '微信'], ['alipay', '支付宝'], ['easypay', '码支付 / 易支付']].map(([id, name]) => h('option', { key: id, value: id }, name)))),
        ),
        h('div', { style: styles.row },
          h('button', { style: styles.primary, onClick: create }, '生成充值订单'),
          order ? h('button', { style: styles.button, onClick: refresh }, '刷新订单状态') : null),
        payTarget && payTarget.image ? h('img', { src: payTarget.image, style: styles.qr, alt: '支付二维码' }) : null,
        payTarget && payTarget.link
          ? h('p', { style: styles.hint }, '支付链接：',
            h('a', { href: payTarget.link, target: '_blank', rel: 'noreferrer', style: { color: 'var(--dsw-alias-accent-brand, #2563eb)' } }, payTarget.link))
          : null,
        order ? h('p', { style: styles.hint }, `订单 ${order.out_trade_no || order.id} · ¥${money(order.pay_amount ?? order.amount)} · 状态 ${order.status || 'pending'}`) : null,
        orders.length
          ? h('ul', { style: styles.list }, orders.slice(0, 5).map((entry) => h('li', { key: entry.id, style: styles.listItem },
            h('span', null, `${entry.out_trade_no || entry.id} · ¥${money(entry.pay_amount ?? entry.amount)}`),
            h('span', { style: styles.muted }, entry.status))))
          : null,
      )
    }

    function RelayAccountPage({ remote }) {
      const [loading, setLoading] = useState(true)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [status, setStatus] = useState(null)

      const runUpdate = useCallback(async () => {
        setError(''); setNotice(''); setBusy(true)
        try {
          const { target, change } = await updatePlugin(remote)
          const application = change && change.application
          const message = application === 'restart-required'
            ? '更新文件已安装，重启 DSH 后新版会生效。'
            : '新版已安装，刷新页面即可继续使用。'
          setNotice(`插件已更新到 ${target.label}。\n${message}`)
        } catch (failure) {
          setError(failure.message)
        } finally { setBusy(false) }
      }, [remote])

      const reload = useCallback(async () => {
        setLoading(true)
        try {
          setStatus(await rpc('status'))
        } catch (failure) {
          setError(failure.message)
          setStatus({ connected: false })
        } finally { setLoading(false) }
      }, [])

      useEffect(() => { reload() }, [reload])

      return h('div', { className: 'qh-relay', style: styles.root },
        h('style', null, css),
        h('div', { style: { ...styles.row, alignItems: 'center', justifyContent: 'space-between' } },
          h('h2', { style: { ...styles.title, fontSize: 17 } }, '中转站账户'),
          h('button', { style: styles.button, disabled: busy, onClick: runUpdate }, busy ? '更新中…' : '检查并更新插件')),
        h('p', { style: styles.hint }, '点一次即可：按站点模型广场的清单把「分组 → 模型」同步进 DSH 模型页；站点上已下线的分组会一并移除。'),
        h('p', { style: styles.hint }, '更新按钮会从插件仓库安装最新版本，已有登录状态、API Key 和模型配置会保留。'),
        error ? h('div', { style: styles.error }, error) : null,
        notice ? h('div', { style: styles.notice }, notice) : null,
        loading ? h('p', { style: styles.hint }, '读取中…') : null,
        !loading && status
          ? (status.connected
            ? h(React.Fragment, null,
              h(AccountPanel, { status, reload, setBusy, setError, setNotice }),
              h(TopupPanel, { setBusy, setError, setNotice, reload }))
            : h(AuthPanel, { onDone: reload, setBusy, setError, setNotice }))
          : null,
        busy ? h('p', { style: styles.muted }, '处理中…') : null,
      )
    }

    return {
      inject: ['slots', 'remote', 'remote.pluginManager'],
      apply(ctx) {
        const label = () => {
          try {
            const locale = ctx.locale.getLocale()
            return locale && String(locale.id || locale).startsWith('en') ? 'Relay Account' : '中转站账户'
          } catch {
            return '中转站账户'
          }
        }
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'qinghua-account',
          order: -9,
          label,
        }, () => h(RelayAccountPage, { remote: ctx.remote })))
      },
    }
  },
})
