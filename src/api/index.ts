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
import type { Supplier, ModelInfo, ModelWithEnabled, ChatRequest } from '../types.ts'
import type { AccountState, ChatOnceResult, SupplierStatusNow } from '../contract.ts'

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
  /** 积分拉取时间（uid → ms）：status() 同步返回池里的值，过期后台异步刷新。 */
  private creditsAt = new Map<string, number>()
  /** 积分缓存有效期。 */
  private static readonly CREDITS_TTL_MS = 10 * 60 * 1000
  private store: SupplierConfigStoreLike
  private credentials: CredentialStoreLike
  private log: (msg: string) => void
  private modelsCache: ModelInfo[] | undefined
  /** 上次 chatOnce 失败原因（供核心测试模型汇总诊断）。 */
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

  status(): SupplierStatusNow {
    this.refreshCreditsIfStale()
    return {
      id: this.id,
      name: this.name,
      accounts: this.pool.list(),
    }
  }

  /** 积分过期则后台异步刷新（不阻塞面板）：只在启动/加链接时拉一次的话，
   *  聊天消耗和签到入账都反映不到面板上。 */
  private refreshCreditsIfStale(): void {
    const now = Date.now()
    for (const st of this.pool.list()) {
      if (now - (this.creditsAt.get(st.uid) ?? 0) <= TraeworkSupplier.CREDITS_TTL_MS) continue
      const a = this.pool.authByUID(st.uid)
      if (!a) continue
      this.creditsAt.set(st.uid, now) // 先占位，避免同一轮重复发请求
      this.client.userEntUsage(a).then(
        (remain) => {
          this.pool.setCredits(st.uid, remain)
          this.creditsAt.set(st.uid, Date.now())
        },
        () => this.creditsAt.delete(st.uid), // 失败：下次 status() 再试
      )
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
    const acct = this.pool.authByUID(this.pool.list()[0]?.uid ?? '')
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

  /** 供应商前缀（模型全名 = alias/id）。别名留空即用供应商 id（默认值）。 */
  getAlias(): string {
    return this.store.get(this.id).alias || this.id
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

  /** 单链接签到：遍历所有链接 + 汇总是 dsh-router 核心的活，这里只签一个 uid。 */
  async checkinNow(uid: string): Promise<{ ok: boolean; status: string; message?: string }> {
    const r = await this.scheduler.checkinOne(uid)
    // scheduler 签到后会重新拉积分写回池，这里同步时间戳避免 status() 立刻重拉
    if (r.status === 'ok' || r.status === 'already') this.creditsAt.set(uid, Date.now())
    return r
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

  /**
   * 对**单个账号**调一次上游。选号/冷却/禁用/换号是核心的活（AccountPool），
   * 这里只负责：token 刷新 + 上游协议调用/转换，并报告结果。
   */
  async chatOnce(uid: string, req: ChatRequest): Promise<ChatOnceResult> {
    const configName = mapModel(req.model, this.allKnownIds(), this.cfg.defaultModel)
    if (configName === undefined) {
      // 不是本供应商的模型：交给下一个供应商
      this.lastErrText = `unknown model ${JSON.stringify(req.model)}`
      return { ok: false, state: 'no_such_model', message: this.lastErrText }
    }
    if (this.store.get(this.id).disabled.includes(configName)) {
      this.lastErrText = `model ${JSON.stringify(configName)} is disabled`
      return { ok: false, state: 'no_such_model', message: this.lastErrText }
    }

    let body = req.rawBody
    try {
      const obj = JSON.parse(body) as Record<string, unknown>
      obj.model = configName
      body = JSON.stringify(obj)
    } catch {
      // 保持原样
    }

    const acct = this.pool.authByUID(uid)
    if (acct === undefined) {
      this.lastErrText = `unknown account ${JSON.stringify(uid)}`
      return { ok: false, state: 'no_such_model', message: this.lastErrText }
    }

    // token 临近过期 → 先 refresh（过期=这个号现在不可用，核心会按 session_dead 处理）
    try {
      const refreshed = await this.client.refreshTokenIfNeeded(acct, this.cfg.refreshSkewMs)
      if (refreshed) this.saveAuth(acct)
    } catch (err) {
      this.lastErrText = `refresh: ${(err as Error).message}`
      const ue = err as { kind?: string }
      return { ok: false, state: ue.kind === 'session_dead' ? 'session_dead' : 'transport', message: this.lastErrText }
    }

    let streamRes: { body: ReadableStream<Uint8Array> | null; status: number; respBody: string }
    try {
      streamRes = await this.client.chatStream(acct, body)
    } catch (err) {
      this.lastErrText = (err as Error).message
      return { ok: false, state: 'transport', message: this.lastErrText }
    }

    if (streamRes.status >= 400) {
      const kind = classify(streamRes.status, streamRes.respBody)
      this.lastErrText = new UpstreamError(kind, streamRes.status, streamRes.respBody).message
      return { ok: false, state: this.stateOf(kind), message: this.lastErrText }
    }
    if (streamRes.body === null) {
      this.lastErrText = 'traework upstream: empty stream body'
      return { ok: false, state: 'transport', message: this.lastErrText }
    }

    // 流式：SOLO SSE → OpenAI SSE 后交回核心写（响应头已写即绑死，见核心注释）
    if (req.stream) {
      // 流中途出错也要让核心记账（作用于后续请求）
      return { ok: true, stream: this.soloToOpenAI(streamRes.body, (se) => this.noteMidStream(uid, se)) }
    }

    // 非流式：聚合后判空——空响应视为失败，让核心换号/换模型回退
    const { response, error } = await aggregate(linesFromStream(streamRes.body))
    if (error) {
      this.lastErrText = error.message
      this.noteMidStream(uid, error)
      return { ok: false, state: this.stateOf(error.kind()), message: this.lastErrText }
    }
    const msg = (response as { choices?: Array<{ message?: Record<string, unknown> }> })?.choices?.[0]?.message
    const hasContent =
      typeof msg?.content === 'string' && msg.content.length > 0 ||
      typeof msg?.reasoning_content === 'string' && msg.reasoning_content.length > 0 ||
      Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0
    if (!hasContent) {
      this.lastErrText = 'upstream returned empty response'
      return { ok: false, state: 'unknown', message: this.lastErrText }
    }
    return { ok: true, status: 200, body: JSON.stringify(response) }
  }

  /** 上游错误种类 → 契约语义状态（核心据此决定冷却/禁用/换号）。 */
  private stateOf(kind: string): AccountState {
    switch (kind) {
      case 'plan_limit': return 'quota'
      case 'soft_rate': return 'rate_limit'
      case 'session_dead': return 'session_dead'
      case 'not_found': return 'unavailable'
      default: return 'unknown'
    }
  }

  /** 流中途/聚合时才发现的错误：核心已提交响应，这里只记日志（核心的池管不了已提交的流）。 */
  private noteMidStream(uid: string, se: SoloStreamError): void {
    void uid
    if (se.kind() === 'plan_limit') {
      this.log(`traework: account plan limit (mid-stream): ${se.message}`)
    }
  }


  /**
   * SOLO SSE → OpenAI SSE 转换（纯协议转换，**不写 res**）。
   * 返回 OpenAI 格式的流交回核心写；流中途的上游错误通过 onErr 回调暴露——
   * 此时响应头已写出（流式一旦开始就绑死），核心收到错误只能作用于**后续**请求。
   */
  private soloToOpenAI(
    stream: ReadableStream<Uint8Array>,
    onErr?: (se: SoloStreamError) => void,
  ): ReadableStream<Uint8Array> {
    const enc = new TextEncoder()
    const id = `chatcmpl-${Date.now()}`
    return new ReadableStream<Uint8Array>({
      start: async (ctrl) => {
        const chunk = (delta: Record<string, unknown>, finish: string, usage: Record<string, unknown> | null): void => {
          const c: Record<string, unknown> = {
            id,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: '',
            choices: [{ index: 0, delta }],
          }
          if (finish !== '') {
            c.choices = [{ index: 0, delta, finish_reason: finish }]
          }
          if (usage) c.usage = usage
          ctrl.enqueue(enc.encode(`data: ${JSON.stringify(c)}\n\n`))
        }
        let pendingUsage: Record<string, unknown> | null = null
        let sawDone = false
        const done = (): void => {
          ctrl.enqueue(enc.encode('data: [DONE]\n\n'))
          sawDone = true
        }
        try {
          const st = { event: '', data: '' }
          for await (const rawLine of linesFromStream(stream)) {
            const ev = scanLine(st, rawLine.replace(/\r?$/, ''))
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
                if (Object.keys(delta).length > 0) chunk(delta, '', null)
                break
              }
              case 'token_usage':
                pendingUsage = ev.usage
                break
              case 'done':
                chunk({}, ev.finishReason, pendingUsage)
                done()
                break
              case 'error': {
                onErr?.(new SoloStreamError(ev.errorCode, ev.errorMessage))
                ctrl.enqueue(enc.encode(`event: error\ndata: ${JSON.stringify(`solo error code=${ev.errorCode} msg=${ev.errorMessage}`)}\n\n`))
                done()
                break
              }
            }
          }
          if (!sawDone) done()
        } catch (err) {
          // 上游断流：也要给客户端一个收尾，否则客户端一直等
          onErr?.(new SoloStreamError(-1, (err as Error).message))
          if (!sawDone) done()
        } finally {
          ctrl.close()
        }
      },
    })
  }

  // -------------------------------------------------------------------------
  // 积分刷新（后台，不阻塞启动）
  // -------------------------------------------------------------------------

  private refreshCredits(): void {
    for (const st of this.pool.list()) {
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
    // **没有名字的工具调用一律丢掉**：上游偶发漏发/形状不规整时会吐出
    // 无 function 或 name 为空的 tool call，原样转发下去只能失败——下游报
    // `unknown tool ""`，白白浪费一轮还看不出原因。丢掉比转发垃圾好：
    // 客户端看到的是「模型没调工具」，而不是一个指向空名字的报错。
    const name = (call.function as Record<string, unknown> | undefined)?.name
    if (typeof name !== 'string' || name === '') continue
    out.push(call)
  }
  return out
}
