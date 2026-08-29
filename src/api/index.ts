/**
 * traework 供应商：TRAE SOLO 免费通道（移植自 traework2api）。
 * 提供 OpenAI 兼容 chat（多账号轮转 + 冷却状态机 + 流式/非流式）+ models + 面板状态。
 * 作为 dsh-router 的外部供应商插件：通用能力（连接池/模型管理/别名/签到规则/凭证）
 * 由 dsh-router 核心经 env 注入，本插件只实现差异化逻辑。
 */
import type { ServerResponse } from 'node:http'
import {
  DEFAULT_CONFIG_NAME,
  defaultConfig,
  SOLO,
  type TraewConfig,
} from './constants.ts'
import { needsRefresh, parseAuth, toAuthDoc, type Auth } from './auth.ts'
import { Pool, type AccountStatus, type PoolStrategy } from './pool.ts'
import type { SupplierConfigStoreLike, CredentialStoreLike } from '../contract.ts'
import {
  SoloClient,
  UpstreamError,
  classify,
  aggregate,
  linesFromStream,
  parseSoloLine,
  SoloStreamError,
} from './upstream.ts'
import { Scheduler } from './scheduler.ts'
import { buildLoginUrl, parseLoginCallback, randomId } from './login.ts'
import type { Supplier, SupplierStatus, SupplierAccount, ModelInfo, ModelWithEnabled, ChatRequest } from '../types.ts'

function openAIError(code: string, msg: string): Record<string, unknown> {
  return { error: { message: msg, type: 'api_error', code } }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

/** 将客户端传入的 model 映射为 config_name（SPEC §4.5）。 */
function mapModel(model: string, known: Set<string>, defaultModel: string): string | undefined {
  model = model.trim()
  if (model === '' || model === 'auto') return defaultModel
  let base = model
  // 支持全名 alias/id：剥掉前缀取 id 部分。
  // 用 indexOf 而非 lastIndexOf：模型 id 本身可含斜杠（如 org/name），
  // 剥最后一段会连命名空间一起吃掉，请求必然 404。
  const slash = base.indexOf('/')
  if (slash >= 0) base = base.slice(slash + 1)
  const i = base.indexOf('__')
  if (i >= 0) base = base.slice(0, i)
  if (known.has(base)) return base
  const norm = normalizeModelName(base)
  if (known.has(norm)) return norm
  return undefined
}

function normalizeModelName(s: string): string {
  return s
    .split('_')
    .filter((p) => p !== '')
    .map((p) => p[0]!.toUpperCase() + p.slice(1).toLowerCase())
    .join('-')
}

/** traework 供应商。 */
export class TraeworkSupplier implements Supplier {
  readonly id = 'traework'
  readonly name = 'traework'
  readonly priority = 0 // 免费通道，最优先

  /** 数据目录由 stateFile 推导。 */
  get stateFile(): string {
    return this.cfg.stateFile
  }

  private cfg: TraewConfig
  private pool: Pool
  private client: SoloClient
  private scheduler: Scheduler
  private store: SupplierConfigStoreLike
  private credentials: CredentialStoreLike
  private log: (msg: string) => void
  private modelsCache: ModelInfo[] | undefined
  /** 上次 chatCompletions 失败原因（供核心测试模型汇总诊断）。 */
  private lastErrText: string | undefined
  private pendingLogin: { machineId: string; deviceId: string } | undefined

  constructor(cfg: Partial<TraewConfig>, store: SupplierConfigStoreLike, credentials: CredentialStoreLike, log?: (msg: string) => void) {
    this.log = log ?? (() => {})
    this.cfg = { ...defaultConfig(), ...cfg }
    this.store = store
    this.credentials = credentials
    this.pool = new Pool(this.cfg.stateFile, {
      getOrder: () => this.store.get(this.id).poolOrder,
      getStrategy: () => this.store.get(this.id).poolStrategy,
      setOrder: (uids) => this.store.setPoolOrder(this.id, uids),
      setStrategy: (s) => this.store.setPoolStrategy(this.id, s),
      getCheckinRule: () => this.store.get(this.id).checkinRule,
      setCheckinRule: (r) => this.store.setCheckinRule(this.id, r),
    })
    this.client = new SoloClient({
      agentHost: this.cfg.agentHost,
      ugHost: this.cfg.ugHost,
      oauthHost: this.cfg.oauthHost,
      timeoutSeconds: this.cfg.timeoutSeconds,
    })
    this.scheduler = new Scheduler({
      pool: this.pool,
      client: this.client,
      checkinHour: this.cfg.checkinHour,
      refreshHours: this.cfg.refreshHours,
      refreshSkewMs: this.cfg.refreshSkewMs,
      saveAuth: (a) => this.saveAuth(a),
      log,
    })
  }

  /** 启动：从 dsh-router 凭证存储加载、启动调度器、初始化积分。 */
  async start(): Promise<void> {
    const auths = this.loadAuths()
    this.pool.syncToDir(auths)
    this.scheduler.start()
    this.refreshCredits()
  }

  /** 从 dsh-router 凭证存储读取本供应商全部凭证。 */
  private loadAuths(): Auth[] {
    const out: Auth[] = []
    for (const uid of this.credentials.list(this.id)) {
      try {
        const doc = this.credentials.get<unknown>(this.id, uid)
        if (doc === undefined) continue
        out.push({ ...parseAuth(JSON.stringify(doc)), filePath: '' })
      } catch {
        // 坏凭证静默跳过
      }
    }
    return out
  }

  /** 凭证写入 dsh-router 凭证存储。 */
  private saveAuth(a: Auth): void {
    this.credentials.save(this.id, a.uid, toAuthDoc(a))
  }

  dispose(): void {
    this.scheduler.stop()
  }

  status(): SupplierStatus {
    return {
      id: this.id,
      name: this.name,
      accounts: this.pool.list(),
    }
  }

  // -------------------------------------------------------------------------
  // 可用模型管理（启用/禁用/自定义/别名 → 通用层 SupplierConfigStore）
  // -------------------------------------------------------------------------

  // 模型列表：每次从上游拉取（不主动缓存——缓存由 dsh-router 核心统一管，
  // 插件只在拉取失败时回退上次成功结果，避免面板空模型）。

  /** 上游拉取的模型 + 自定义模型（面板/路由共用）。无缓存时仅自定义。 */
  private allModels(): ModelInfo[] {
    const base = [...(this.modelsCache ?? [])]
    for (const id of this.store.get(this.id).custom) {
      if (!base.some((m) => m.id === id)) base.push({ id })
    }
    return base
  }

  /** 可被路由识别的模型 id 集合（上游拉取 + 自定义）。 */
  private allKnownIds(): Set<string> {
    const set = new Set((this.modelsCache ?? []).map((m) => m.id))
    for (const id of this.store.get(this.id).custom) set.add(id)
    return set
  }

  listModels(force = false): ModelInfo[] | Promise<ModelInfo[]> {
    return this.refreshFromUpstream().then(() => this.allModels())
  }

  /** 从上游拉取模型列表（接口获取，不内置数据）。失败静默回退缓存/空。 */
  private async refreshFromUpstream(): Promise<void> {
    const acct = this.pool.pick()
    if (!acct) return
    try {
      const models = await this.client.fetchModels(acct)
      const fetched: ModelInfo[] = []
      for (const m of models) {
        if (m.id === '') continue
        const entry: ModelInfo = { id: m.id }
        if (m.contextWindow > 0) entry.context_length = Math.round(m.contextWindow / 1000)
        fetched.push(entry)
      }
      if (fetched.length > 0) {
        this.modelsCache = fetched
      }
    } catch {
      // 拉取失败回退缓存/空
    }
  }

  /** 供应商前缀（模型全名 = alias/id）。 */
  getAlias(): string {
    return this.store.get(this.id).alias || 'traework'
  }

  /** 用户手动添加的模型 id（supplier-config custom）。 */
  customModelIds(): string[] {
    return [...this.store.get(this.id).custom]
  }

  /** 连接池顺序（uid 数组，拖动排序结果）。 */
  poolOrder(): string[] {
    return this.pool.getOrder()
  }

  /** 连接池策略（fallback/round-robin）。 */
  poolStrategy(): PoolStrategy {
    return this.pool.getStrategy()
  }

  /** 设置连接池顺序。 */
  setPoolOrder(uids: string[]): { ok: boolean; error?: string } {
    if (!Array.isArray(uids) || uids.some((u) => typeof u !== 'string')) return { ok: false, error: '顺序必须是 uid 数组' }
    this.pool.setOrder(uids)
    return { ok: true }
  }

  /** 设置连接池策略。 */
  setPoolStrategy(strategy: string): { ok: boolean; error?: string } {
    if (strategy !== 'fallback' && strategy !== 'round-robin') return { ok: false, error: '策略无效' }
    this.pool.setStrategy(strategy)
    return { ok: true }
  }

  /** 触发签到：按 dsh-router 通用策略 all=所有链接 / first=仅首个链接。 */
  async checkinNow(): Promise<{ ok: boolean; total: number; succeeded: number; already: number; results?: Array<{ uid: string; ok: boolean; status: string; message?: string }> }> {
    const accounts = this.pool.list()
    const available = accounts.filter((a) => !a.disabled)
    if (available.length === 0) return { ok: false, total: 0, succeeded: 0, already: 0 }
    const uids = this.pool.getCheckinRule() === 'first' ? [available[0]!.uid] : available.map((a) => a.uid)
    const results: Array<{ uid: string; ok: boolean; status: string; message?: string }> = []
    for (const uid of uids) {
      const r = await this.scheduler.checkinOne(uid)
      results.push({ uid, ...r })
    }
    const succeeded = results.filter((r) => r.status === 'ok').length
    const already = results.filter((r) => r.status === 'already').length
    return { ok: true, total: uids.length, succeeded, already, results }
  }

  setAlias(alias: string): { ok: boolean; error?: string } {
    const clean = alias.trim()
    if (clean === '') return { ok: false, error: '前缀不能为空' }
    if (!/^[A-Za-z0-9_-]+$/.test(clean)) return { ok: false, error: '前缀只能包含字母、数字、- 和 _' }
    this.store.setAlias(this.id, clean)
    return { ok: true }
  }

  /** 面板：全部模型 + 启用状态。 */
  modelsWithEnabled(): ModelWithEnabled[] {
    const cfg = this.store.get(this.id)
    const disabled = new Set(cfg.disabled)
    const custom = new Set(cfg.custom)
    return this.allModels().map((m) => ({
      ...m,
      enabled: !disabled.has(m.id),
      custom: custom.has(m.id) ? true : undefined,
    }))
  }

  setModelEnabled(id: string, enabled: boolean): boolean {
    const all = this.allModels()
    if (!all.some((m) => m.id === id)) return false
    this.store.setModelEnabled(this.id, id, enabled)
    return true
  }

  /** 添加自定义模型（9router Add Model）。 */
  addCustomModel(id: string): { ok: boolean; error?: string } {
    const clean = id.trim()
    if (clean === '') return { ok: false, error: '模型 id 不能为空' }
    if (this.allModels().some((m) => m.id === clean)) return { ok: false, error: `模型 ${clean} 已存在` }
    this.store.addCustomModel(this.id, clean)
    return { ok: true }
  }

  /** 删除自定义模型（静态模型不可删）。 */
  removeCustomModel(id: string): { ok: boolean; error?: string } {
    if (!this.store.get(this.id).custom.includes(id)) return { ok: false, error: `模型 ${id} 不是自定义模型` }
    this.store.removeCustomModel(this.id, id)
    if (this.modelsCache) this.modelsCache = this.modelsCache.filter((m) => m.id !== id)
    return { ok: true }
  }

  /** 全部启用/全部禁用。 */
  setAllModelsEnabled(enabled: boolean): void {
    this.store.setAllModelsEnabled(this.id, enabled, this.allModels().map((m) => m.id))
  }

  /** 上次 chatCompletions 失败原因（诊断用）。测试模型由 dsh-router 核心统一走
   *  chatCompletions 路径（账号池回退/冷却自动生效），插件只需暴露失败原因。 */
  lastError(): string | undefined {
    return this.lastErrText
  }

  // -------------------------------------------------------------------------
  // 登录（加账号）：生成登录链接 → 粘贴回调 → 换 token 落盘
  // -------------------------------------------------------------------------

  /** 生成登录链接并记住本次 machine/device id（回调完成时复用）。 */
  generateLoginUrl(): string {
    const machineId = randomId()
    const deviceId = randomId()
    this.pendingLogin = { machineId, deviceId }
    return buildLoginUrl(machineId, deviceId)
  }

  /** 用回调链接完成登录：解析 → ExchangeToken → GetUserInfo → 落盘 auths/。 */
  async completeLogin(callbackUrl: string): Promise<{ uid: string; nickname: string }> {
    const pending = this.pendingLogin
    const cb = parseLoginCallback(callbackUrl)
    const userInfo = cb.userInfo as Record<string, unknown>
    const userJwt = cb.userJwt as Record<string, unknown>
    let refreshToken = cb.refreshToken
    if (refreshToken === '' && userJwt) {
      refreshToken = String((userJwt as Record<string, unknown>).RefreshToken ?? '')
    }
    if (refreshToken === '') {
      throw new Error('回调链接缺少 refreshToken')
    }

    const auth: Auth = {
      uid: String(userInfo.UserID ?? ''),
      nickname: String(userInfo.ScreenName ?? ''),
      enterpriseId: String(userInfo.TenantID ?? ''),
      accessToken: '',
      refreshToken,
      expiresAt: 0,
      domain: 'trae.cn',
      apiHost: this.cfg.oauthHost ?? SOLO.OAuthHost,
      machineId: pending?.machineId ?? '',
      deviceId: pending?.deviceId ?? '',
      filePath: '',
    }
    await this.client.refreshToken(auth) // ExchangeToken → accessToken + 新 refresh
    const info = await this.client.getUserInfo(auth)
    auth.uid = info.uid
    auth.nickname = info.nickname
    auth.enterpriseId = info.enterpriseID
    if (auth.uid === '') throw new Error('未能获取 uid，token 可能无效')
    this.saveAuth(auth)
    this.pendingLogin = undefined
    // 重新加载账号池
    this.pool.syncToDir(this.loadAuths())
    this.refreshCredits()
    return { uid: auth.uid, nickname: auth.nickname }
  }

  /** 删除一个链接（从 dsh-router 凭证存储），并从池中移除。不存在返回 false。 */
  async removeLink(uid: string): Promise<boolean> {
    if (!this.pool.authByUID(uid)) return false
    this.credentials.remove(this.id, uid)
    this.pool.syncToDir(this.loadAuths())
    return true
  }

  // -------------------------------------------------------------------------
  // chat
  // -------------------------------------------------------------------------

  async chatCompletions(req: ChatRequest, res: ServerResponse): Promise<boolean> {
    // mapModel
    const configName = mapModel(req.model, this.allKnownIds(), this.cfg.defaultModel)
    if (configName === undefined) {
      // 不是本供应商的模型：返回 false 让路由器尝试下一个供应商（不霸占响应）
      this.lastErrText = `unknown model ${JSON.stringify(req.model)}`
      return false
    }
    if (this.store.get(this.id).disabled.includes(configName)) {
      writeJson(res, 400, openAIError('model_disabled', `model ${JSON.stringify(configName)} is disabled`))
      return true
    }
    let body = req.rawBody
    try {
      const obj = JSON.parse(body) as Record<string, unknown>
      obj.model = configName
      body = JSON.stringify(obj)
    } catch {
      // 保持原样
    }

    const tried = new Set<string>()
    let lastErr: Error | undefined
    for (let i = 0; i < 3; i++) {
      const acct = this.pool.pickExcluding(tried)
      if (!acct) break
      tried.add(acct.uid)

      // token 临近过期 → 先 refresh（失败冷却换号）
      try {
        const refreshed = await this.client.refreshTokenIfNeeded(acct, this.cfg.refreshSkewMs)
        if (refreshed) this.saveAuth(acct)
      } catch (err) {
        lastErr = err as Error
        const ue = err as { kind?: string }
        if (ue.kind === 'session_dead') this.pool.disable(acct.uid, 'refresh session dead')
        else this.pool.cooldown(acct.uid, 'error_threshold', this.cfg.errCooldownMs, `refresh: ${(err as Error).message}`)
        continue
      }

      let streamRes: { body: ReadableStream<Uint8Array> | null; status: number; respBody: string }
      try {
        streamRes = await this.client.chatStream(acct, body)
      } catch (err) {
        lastErr = err as Error
        this.pool.noteError(acct.uid, this.cfg.errThreshold, this.cfg.errCooldownMs)
        continue
      }
      if (streamRes.status >= 400) {
        const kind = classify(streamRes.status, streamRes.respBody)
        switch (kind) {
          case 'plan_limit':
            this.pool.cooldown(acct.uid, 'plan_limit', this.cfg.planCooldownMs, 'plan 权益不足')
            break
          case 'soft_rate':
            this.pool.cooldown(acct.uid, 'soft_rate', this.cfg.softCooldownMs, '429 rate limit')
            break
          case 'session_dead':
            this.pool.disable(acct.uid, 'session dead')
            break
          case 'not_found':
            this.pool.cooldown(acct.uid, 'soft_rate', this.cfg.softCooldownMs, 'upstream 404')
            break
          default:
            this.pool.noteError(acct.uid, this.cfg.errThreshold, this.cfg.errCooldownMs)
        }
        lastErr = new UpstreamError(kind, streamRes.status, streamRes.respBody)
        continue
      }

      if (req.stream) {
        this.pool.noteSuccess(acct.uid)
        await this.streamResponse(res, streamRes.body!, (se) => this.handleStreamError(acct.uid, se))
        return true
      }

      const { response, error } = await aggregate(linesFromStream(streamRes.body!))
      if (error) {
        lastErr = error
        this.handleStreamError(acct.uid, error)
        continue
      }
      // 上游空响应（无 content/reasoning/tool_calls）：视为失败，继续 fallback
      const msg = (response as { choices?: Array<{ message?: Record<string, unknown> }> })?.choices?.[0]?.message
      const hasContent =
        typeof msg?.content === 'string' && msg.content.length > 0 ||
        typeof msg?.reasoning_content === 'string' && msg.reasoning_content.length > 0 ||
        Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0
      if (!hasContent) {
        lastErr = new Error('upstream returned empty response')
        this.pool.noteError(acct.uid, this.cfg.errThreshold, this.cfg.errCooldownMs)
        continue
      }
      this.pool.noteSuccess(acct.uid)
      writeJson(res, 200, response)
      return true
    }

    // 所有账号尝试失败：不写响应，返回 false 让路由器继续 fallback（组合回退到下一个模型/供应商）
    if (lastErr) {
      this.lastErrText = lastErr.message
      this.log(`traework chat failed: ${lastErr.message}`)
    }
    return false
  }

  private handleStreamError(uid: string, se: SoloStreamError): void {
    if (se.kind() === 'plan_limit') {
      this.pool.cooldown(uid, 'plan_limit', this.cfg.planCooldownMs, 'plan 权益不足')
    } else {
      this.pool.noteError(uid, this.cfg.errThreshold, this.cfg.errCooldownMs)
    }
  }

  /** 流式响应：SOLO SSE → OpenAI SSE chunk，每 chunk flush，保证至少一个 [DONE]。 */
  private async streamResponse(
    res: ServerResponse,
    stream: ReadableStream<Uint8Array>,
    onErr: (se: SoloStreamError) => void,
  ): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    const flush = (): void => {
      if (typeof (res as { flushHeaders?: () => void }).flushHeaders === 'function') {
        ;(res as { flushHeaders: () => void }).flushHeaders()
      }
    }
    const id = `chatcmpl-${Date.now()}`
    let pendingUsage: Record<string, unknown> | null = null
    let sawDone = false

    const writeChunk = (delta: Record<string, unknown>, finish: string): Promise<boolean> => {
      const chunk: Record<string, unknown> = {
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: '',
        choices: [{ index: 0, delta }],
      }
      if (finish !== '') (chunk.choices as unknown[])[0] = { ...(chunk.choices as unknown[])[0] as Record<string, unknown>, finish_reason: finish }
      if (pendingUsage) {
        chunk.usage = pendingUsage
        pendingUsage = null
      }
      return new Promise((resolve) => {
        const ok = res.write(`data: ${JSON.stringify(chunk)}\n\n`)
        flush()
        resolve(ok)
      })
    }
    const writeDONE = (): Promise<boolean> => {
      return new Promise((resolve) => {
        const ok = res.write('data: [DONE]\n\n')
        flush()
        resolve(ok)
      })
    }

    const st = { event: '', data: '' }
    for await (const rawLine of linesFromStream(stream)) {
      const line = rawLine.replace(/\r?$/, '')
      const ev = scanLine(st, line)
      if (!ev) continue
      switch (ev.event) {
        case 'output': {
          const delta: Record<string, unknown> = {}
          if (ev.response !== '') delta.content = ev.response
          if (ev.reasoning !== '') delta.reasoning_content = ev.reasoning
          if (ev.toolCalls !== null && ev.toolCalls !== 'null') {
            const tc = normalizeToolCalls(ev.toolCalls)
            if (tc.length > 0) delta.tool_calls = tc
          }
          if (Object.keys(delta).length > 0) await writeChunk(delta, '')
          break
        }
        case 'token_usage':
          pendingUsage = ev.usage
          break
        case 'done':
          await writeChunk({}, ev.finishReason)
          await writeDONE()
          sawDone = true
          break
        case 'error': {
          const se = new SoloStreamError(ev.errorCode, ev.errorMessage)
          onErr(se)
          res.write(`event: error\ndata: ${JSON.stringify(`solo error code=${ev.errorCode} msg=${ev.errorMessage}`)}\n\n`)
          await writeDONE()
          sawDone = true
          break
        }
      }
    }
    if (!sawDone) await writeDONE()
    res.end()
  }

  // -------------------------------------------------------------------------
  // 积分刷新（后台，不阻塞启动）
  // -------------------------------------------------------------------------

  private refreshCredits(): void {
    for (const st of this.pool.list()) {
      if (st.disabled) continue
      const a = this.pool.authByUID(st.uid)
      if (!a) continue
      this.client.userEntUsage(a).then(
        (remain) => this.pool.setCredits(st.uid, remain),
        () => { /* 静默失败，下次刷新 */ },
      )
    }
  }
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function scanLine(st: { event: string; data: string }, line: string): {
  event: string
  response: string
  reasoning: string
  toolCalls: unknown
  usage: Record<string, unknown> | null
  finishReason: string
  errorCode: number
  errorMessage: string
} | undefined {
  // 复用 upstream 的 parseSoloLine + scanLine 语义
  if (line === '') {
    if (st.event === '') return undefined
    const ev = parseSoloLine(st.event, st.data)
    st.event = ''
    st.data = ''
    return ev
  }
  if (line.startsWith('event:')) {
    st.event = line.slice('event:'.length).trim()
  } else if (line.startsWith('data:')) {
    st.data += line.slice('data:'.length)
  }
  return undefined
}

function normalizeToolCalls(raw: unknown): unknown[] {
  let arr: unknown[]
  if (Array.isArray(raw)) {
    arr = raw
  } else if (typeof raw === 'object' && raw !== null) {
    arr = [raw]
  } else {
    try {
      arr = JSON.parse(String(raw)) as unknown[]
    } catch {
      return []
    }
  }
  const out: unknown[] = []
  for (const item of arr) {
    const call = item as Record<string, unknown>
    if (typeof call !== 'object' || call === null) continue
    if (call.function_call !== null && typeof call.function_call === 'object') {
      call.function = call.function_call
      delete call.function_call
    }
    const fn = call.function as Record<string, unknown> | undefined
    if (fn !== null && typeof fn === 'object') {
      delete fn.namespace
      delete fn.partial_arguments
    }
    out.push(call)
  }
  return out
}
