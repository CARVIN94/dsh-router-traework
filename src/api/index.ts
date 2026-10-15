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
import { parseAuth, toAuthDoc, type Auth } from './auth.ts'
import { Pool, type AccountStatus, type PoolStrategy } from './pool.ts'
import type { SupplierConfigStoreLike, CredentialStoreLike, SupplierEnvLike } from '../contract.ts'
import {
  SoloClient,
  UpstreamError,
  classify,
  aggregate,
  linesFromStream,
  parseSoloLine,
  SoloStreamError,
  isRealDeviceId,
} from './upstream.ts'
import { buildLoginUrl, newMarketUserId, newDeviceId, parseLoginCallback, randomId } from './login.ts'
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
  /** 积分拉取时间（uid → ms）：status() 同步返回池里的值，过期后台异步刷新。
   *  积分本身由核心持久化（supplier-config.json），这里只管内存 TTL。 */
  private creditsAt = new Map<string, number>()
  /** 积分缓存有效期。 */
  private static readonly CREDITS_TTL_MS = 10 * 60 * 1000
  /**
   * 拿不到积分时报它（**不是 0**）：核心靠这个区分「没拿到」和「拿到了 0」。
   * 报 0 会把核心那边的缓存冲成 0。
   */
  private static readonly CREDITS_UNKNOWN = -1
  private store: SupplierConfigStoreLike
  private credentials: CredentialStoreLike
  private log: (msg: string) => void
  private modelsCache: ModelInfo[] | undefined
  /** 模型 id → 归属 function（只记非默认的；见 refreshFromUpstream）。 */
  private modelFunctions = new Map<string, string>()
  /** 进行中的凭证刷新（uid → promise）：避免并发轮换 refreshToken 互相覆盖。 */
  private refreshing = new Map<string, Promise<Auth>>()
  /** 上次 chatOnce 失败原因（供核心测试模型汇总诊断）。 */
  private pendingLogin: { machineId: string; deviceId: string } | undefined
  /**
   * 迟到失败上报通道（核心注入，可能没有——老核心/独立运行时没有这个字段）。
   * **调用时才读**：核心是先跑 factory 再挂这个回调的，构造时读必是 undefined。
   */
  private env: SupplierEnvLike

  constructor(cfg: Partial<TraewConfig>, store: SupplierConfigStoreLike, credentials: CredentialStoreLike, log?: (msg: string) => void, env?: SupplierEnvLike) {
    this.log = log ?? (() => {})
    this.env = env ?? {}
    this.cfg = { ...defaultConfig(env?.dataDir ?? ''), ...cfg }
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
  }

  /** 启动：从 dsh-router 凭证存储加载、初始化积分。不再起任何自动任务——
   *  签到是核心的活（POST /suppliers/:id/checkin 手动触发），token 刷新走
   *  chatOnce 触发式路径，插件不挂后台定时器。 */
  async start(): Promise<void> {
    const auths = this.loadAuths()
    this.pool.syncToDir(auths)
    // 积分现在由核心持久化（supplier-config.json），这里拿它预热内存：
    // 异步拉完之前面板就有数，不必等第一次网络往返。
    this.seedCreditsFromCoreCache()
    this.refreshCredits()
  }

  /** 用核心缓存的积分预热（没有缓存的号保持 -1）。
   *  顺带做一次迁移：旧 state.json 里存的积分交给核心，之后核心自己管。 */
  private seedCreditsFromCoreCache(): void {
    const cached = this.store.get(this.id).credits
    const legacy = this.pool.takeLegacyCredits()
    for (const st of this.pool.list()) {
      const v = cached[st.uid] ?? legacy[st.uid]
      if (typeof v === 'number' && v >= 0) {
        this.pool.setCredits(st.uid, v)
        this.creditsAt.set(st.uid, Date.now())
      }
    }
  }

  /** 从 dsh-router 凭证存储读取本供应商全部凭证。 */
  private loadAuths(): Auth[] {
    const out: Auth[] = []
    for (const uid of this.credentials.list(this.id)) {
      try {
        const doc = this.credentials.get<unknown>(this.id, uid)
        if (doc === undefined) continue
        const a: Auth = { ...parseAuth(JSON.stringify(doc)), filePath: '' }
        // 老凭证补 marketUserId / deviceId：两者都是后加的（服务端不提供，
        // 只能本地生成），存量账号缺它们 → ugHeaders 指纹比新账号少一头。
        // 补一次并落盘，之后每次启动都是同一个稳定值。
        let dirty = false
        if (a.marketUserId === undefined || a.marketUserId === '') {
          a.marketUserId = newMarketUserId()
          dirty = true
        }
        // hex32 deviceId 是历史遗留（2026-09-04 订正）：真实客户端发 16 位
        // 纯数字，我们以前发 hex32，在风控眼里不是一个设备号。存量账号
        // 换一次号——它不参与判重（判重维度是账号，实测换新 id 后
        // checked_in 仍为 true），换了不会重复签到。
        if (!isRealDeviceId(a.deviceId)) {
          a.deviceId = newDeviceId()
          dirty = true
        }
        if (dirty) this.saveAuth(a)
        out.push(a)
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
    // 无后台任务需要清理——签到/刷新都是触发式，不挂定时器
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
      void this.freshAuth(a)
        .then(() => this.client.userEntUsage(a))
        .then(
          (remain) => {
            this.pool.setCredits(st.uid, remain)
            this.creditsAt.set(st.uid, Date.now())
          },
          () => this.creditsAt.delete(st.uid), // 失败：下次 status() 再试
        )
    }
  }

  /**
   * 确保凭证可用：临到期/已过期就先刷一次（与 chatOnce 同一条路），刷到就落盘。
   *
   * **所有不经过 chatOnce 的上游调用都必须先过这里**（获取模型、拉积分、签到）：
   * 闲置账号的 accessToken 早就过期了（实测本机三个号全是），拿旧 token 打上游
   * 只会拿到 401/1001，而调用点各自把错吞成「空结果」——表现就是「获取模型点了
   * 没反应 / 积分一直是未知」，看不出是 token 的锅。
   *
   * 同一账号并发刷新会去重：refreshToken 是**轮换**的，两个并发刷新各自拿一份
   * 新 token 再互相覆盖，可能把轮换链写坏（上游吊销后才要重新登录，属于真损失）。
   */
  private freshAuth(a: Auth): Promise<Auth> {
    const inflight = this.refreshing.get(a.uid)
    if (inflight !== undefined) return inflight
    const p = this.client
      .refreshTokenIfNeeded(a, this.cfg.refreshSkewMs)
      .then((refreshed) => {
        // 只在真刷过时落盘：没刷还写一次，启动/每次拉取都白写一遍凭证，
        // 也让「哪里写了盘」这件事变得不可读。
        if (refreshed) this.saveAuth(a)
        return a
      })
      .finally(() => this.refreshing.delete(a.uid))
    this.refreshing.set(a.uid, p)
    return p
  }

  // -------------------------------------------------------------------------
  // 可用模型管理（启用/禁用/自定义/别名 → 通用层 SupplierConfigStore）
  // -------------------------------------------------------------------------

  // 模型列表：每次都真拉上游；缓存由 dsh-router 核心统一管（Router.modelsOf，
  // TTL 10 分钟）。拉取失败**必须抛**，不能返回一份「看起来成功」的列表——
  // 详见 listModels 的注释。这里的 modelsCache 只为本地认 id 用（chatOnce 的
  // mapModel 需要知道哪些 id 是自己的），不作为对外的拉取结果。

  /** 上游拉取的模型 + 自定义模型（本地认 id 用；核心自己也会并 custom）。 */
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

  /**
   * 从上游拉取模型列表（接口获取，不内置数据）。
   *
   * **失败必须抛**——契约（docs/suppliers.md「模型统一策略」）：*「拉到空列表时
   * 核心会保住旧值不当成新结果,所以别用『返回空』表达『上游出错』;出错就抛,
   * 核心会退回旧值(首次则整个供应商剔除)」*。
   *
   * 这里原先 `catch {}` 吞掉一切，于是失败后 `listModels` 返回 `allModels()` ——
   * 那在缓存为空时**恰好只有 custom 那几个 id**，看起来是一次成功的拉取。核心信了
   * 这份「结果」并缓存 10 分钟，面板就一直只有那几个自定义模型（用户报的
   * 「获取模型只有几个」），点一次「获取模型」force 才恢复。缓存归核心管，
   * 插件不自作主张回退。
   */
  private async refreshFromUpstream(): Promise<void> {
    const uid = this.pool.list()[0]?.uid ?? ''
    const acct = this.pool.authByUID(uid)
    // 一个号都没有：不是上游出错，是这家确实没有可拉的名录。返回空列表是诚实的
    // （自定义模型由核心自己并进来，见 router/index.ts 的 refreshModels）。
    if (!acct) return
    try {
      // 先保证 token 可用：闲置号的 accessToken 早过期，直接拉会拿到空表。
      await this.freshAuth(acct)
      const models = await this.client.fetchModels(acct)
      const fetched: ModelInfo[] = []
      // 模型 → 归属 function：chat 时必须回放它（发错时上游 HTTP 200 但流内
      // `code=4001`）。只记非默认 function，默认值保持不写、走 SOLO.Function。
      const byFunction = new Map<string, string>()
      for (const m of models) {
        if (m.id === '') continue
        const entry: ModelInfo = { id: m.id }
        // 契约单位是 **K**（核心 comboContextWindow 换算回 token，见
        // dsh-router docs/suppliers.md「模型统一策略」）。以前这里恒为 0——
        // 上游明明给了 context_window_tokens，我们没读，于是核心拿不到窗口、
        // 自动压缩一直跳过（DSH 侧表现为「永远不压缩」）。
        if (m.contextWindow > 0) entry.context_length = Math.round(m.contextWindow / 1000)
        fetched.push(entry)
        if (m.function !== '' && m.function !== SOLO.Function) byFunction.set(m.id, m.function)
      }
      // fetchModels 已保证非空（远端与详情都空时它自己抛）——这里不再兜一遍空表，
      // 免得写出永远不会走的分支。
      this.modelsCache = fetched
      this.modelFunctions = byFunction
    } catch (err) {
      // 记一笔再抛：这条路上原来完全没有日志，症状只能靠面板猜。
      this.log(`traework: 拉取模型失败(uid=${uid}) ${(err as Error).message}`)
      throw err
    }
  }

  /** 该模型应发往的 function（上游按 function 拆名录；未知则用默认）。 */
  private functionFor(configName: string): string {
    return this.modelFunctions.get(configName) ?? SOLO.Function
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

  /** 单链接签到：遍历所有链接 + 汇总是 dsh-router 核心的活，这里只签一个 uid。
   *  真实语义（参考 traework2api / wild-work）：
   *    status 判定：checked_in=true → 今日已签；!enable → 未开放；
   *    仅 !checkedIn && enable 才 claim，claim 后**重查 status 确认**才算成功。
   *
   *  为什么必须回查：积分（user_ent_usage）是**所有包**的聚合剩余额度，
   *  实测某账号签到前后都是同一个数——拿它判成败会谎报「签到成功」。
   *  只有 status.checked_in 是这次签到的真凭据。
   *
   *  两个字段判定维度不同（2026-10-10 实测复核）：
   *    checked_in     按**账号**——该账号今天的奖励包已到账
   *    did_checked_in 按**设备**——本机今天的名额已用，不区分哪个账号用的
   *  （实测证据：同一账号带本机真实设备号读 did_checked_in=true、带另一个号读
   *  false；checked_in 只随账号变。旧 README 把两者记反了。）
   *
   *  `!checkedIn && didCheckedIn` = 本机名额被（另一个账号）用掉，而这个账号
   *  一分没领到。此时 claim 必被拒，如实报 device_used，**不能**报「今日已签到」。 */
  async checkinNow(uid: string): Promise<{ ok: boolean; status: 'ok' | 'already' | 'disabled' | 'device_used' | 'error'; message?: string }> {
    const st = this.pool.list().find((s) => s.uid === uid)
    if (st === undefined) return { ok: false, status: 'error', message: '链接不存在' }
    const a = this.pool.authByUID(uid)
    if (!a || a.refreshToken === '') return { ok: false, status: 'error', message: '凭证缺失' }
    try {
      // 闲置账号的 accessToken 早就过期了，先刷再打上游（与 chatOnce 同一条路）。
      // 以前只有 chatOnce 刷，于是「一直没用过的号点签到 / 拉积分」必然失败。
      await this.freshAuth(a)
      const status = await this.client.checkinStatus(a)
      if (status.checkedIn) {
        await this.refreshCreditsAfterCheckin(uid, a)
        // 今日已签到（traework 服务端 1 天 1 次），幂等成功
        this.creditsAt.set(uid, Date.now())
        return { ok: true, status: 'already', message: '今日已签到' }
      }
      if (!status.enable) {
        return { ok: false, status: 'disabled', message: '今日签到未开放' }
      }
      const claimed = await this.client.checkinClaim(a)
      this.log(`checkin ${uid}: ${claimed}`)
      // 回查：claim 返回 0 也不代表真签上了，checked_in 才是凭据
      const after = await this.client.checkinStatus(a)
      await this.refreshCreditsAfterCheckin(uid, a)
      if (after.checkedIn) {
        // 账号今天的奖励包已到账：claim=ok 是这次领到的，否则是本来就有（幂等）
        this.creditsAt.set(uid, Date.now())
        return claimed === 'ok'
          ? { ok: true, status: 'ok', message: '签到成功' }
          : { ok: true, status: 'already', message: '今日已签到' }
      }
      // 没入账。9095 = **该设备**今日已参与签到（不是「这个账号已领」）：本机
      // 名额被用掉时当前账号就是这个下场——如实报原因，别谎报成幂等成功。
      if (claimed === 'device_used') {
        return {
          ok: false,
          status: 'device_used',
          message: '本机设备今日的签到名额已被用掉（通常是本机另一个账号先领了），该账号今天领不到',
        }
      }
      return { ok: false, status: 'error', message: '签到未生效：上游未标记已签到' }
    } catch (err) {
      const message = (err as Error).message
      this.log(`checkin ${uid}: ${message}`)
      return { ok: false, status: 'error', message }
    }
  }

  /** 签到后刷新积分（失败不阻断——积分只供面板显示，不是签到成败的凭据）。 */
  private async refreshCreditsAfterCheckin(uid: string, a: Auth): Promise<void> {
    try {
      this.pool.setCreditsAfterCheckin(uid, await this.client.userEntUsage(a))
    } catch (err) {
      this.log(`checkin ${uid}: 积分刷新失败 ${(err as Error).message}`)
    }
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

  // -------------------------------------------------------------------------
  // 登录（加账号）：生成登录链接 → 粘贴回调 → 换 token 落盘
  // -------------------------------------------------------------------------

  /** 生成登录链接并记住本次 machine/device id（回调完成时复用）。 */
  generateLoginUrl(): string {
    const machineId = randomId() // hex32（真实客户端形态）
    const deviceId = newDeviceId() // 16 位纯数字（真实客户端形态）
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
      // 服务端不提供 marketUserId（抓包实证），只能本地生成并持久化
      marketUserId: newMarketUserId(),
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
  async chatOnce(uid: string, lv: string, req: ChatRequest): Promise<ChatOnceResult> {
    const configName = mapModel(req.model, this.allKnownIds(), this.cfg.defaultModel)
    if (configName === undefined) {
      // 不是本供应商的模型：交给下一个供应商
      const msg = `unknown model ${JSON.stringify(req.model)}`
      return { ok: false, state: 'no_such_model', message: msg }
    }
    if (this.store.get(this.id).disabled.includes(configName)) {
      const msg = `model ${JSON.stringify(configName)} is disabled`
      return { ok: false, state: 'no_such_model', message: msg }
    }

    let body = req.rawBody
    try {
      const obj = JSON.parse(body) as Record<string, unknown>
      obj.model = configName
      // 默认带上 1M 的 max_tokens（未显式指定时）。透传给上游，见 prepareBody 白名单改写。
      if (typeof obj.max_tokens !== 'number') obj.max_tokens = 1000000
      // 推理等级：上游自己的协议里若认 reasoning_effort 就带上；auto/off 不显式下发
      if (lv !== 'auto' && lv !== '' && lv !== 'none' && lv !== 'off') obj.reasoning_effort = lv
      else if (lv === 'none' || lv === 'off') {
        delete obj.reasoning_effort
        delete obj.reasoning_summary
      }
      body = JSON.stringify(obj)
    } catch {
      // 保持原样
    }

    const acct = this.pool.authByUID(uid)
    if (acct === undefined) {
      const msg = `unknown account ${JSON.stringify(uid)}`
      return { ok: false, state: 'no_such_model', message: msg }
    }

    // token 临近过期 → 先 refresh（过期=这个号现在不可用，核心会按 session_dead 处理）
    try {
      await this.freshAuth(acct)
    } catch (err) {
      const ue = err as { kind?: string }
      return { ok: false, state: ue.kind === 'session_dead' ? 'session_dead' : 'transport', message: `refresh: ${(err as Error).message}` }
    }

    let streamRes: { body: ReadableStream<Uint8Array> | null; status: number; respBody: string }
    try {
      // 回放该模型自己的归属 function：上游把名录按 function 拆开，发错时
      // HTTP 200 但流内 code=4001（看起来像「参数无效」，实际是「这个 function
      // 不服务这个模型」）。未知名回落默认 function。
      streamRes = await this.client.chatStream(acct, body, this.functionFor(configName))
    } catch (err) {
      const msg = (err as Error).message
      return { ok: false, state: 'transport', message: msg }
    }

    if (streamRes.status >= 400) {
      const kind = classify(streamRes.status, streamRes.respBody)
      const msg = new UpstreamError(kind, streamRes.status, streamRes.respBody).message
      return { ok: false, state: this.stateOf(kind), message: msg }
    }
    if (streamRes.body === null) {
      const msg = 'traework upstream: empty stream body'
      return { ok: false, state: 'transport', message: msg }
    }

    // 流式：SOLO SSE → OpenAI SSE 后交回核心写（响应头已写即绑死，见核心注释）
    if (req.stream) {
      // 流中途出错：响应头已写出无法回退，但必须上报核心记账（作用于后续请求）。
      // 上报用**剥掉供应商前缀后的模型 id**——核心的冷却键是
      // (supplier, modelId, uid)，核心记账用的正是它剥好的 modelId
      // （chatWithModel 里 clone.model = modelId）。这里直接拿插件已解析出的
      // configName 最准：它就是最终发给上游、也是核心认的那个 id。
      return { ok: true, stream: this.soloToOpenAI(streamRes.body, (se) => this.noteMidStream(uid, configName, se)) }
    }

    // 非流式：聚合后判空——空响应视为失败，让核心换号/换模型回退
    const { response, error } = await aggregate(linesFromStream(streamRes.body))
    if (error) {
      // 只记日志：响应尚未提交，核心拿到返回值会自己 noteFailure（再报就是双记）
      this.logMidStream(error)
      return { ok: false, state: this.stateOf(error.kind()), message: error.message }
    }
    const msg = (response as { choices?: Array<{ message?: Record<string, unknown> }> })?.choices?.[0]?.message
    const hasContent =
      typeof msg?.content === 'string' && msg.content.length > 0 ||
      typeof msg?.reasoning_content === 'string' && msg.reasoning_content.length > 0 ||
      Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0
    if (!hasContent) {
      const msg = 'upstream returned empty response'
      return { ok: false, state: 'unknown', message: msg }
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

  private logMidStream(se: SoloStreamError): void {
    if (se.kind() === 'plan_limit') {
      this.log(`traework: account plan limit (mid-stream): ${se.message}`)
    }
  }

  /**
   * 流中途才发现的错误：响应头已写出（流式一旦开始就绑死），这次请求救不回来
   * 了 —— 但**「这个号坏了」必须让核心知道**，否则它继续留在池里被轮转选中，
   * 每次都白撞同一个错误（实测三选二的号全废 = 2/3 请求直接失败）。
   *
   * 经 `env.onLateFailure` 上报（核心实现 = `pool.noteFailure`），作用于
   * **后续**请求：按语义状态冷却/禁用，坏号随即退出轮转。
   * 拿不到这个通道（老核心/独立运行时）就只记日志，退化成旧行为。
   *
   * **仅限流式**：非流式路径响应尚未提交，核心会自己 `noteFailure`，
   * 这里再报一次就是双记 —— `rate_limit` 是指数退避，多记一次会多跳一级。
   */
  private noteMidStream(uid: string, model: string, se: SoloStreamError): void {
    this.logMidStream(se)
    const report = this.env.onLateFailure
    if (report === undefined || uid === '') return
    try {
      report(uid, model, this.stateOf(se.kind()), se.message)
    } catch (err) {
      // 上报失败绝不能影响这次响应（流还在写）
      this.log(`traework: onLateFailure 上报失败: ${(err as Error).message}`)
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
        /** 已见（带名字）的 tool_call index：续帧（无 name）靠它放行。 */
        const seenToolIdx = new Set<number>()
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
                  const tc = normalizeToolCalls(ev.toolCalls, seenToolIdx)
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
                // 上游流内错误必须写成**合规的 OpenAI 帧**，不能只发
                // `event: error` + 裸字符串：dsh-llm 的 translateSse 只解析
                // `choices[].delta/finish_reason`，裸字符串帧解析不出 choices
                // → 错误信息全丢，且 [DONE] 时因「无任何产出块」被判
                // EMPTY_RESPONSE —— 而这个码在 dsh-llm 的可重试白名单里，
                // 于是 agent-loop 会对**永久失败**（如 code 4001 参数无效、
                // 4023 模型不可用）白重试 5 次，用户侧只看到「空响应」。
                //
                // 改法：先吐一帧带 content 的 delta（让错误原因可见），
                // 再用 finish_reason='UPSTREAM_ERROR' 收尾。它不在白名单
                // （EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT），
                // 所以不会重试；mapFinishReason 的 default 分支会把它转成
                // error finish，agent-loop 拿到的是真错误而不是空响应。
                //
                // 天花板：此时响应头通常已写出（HTTP 语义绑死），无法换号
                // 重试，只能把错误如实暴露。要能回退得在写头前缓冲（核心
                // 侧改动，代价首字节延迟，见 dsh-router writeChatResult 注）。
                chunk({ content: `upstream error code=${ev.errorCode}${ev.errorMessage !== '' ? `: ${ev.errorMessage}` : ''}` }, 'UPSTREAM_ERROR', pendingUsage)
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

function normalizeToolCalls(raw: unknown, seen: Set<number>): unknown[] {
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
    // 兼容 function_call 别名（SOLO 分帧首帧形态）
    if (call.function_call !== null && typeof call.function_call === 'object') {
      call.function = call.function_call
      delete call.function_call
    }
    // 真实上游还会用顶层 name/arguments/params/input/tool_name 形态（trae-solo-local-api
    // 的 llmUtilsChunkToOpenAI 就是按这些字段取的）——不能只认 function/function_call，
    // 否则顶层形态的续帧会被当垃圾丢掉，参数残缺 → 下游 [DONE] 判 EMPTY_RESPONSE。
    const topName = call.name ?? call.tool_name
    const topArgs = call.arguments ?? call.params ?? call.input
    const fn = call.function as Record<string, unknown> | undefined
    if (fn === null || typeof fn !== 'object') {
      if (typeof topName !== 'string' && topArgs === undefined) continue // 真垃圾
      call.function = {}
    }
    const f = call.function as Record<string, unknown>
    if (typeof topName === 'string' && topName !== '' && typeof f.name !== 'string') f.name = topName
    if (topArgs !== undefined && f.arguments === undefined) f.arguments = topArgs
    // partial_arguments 兜底：arguments 缺失时用它，别直接删掉
    if (f.arguments === undefined && f.partial_arguments !== undefined) f.arguments = f.partial_arguments
    delete f.namespace
    delete f.partial_arguments
    delete call.name
    delete call.tool_name
    delete call.params
    delete call.input
    const idx = typeof call.index === 'number' ? call.index : 0
    const name = f.name
    if (typeof name === 'string' && name !== '') {
      // 首帧（带名字）→ 记住 index，续帧靠它放行
      seen.add(idx)
    } else if (!seen.has(idx)) {
      // 没名字且没见过这个 index → 垃圾首帧，丢掉。不能一律丢「没名字」的帧：
      // SOLO 把工具参数**分帧下发**，续帧只有 arguments、没有 name（非流式聚合
      // 路径 mergeToolCallDelta 逐帧拼接 arguments 就是证据）——丢续帧 = 参数残缺，
      // 下游在 [DONE] 判 EMPTY_RESPONSE。
      continue
    }
    // 续帧（index 已见）放行：name 缺省下游沿用首帧；显式空名由 dsh-router
    // 核心 fixFrame 剥掉，不会覆盖首帧名字。
    out.push(call)
  }
  return out
}
