/**
 * TRAE SOLO 上游客户端：llm_utils_chat / get_detail_param / ExchangeToken /
 * checkin_credits / ide_user_ent_usage + 错误分类 + SSE 转换。
 * 移植自 traework2api/internal/upstream/*（client.go / headers.go / payload.go / solosse.go）。
 */
import { SOLO, CLIENT_UA } from './constants.ts'
import { needsRefresh, type Auth } from './auth.ts'

// ---------------------------------------------------------------------------
// 错误分类（SPEC §4.3）
// ---------------------------------------------------------------------------

export type ErrKind =
  | 'none' // 成功
  | 'plan_limit' // 1005 + plan → 权益不足（硬冷却 12h）
  | 'soft_rate' // 429 → 短冷却 60s
  | 'session_dead' // 401 + Cloud-IDE-JWT 失效 → 禁用
  | 'not_found' // 404 → 短冷却 60s 不累计 errCount
  | 'server' // 5xx
  | 'client' // 其他 4xx
  | 'checkin_denied' // 签到专属：上游拒绝发放（9074），与限流无关

/** 签到业务码：今日已签到（幂等，按成功处理）。 */
const CHECKIN_ALREADY_CODE = 9095

/**
 * 签到业务码：「当前参与用户太多」。
 *
 * **不是短时抖动，是账号级稳定拒绝**（2026-09-02 实测订正，旧注释写错了）：
 * 两个账号连续 2 天、40 余次请求全部 9074；刷新 token、换 deviceId、
 * 改 UA/region/body 均无变化。决定性对照：把失败账号的 deviceId 借给成功
 * 账号 → 成功账号照样 code 0；把成功账号的 deviceId 借给失败账号 → 失败
 * 账号仍 9074。**失败跟着账号走，不跟着设备走**。
 *
 * 所以它跟 chat 的 429 限流不是一回事，不该复用 'soft_rate'。
 * 重试策略见 checkinClaim——保留一次快速重试只为兜住「万一上游哪天恢复成
 * 真抖动」，成本压到最低。
 */
const CHECKIN_BUSY_CODE = 9074

/** 9074 重试等待：只等 1s。一次落空就判失败，不再空耗（实测重试几乎必空）。 */
const CHECKIN_BUSY_RETRY_MS = 1000

export class UpstreamError extends Error {
  kind: ErrKind
  status: number
  constructor(kind: ErrKind, status: number, msg: string) {
    super(`upstream ${kind} (http ${status}): ${msg}`)
    this.kind = kind
    this.status = status
  }
}

const sessionDeadMarkers = ['login', 'token 失效', 'token invalid', 'session', 'unauthorized', '401']

/** 按 HTTP 状态码 + body 判定错误类别（SPEC §4.3）。 */
export function classify(status: number, body: string): ErrKind {
  const lower = body.toLowerCase()
  if (body.includes('"code":1005') || (body.includes('1005') && lower.includes('plan'))) {
    return 'plan_limit'
  }
  if (status === 401) return 'session_dead'
  if (status === 429) return 'soft_rate'
  if (status === 404) return 'not_found'
  if (status >= 500) return 'server'
  if (status >= 400) return 'client'
  return 'none'
}

function truncate(s: string, n: number): string {
  s = s.trim()
  return s.length > n ? s.slice(0, n) : s
}

// ---------------------------------------------------------------------------
// 请求头（headers.go）
// ---------------------------------------------------------------------------

/** SOLOHeaders：llm_utils_chat / get_detail_param 所需的 SOLO 专属头。 */
export function soloHeaders(a: Auth, stream: boolean): Record<string, string> {
  const at = a.accessToken
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: stream ? 'text/event-stream' : 'application/json',
    'User-Agent': CLIENT_UA,
    Authorization: `Cloud-IDE-JWT ${at}`,
    'X-Cloudide-Token': at,
    'X-Ide-Token': at,
    'X-App-Id': SOLO.AppID,
    'X-App-Version': 'default',
    'X-Ide-Version': SOLO.IdeVersion,
    'X-Ide-Version-Code': SOLO.IdeVersionCode,
    'X-App-Version-Code': SOLO.IdeVersionCode,
    'X-Ide-Version-Type': 'stable',
    'X-Device-Type': 'windows',
    'X-OS-Version': SOLO.OSVersion,
    'X-Device-Brand': SOLO.DeviceBrand,
    'Request-Traffic-Type': 'prod',
  }
  if (a.uid !== '') h['X-Uid'] = a.uid
  if (a.machineId !== '') h['X-Machine-Id'] = a.machineId
  if (a.deviceId !== '') h['X-Device-Id'] = a.deviceId
  return h
}

/** UgHeaders：签到/积分（api.trae.cn）所需头。 */
export function ugHeaders(a: Auth): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': CLIENT_UA,
    Authorization: `Cloud-IDE-JWT ${a.accessToken}`,
    'X-User-Region': 'CN',
  }
  if (a.deviceId !== '') h['X-Device-Id'] = a.deviceId
  return h
}

/** OAuthHeaders：ExchangeToken / GetUserInfo 所需头（无签名，仅 UA）。 */
export function oauthHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': CLIENT_UA,
  }
}

// ---------------------------------------------------------------------------
// payload.go — OpenAI → SOLO llm_utils_chat 请求体改写
// ---------------------------------------------------------------------------

/** OpenAI → SOLO 单 pass 改写；无法解析时原样返回。 */
export function prepareBody(src: string): string {
  if (src === '') return src
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(src) as Record<string, unknown>
  } catch {
    return src
  }
  obj.stream = true
  obj.function = SOLO.Function

  const msgs = obj.messages
  if (Array.isArray(msgs)) {
    for (const mi of msgs) {
      const m = mi as Record<string, unknown>
      if (typeof m !== 'object' || m === null) continue
      const content = m.content
      const present = 'content' in m
      const role = typeof m.role === 'string' ? m.role : ''

      // assistant 消息回传 tool_calls: OpenAI function → 上游 function_call
      if (role === 'assistant' && Array.isArray(m.tool_calls)) {
        const kept: unknown[] = []
        for (const tci of m.tool_calls as unknown[]) {
          const tc = tci as Record<string, unknown>
          if (typeof tc !== 'object' || tc === null) continue
          if (tc.function !== null && typeof tc.function === 'object') {
            tc.function_call = tc.function
            delete tc.function
          }
          const fc = tc.function_call as Record<string, unknown> | undefined
          if (fc !== null && typeof fc === 'object') {
            const name = typeof fc.name === 'string' ? fc.name.trim() : ''
            if (name === '') continue // 上游要求 FunctionCall.Name 必填
          }
          kept.push(tc)
        }
        if (kept.length === 0) delete m.tool_calls
        else m.tool_calls = kept
      }

      if (!present || content === null || content === undefined) continue
      if (typeof content === 'string') {
        m.content = [{ type: 'text', text: content }]
      }
      // 已是数组 → 透传
    }
  }

  let model = typeof obj.model === 'string' ? obj.model.trim() : ''
  if (model === '') model = DEFAULT_MODEL
  obj.config_name = model
  obj.model = model

  normalizeToolChoice(obj)
  normalizeTools(obj)
  try {
    return JSON.stringify(obj)
  } catch {
    return src
  }
}

export const DEFAULT_MODEL = 'glm-5.2'

function normalizeToolChoice(obj: Record<string, unknown>): void {
  const suppress = (): void => {
    delete obj.tools
    delete obj.functions
  }
  if (!('tool_choice' in obj)) return
  const tc = obj.tool_choice
  if (typeof tc === 'string') {
    if (tc.trim().toLowerCase() === 'none') {
      delete obj.tool_choice
      suppress()
    }
    return
  }
  if (tc !== null && typeof tc === 'object') {
    const v = tc as Record<string, unknown>
    const typ = String(v.type ?? '').trim().toLowerCase()
    switch (typ) {
      case 'none':
        delete obj.tool_choice
        suppress()
        break
      case 'auto':
      case 'required':
        obj.tool_choice = typ
        break
      case 'function': {
        let name = ''
        if (v.function !== null && typeof v.function === 'object') {
          name = String((v.function as Record<string, unknown>).name ?? '')
        }
        if (name === '') name = String(v.name ?? '')
        name = name.trim()
        obj.tool_choice = name !== '' ? name : 'auto'
        break
      }
      default:
        delete obj.tool_choice
    }
    return
  }
  delete obj.tool_choice
}

function normalizeTools(obj: Record<string, unknown>): void {
  if (!('tools' in obj)) return
  const list = obj.tools
  if (!Array.isArray(list) || list.length === 0) return
  const out: unknown[] = []
  for (const item of list) {
    const t = item as Record<string, unknown>
    if (typeof t !== 'object' || t === null) continue
    const fn = t.function as Record<string, unknown> | undefined
    if (typeof fn !== 'object' || fn === null) continue
    if ('parameters' in fn && fn.parameters !== null && typeof fn.parameters === 'object') {
      try {
        fn.parameters = JSON.stringify(fn.parameters)
      } catch {
        // 保持原样
      }
    }
    out.push(t)
  }
  if (out.length === 0) delete obj.tools
  else obj.tools = out
}

// ---------------------------------------------------------------------------
// solosse.go — SOLO SSE → OpenAI SSE（流式转换 + 非流式聚合）
// ---------------------------------------------------------------------------

export interface SoloEvent {
  event: string
  response: string
  reasoning: string
  toolCalls: unknown
  usage: Record<string, unknown> | null
  finishReason: string
  errorCode: number
  errorMessage: string
}

/** 解析一条事件（eventName 为 event 行值，dataLine 为 data 行值）。 */
export function parseSoloLine(eventName: string, dataLine: string): SoloEvent | undefined {
  const ev: SoloEvent = {
    event: eventName.trim(),
    response: '',
    reasoning: '',
    toolCalls: null,
    usage: null,
    finishReason: '',
    errorCode: 0,
    errorMessage: '',
  }
  if (dataLine === '') return ev
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(dataLine) as Record<string, unknown>
  } catch {
    return ev
  }
  switch (ev.event) {
    case 'output':
      if (typeof raw.response === 'string') ev.response = raw.response
      if (typeof raw.reasoning_content === 'string') ev.reasoning = raw.reasoning_content
      if ('tool_calls' in raw) ev.toolCalls = raw.tool_calls
      break
    case 'token_usage':
      ev.usage = raw
      break
    case 'done':
      if (typeof raw.finish_reason === 'string') ev.finishReason = raw.finish_reason
      break
    case 'error':
      if (typeof raw.code === 'number') ev.errorCode = raw.code
      if (typeof raw.message === 'string') ev.errorMessage = raw.message
      break
  }
  return ev
}

/** 逐行处理 SOLO SSE；line 为单行（不含 \n）。返回该行触发的事件。 */
export function scanLine(st: { event: string; data: string }, line: string): SoloEvent | undefined {
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
  // ':' 注释行忽略
  return undefined
}

/** SOLO 流内业务错误。 */
export class SoloStreamError extends Error {
  code: number
  constructor(code: number, msg: string) {
    super(`solo error code=${code} msg=${msg}`)
    this.code = code
  }
  kind(): ErrKind {
    return this.code === 1005 ? 'plan_limit' : 'client'
  }
}

function mergeToolCallDelta(merged: Record<string, unknown>, delta: Record<string, unknown>): void {
  if (typeof delta.id === 'string' && delta.id !== '') merged.id = delta.id
  if (typeof delta.type === 'string' && delta.type !== '') merged.type = delta.type
  let df = delta.function as Record<string, unknown> | undefined
  if (df === null || typeof df !== 'object') df = delta.function_call as Record<string, unknown> | undefined
  if (df === null || typeof df !== 'object') return
  delete df.namespace
  delete df.partial_arguments
  let mf = merged.function as Record<string, unknown> | undefined
  if (mf === null || typeof mf !== 'object') {
    mf = {}
    merged.function = mf
  }
  if (typeof df.name === 'string' && df.name !== '') mf.name = df.name
  if (typeof df.arguments === 'string' && df.arguments !== '') {
    const prev = typeof mf.arguments === 'string' ? mf.arguments : ''
    mf.arguments = prev + df.arguments
  }
}

function mergeToolCallJSON(
  toolCalls: Map<number, Record<string, unknown>>,
  toolOrder: number[],
  raw: unknown,
): void {
  if (raw === null || raw === undefined || raw === 'null') return
  let arr: unknown[]
  if (Array.isArray(raw)) {
    arr = raw
  } else if (typeof raw === 'object') {
    arr = [raw]
  } else {
    try {
      arr = JSON.parse(String(raw)) as unknown[]
    } catch {
      return
    }
  }
  for (const item of arr) {
    const call = item as Record<string, unknown>
    if (call === null || typeof call !== 'object') continue
    let idx = 0
    if (typeof call.index === 'number') idx = call.index
    let merged = toolCalls.get(idx)
    if (merged === undefined) {
      merged = { index: idx }
      toolCalls.set(idx, merged)
      toolOrder.push(idx)
    }
    mergeToolCallDelta(merged, call)
  }
}

/**
 * 读取完整 SOLO SSE（迭代器按行），聚合 response + reasoning + tool_calls + usage，
 * 产出单个 OpenAI chat.completion（非流式）。返回 undefined 表示应视为流错误。
 */
export function aggregate(iter: AsyncIterable<string>): Promise<{ response: Record<string, unknown>; error?: SoloStreamError }> {
  return (async () => {
    const st = { event: '', data: '' }
    let content = ''
    let reasoning = ''
    let finishReason = 'stop'
    let usage: Record<string, unknown> | null = null
    const toolCalls = new Map<number, Record<string, unknown>>()
    const toolOrder: number[] = []
    let upstreamErr: SoloStreamError | undefined
    let id = ''

    for await (const rawLine of iter) {
      const line = rawLine.replace(/\r?\n$/, '')
      const ev = scanLine(st, line)
      if (ev) {
        switch (ev.event) {
          case 'output':
            content += ev.response
            reasoning += ev.reasoning
            mergeToolCallJSON(toolCalls, toolOrder, ev.toolCalls)
            break
          case 'token_usage':
            usage = ev.usage
            break
          case 'done':
            if (ev.finishReason !== '') finishReason = ev.finishReason
            break
          case 'error':
            upstreamErr = new SoloStreamError(ev.errorCode, ev.errorMessage)
            break
        }
      }
    }
    if (upstreamErr) return { response: {}, error: upstreamErr }
    if (id === '') id = `chatcmpl-${Date.now()}`
    const message: Record<string, unknown> = { role: 'assistant', content }
    if (reasoning !== '') message.reasoning_content = reasoning
    if (toolOrder.length > 0) {
      toolOrder.sort((a, b) => a - b)
      message.tool_calls = toolOrder.map((idx) => toolCalls.get(idx))
    }
    const resp: Record<string, unknown> = {
      id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: '',
      choices: [{ index: 0, message, finish_reason: finishReason }],
    }
    if (usage) resp.usage = usage
    return { response: resp }
  })()
}

// ---------------------------------------------------------------------------
// HTTP 客户端
// ---------------------------------------------------------------------------

export interface SoloClientOptions {
  agentHost?: string
  ugHost?: string
  oauthHost?: string
  timeoutSeconds?: number
  /** fetch 实现（默认全局 fetch；测试注入）。 */
  fetchImpl?: typeof fetch
  /** 签到遇 9074 后的重试等待；生产默认 1s，测试注入 0 免等待。 */
  checkinRetryDelayMs?: number
  /** 可注入的 sleep（测试免等待）。 */
  sleep?: (ms: number) => Promise<void>
}

/** SOLO 上游 HTTP 客户端。 */
export class SoloClient {
  private agentHost: string
  private ugHost: string
  private oauthHost: string
  private timeoutSeconds: number
  private fetchImpl: typeof fetch
  private checkinRetryDelayMs: number
  private sleepImpl: (ms: number) => Promise<void>

  constructor(opts: SoloClientOptions = {}) {
    this.agentHost = opts.agentHost ?? SOLO.AgentHost
    this.ugHost = opts.ugHost ?? SOLO.UgHost
    this.oauthHost = opts.oauthHost ?? SOLO.OAuthHost
    this.timeoutSeconds = opts.timeoutSeconds ?? 120
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.checkinRetryDelayMs = opts.checkinRetryDelayMs ?? CHECKIN_BUSY_RETRY_MS
    this.sleepImpl = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  /** 发短 JSON 请求并解 JSON；非 2xx 返回 *UpstreamError。 */
  private async doJSON(url: string, headers: Record<string, string>, bodyObj: unknown): Promise<unknown> {
    let resp: Response
    try {
      resp = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(bodyObj),
        signal: AbortSignal.timeout(this.timeoutSeconds * 1000),
      })
    } catch (error) {
      throw new Error(`transport: ${(error as Error).message}`)
    }
    const text = await resp.text()
    if (resp.status >= 400) {
      throw new UpstreamError(classify(resp.status, text), resp.status, truncate(text, 200))
    }
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  /** 通过 ExchangeToken 强制刷新 access token（refreshToken 轮换）。 */
  async refreshToken(a: Auth): Promise<void> {
    if (a.refreshToken.trim() === '') throw new Error('no refreshToken')
    const host = a.apiHost !== '' ? a.apiHost : this.oauthHost
    const data = await this.doJSON(
      host + SOLO.EpExchange,
      oauthHeaders(),
      {
        ClientID: SOLO.ClientID,
        RefreshToken: a.refreshToken,
        ClientSecret: '-',
        UserID: '',
      },
    )
    const result = (data as { Result?: Record<string, unknown> })?.Result ?? {}
    const token = String(result.Token ?? '')
    if (token === '') throw new Error('refresh_failed: no token in response — re-login required')
    a.accessToken = token
    if (typeof result.RefreshToken === 'string' && result.RefreshToken !== '') {
      a.refreshToken = result.RefreshToken
    }
    const expireAt = Number(result.TokenExpireAt ?? 0)
    if (expireAt > 0) {
      a.expiresAt = expireAt > 1e12 ? Math.floor(expireAt / 1000) : expireAt
    } else {
      const dur = Number(result.TokenExpireDuration ?? 0)
      if (dur > 0) a.expiresAt = Math.floor(Date.now() / 1000) + dur
    }
  }

  /** 仅当 token 在 skewMs 内即将过期时才刷新，返回是否真正刷新。 */
  async refreshTokenIfNeeded(a: Auth, skewMs: number): Promise<boolean> {
    if (!needsRefresh(a, skewMs)) return false
    await this.refreshToken(a)
    return true
  }

  /**
   * 发 llm_utils_chat 请求并返回原始 SSE body 流（调用方负责 Close）。
   * 非 2xx 时 body 为 null、返回上游状态与响应体；只有传输层失败才抛错。
   */
  async chatStream(a: Auth, body: string): Promise<{
    body: ReadableStream<Uint8Array> | null
    status: number
    respBody: string
  }> {
    let resp: Response
    try {
      resp = await this.fetchImpl(this.agentHost + SOLO.EpChat, {
        method: 'POST',
        headers: soloHeaders(a, true),
        body: prepareBody(body),
      })
    } catch (error) {
      throw new Error(`transport: ${(error as Error).message}`)
    }
    if (resp.status >= 400) {
      const raw = await resp.text()
      return { body: null, status: resp.status, respBody: raw }
    }
    return { body: resp.body, status: resp.status, respBody: '' }
  }

  /** 动态模型信息。 */
  async fetchModels(a: Auth): Promise<Array<{ id: string; name: string; contextWindow: number; maxTokens: number }>> {
    const data = await this.doJSON(
      this.agentHost + SOLO.EpModels,
      soloHeaders(a, false),
      {
        function: SOLO.Function,
        config_names: null,
        need_prompt: false,
        current_config_info: null,
        poly_prompt: true,
        mode_type: null,
        agent_type: null,
      },
    )
    const list = (data as { config_info_list?: unknown[] })?.config_info_list ?? []
    const out: Array<{ id: string; name: string; contextWindow: number; maxTokens: number }> = []
    for (const cfg of list) {
      const c = cfg as { config_name?: string; display_config?: { display_name?: string; is_custom_model?: boolean } }
      if (!c.config_name) continue
      // 过滤用户/其他工具在 TRAE 云端添加的自定义模型（base_url 指向别处，不属于本供应商）
      if (c.display_config?.is_custom_model === true) continue
      out.push({ id: c.config_name, name: c.display_config?.display_name ?? '', contextWindow: 0, maxTokens: 0 })
    }
    if (out.length === 0) throw new Error('models api returned empty list')
    return out
  }

  /** 查询签到状态。业务 code 非 0 也报错——上游一律 200，成败只在 code 里。 */
  async checkinStatus(a: Auth): Promise<{ checkedIn: boolean; credits: number; enable: boolean }> {
    const data = await this.doJSON(this.ugHost + SOLO.EpCheckinStatus, ugHeaders(a), {})
    const r = data as { checked_in?: boolean; credits?: number; enable?: boolean; code?: number; message?: string; msg?: string }
    const code = Number(r.code ?? 0)
    // 1001 = 认证失败（实测：无效 token → code 1001 + enable false）
    if (code !== 0) throw new UpstreamError(code === 1001 ? 'session_dead' : 'soft_rate', 200, `${r.message ?? r.msg ?? 'checkin status failed'} (code=${code})`)
    return { checkedIn: !!r.checked_in, credits: Number(r.credits ?? 0), enable: !!r.enable }
  }

  /** 执行签到。成功与否看**业务 code**而非 HTTP 状态：上游一律 200，
   *  失败藏在 code 里。只看 HTTP 会误报成功——积分没变，用户却看到「签到成功」。
   *
   *  业务码（2026-08-31 实测）：
   *  - 0    = 成功
   *  - 9095 = 今日已签到 → 幂等成功（不是失败）
   *  - 9074 = 「参与用户太多」→ **账号级稳定拒绝，不是抖动**（2026-09-02 订正，
   *           见 CHECKIN_BUSY_CODE 注释：40 余次重试全失败、换 deviceId/token 无效）。
   *           保留一次快速重试（默认 1s）只兜「上游万一恢复成真抖动」，落空即判失败，
   *           不空耗 8s。
   *  - 9090 = 活动暂不可用（另一套 activity/action 体系，本插件不走）
   *  - 1001 = token/会话失效（与 chat 的 401 同义）→ session_dead
   *
   *  判重维度是**账号**不是设备（实测：换新 deviceId 后 checked_in 仍为 true），
   *  所以「已签到」是幂等成功。deviceId 依然要稳定——它参与上游风控画像，
   *  但**不必**为了绕过 9074 去换 id。 */
  async checkinClaim(a: Auth): Promise<'ok' | 'already'> {
    for (let attempt = 0; ; attempt++) {
      const data = await this.doJSON(this.ugHost + SOLO.EpCheckinClaim, ugHeaders(a), {})
      const r = data as { code?: number; message?: string; msg?: string }
      const code = Number(r.code ?? 0)
      if (code === 0) return 'ok'
      if (code === CHECKIN_ALREADY_CODE) return 'already'
      const msg = `${r.message ?? r.msg ?? 'checkin failed'} (code=${code})`
      if (code === CHECKIN_BUSY_CODE && attempt === 0) {
        await this.sleepImpl(this.checkinRetryDelayMs)
        continue
      }
      // 9074 是签到专属拒绝，与 chat 限流无关——报独立分类，不污染限流计数
      const kind = code === CHECKIN_BUSY_CODE ? 'checkin_denied' : code === 1001 ? 'session_dead' : 'soft_rate'
      throw new UpstreamError(kind, 200, msg)
    }
  }

  /** 剩余积分：聚合 (credits_limit - credits_amount)（credits_amount 是已用积分，实测）。 */
  async userEntUsage(a: Auth): Promise<number> {
    const data = await this.doJSON(this.ugHost + SOLO.EpEntUsage, ugHeaders(a), {})
    const list = (data as { user_entitlement_pack_list?: unknown[] })?.user_entitlement_pack_list ?? []
    let remain = 0
    for (const p of list) {
      const pack = p as {
        entitlement_base_info?: { quota?: { credits_limit?: number } }
        usage?: { credits_amount?: number }
      }
      const limit = Number(pack.entitlement_base_info?.quota?.credits_limit ?? 0)
      if (limit <= 0) continue
      const used = Number(pack.usage?.credits_amount ?? 0)
      remain += limit - used
    }
    return remain
  }

  /** 查询账号信息（登录用）。 */
  async getUserInfo(a: Auth): Promise<{ uid: string; nickname: string; enterpriseID: string }> {
    const host = a.apiHost !== '' ? a.apiHost : this.oauthHost
    const resp = await this.fetchImpl(host + SOLO.EpUserInfo, {
      method: 'POST',
      headers: { ...oauthHeaders(), 'X-Cloudide-Token': a.accessToken },
      body: JSON.stringify({ ReqSource: 'IDE', IDEVersion: SOLO.IdeVersion }),
      signal: AbortSignal.timeout(this.timeoutSeconds * 1000),
    })
    const text = await resp.text()
    if (resp.status >= 400) {
      throw new UpstreamError(classify(resp.status, text), resp.status, truncate(text, 200))
    }
    const result = (JSON.parse(text) as { Result?: Record<string, unknown> })?.Result ?? {}
    return {
      uid: String(result.UserID ?? ''),
      nickname: String(result.ScreenName ?? ''),
      enterpriseID: String(result.EnterpriseID ?? ''),
    }
  }
}

// ---------------------------------------------------------------------------
// 行迭代器（SSE body 按行切分）
// ---------------------------------------------------------------------------

/** 把 web ReadableStream 切成按行迭代的异步迭代器。 */
export async function* linesFromStream(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        yield line
      }
    }
    if (buf !== '') yield buf
  } finally {
    reader.releaseLock()
  }
}
