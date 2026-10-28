/**
 * TRAE SOLO 上游客户端：llm_utils_chat / get_detail_param / ExchangeToken /
 * checkin_credits / ide_user_ent_usage + 错误分类 + SSE 转换。
 * 移植自 traework2api/internal/upstream/*（client.go / headers.go / payload.go / solosse.go）。
 */
import { SOLO, CLIENT_UA } from './constants.ts'
import { issuedTooLong, needsRefresh, type Auth } from './auth.ts'
import { randomBytes } from 'node:crypto'

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

/**
 * 签到业务码 9095。
 *
 * 上游 `ug` 族的 NLS 文案是「该设备今日已参与签到」，口径指向**设备**
 * （`x-device-id` 的值）而不是账号。所以它**不能**当「今日已签到 / 幂等成功」：
 * 若它确实按设备判，那么本机名额被另一个账号用掉后，当前账号 claim 会拿到它，
 * 而该账号当天没有任何奖励包——报 already 就把「没领到」说成了「已领到」。
 *
 * **本机未复现**（2026-10-10 实测：已领账号 `checked_in=true` 再 claim 一律回
 * `code 0`，与 deviceId 无关——账号级幂等先行；造不出「账号未领 + 设备名额已用」
 * 那一态）。因此这里只做**防御式**处理，不放宽判定凭据：
 * claim 后始终回查 `checked_in`，只有它说了算；回查为 false 且 code 是 9095 时
 * 报 device_used 而不是 already。这样即使 9095 的真实语义与文案不符，
 * 最坏也只是把一次失败归类得更具体，不会谎报成功。
 */
const CHECKIN_DEVICE_USED_CODE = 9095

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

/**
 * 签到业务码 9004：上游说「提交的订单参数不正确」——实测口径指向**设备身份**
 * （`x-device-id` 缺失或不被接受）。
 *
 * 2026-09-24 实测（与 dsh-connect-trae 的独立结论一致）：claim 不带设备头时上游
 * 一律 9004。本插件的设备头**正常不会缺**（老凭证会在装载时补一个 16 位数字
 * deviceId，见 index.ts），所以 9004 落到这里实际意味着「本机设备身份没被上游
 * 接受」。它既不是「今日已签」也不是限流，报成 soft_rate 会让用户以为账号被限、
 * 去换号重试；真正该做的是刷新设备身份（重新登录）。故单独分类 device_missing，
 * 不重试（重试只会再拿一次 9004）。
 */
const CHECKIN_DEVICE_HEADER_MISSING_CODE = 9004

/**
 * 主动刷新上限：accessToken 距**签发**超过这么久就刷新轮换，不等到临到期。
 *
 * 为什么需要（对齐 codebuddy 2026-09-16 的修法）：上游可服务端吊销旧凭据
 * （JWT 远未过期仍 401、refresh 报会话不存在——codebuddy 2026-06 批实测）。
 * TRAE token 有效期实测 14 天，靠临到期判的签发龄天然 ≤14 天，风险敞口比
 * codebuddy 的一年期 JWT 小；但 refreshToken 轮换链在长期不用时可能悄悄断掉，
 * 15 天主动轮换让断链尽早暴露（刷新失败立刻报 session_dead，而不是拖到真过期）。
 * 取 15 天略大于 14 天有效期 = 每次临到期自然刷新后签发龄归零，本常量主要
 * 兜「自然刷新没发生」的场景。
 */
const REFRESH_MAX_ISSUED_MS = 15 * 24 * 3600_000

/**
 * ide_user_ent_usage 的请求体（2026-09-03 抓包实测）。
 * 真实客户端就发这两个字段；发空对象 `{}` 拿到的 usage 不完整。
 */
const ENT_USAGE_BODY = { require_usage: true, req_source: 2 } as const

/** 过期判定：end_time/expire_time 为 Unix 秒，缺失或 0 视作不过期。 */
function hasExpired(endTime: number | undefined, nowSec: number): boolean {
  const t = Number(endTime ?? 0)
  return t > 0 && t <= nowSec
}

/**
 * 上游「自定义模型」config_name 前缀：这类是用户在 TRAE 云端挂的第三方
 * 代理（base_url 指向别处），不属于本供应商配额，发过去就在流里报 4023。
 * 上游的 is_custom_model 标志不可靠（实测全为 false），只能靠前缀兜底。
 */
const CUSTOM_MODEL_PREFIX = 'custom_model_'

/**
 * 内部调度模型：不产出对话内容，发出去只能拿到空响应（2026-09-03 逐个实测：
 * browser_use_subagent 全程零 output 帧、completion_tokens=0）。
 *
 * **不能**用上游的 is_invisible_to_user 当过滤条件——实测它把 glm-5 /
 * glm-5-turbo / seed-code-pro-0430 / Doubao-Seed-2.0-Code 也标成 true，
 * 而这四个都能正常对话，照它过滤会静默砍掉 4 个可用模型。
 */
const NON_CHAT_MODELS = new Set(['browser_use_subagent'])

/**
 * 一行详细表条目能否进 roster（远端名录的 join 目标）。
 *
 * 自定义模型（用户在 TRAE 云端挂的第三方代理，base_url 指向别处）不属于本
 * 供应商配额，发过去就在流里报 4023——前缀兜底不能省：2026-09-03 实测上游对
 * 11 个 `custom_model_*` 全部返回 is_custom_model=false，只认标志等于没过滤。
 */
function isRosterCandidate(id: string, isCustom: boolean | undefined): boolean {
  if (isCustom === true) return false
  if (id.startsWith(CUSTOM_MODEL_PREFIX)) return false
  return !NON_CHAT_MODELS.has(id)
}

/** 正数才采纳（0 / undefined / NaN 都当作「上游没给」）。 */
function positiveNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * 上游 `context_window_tokens` → 取**更宽**的那个档。
 *
 * 只读 `dev` 会把窗口低估到实际上限的几分之一（issue #11）。2026-10-14 实测：
 * 同一个 `mimo-v2.6-pro`，`solo_work_lite` 只给 `{dev:200000}`，而 `chat_v3`
 * 给 `{dev:200000, max:981504}`；`step-5-preview` 更极端（`dev:116000`,
 * `max:1000000`）。核心按最小窗口判组合可用性，低估的后果是长会话被提前判超限。
 *
 * 两个档都**可能缺**（`solo_coder` 的 `DeepSeek-V4-Pro` 只有 `dev`；
 * `solo_work_lite` 的 `DeepSeek-V4-Pro` 没有 `max`），所以各自先过
 * positiveNumber，不能用 `??` 兜底。
 */
function widestWindow(tokens: { dev?: number; max?: number } | undefined): number {
  return Math.max(positiveNumber(tokens?.dev), positiveNumber(tokens?.max))
}

/** 显示名归一化，用于 config_name 与远端名录的跨源 join。 */
function displayKey(name: string): string {
  return name.trim().toLowerCase()
}

/** 上游模型表的一行：config_name + 归属 function + 窗口。 */
export interface SoloModelEntry {
  id: string
  name: string
  /**
   * 列出该 config_name 的 function——**chat 必须回放它**，发错时上游 HTTP 200
   * 但流内 `code=4001`（2026-10-10 实测 7 个模型如此）。
   */
  function: string
  /** 上下文窗口（token），来自上游；拿不到为 0。 */
  contextWindow: number
  /** 单次最大输出（token），拿不到为 0。 */
  maxTokens: number
}

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
  // 额度类业务码（1005/4008）有可能裹在非 2xx 的响应体里，这里与流内共用
  // 同一张判定表，避免两条路径对一个码给出两种语义。
  for (const c of PLAN_LIMIT_CODES) {
    if (body.includes(`"code":${c}`)) return 'plan_limit'
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

/** 生成 uuid-v4 形标识（8-4-4-4-12）。 */
function genUuid(): string {
  const b = randomBytes(16)
  b[6] = (b[6] ?? 0) & 0x0f | 0x40
  b[8] = (b[8] ?? 0) & 0x3f | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** 生成 tt-trace-id（格式 00-32hex-16hex-01，与真实客户端一致）。 */
function genTTTraceId(requestId: string): string {
  const trace = randomBytes(16).toString('hex')
  const span = requestId.replace(/-/g, '').slice(0, 16)
  return `00-${trace}-${span}-01`
}

/**
 * UgHeaders：签到/积分（api.trae.cn）所需头。
 * 逐头对齐 2026-09-03 抓包的**成功**签到请求（trae-capture/parsed_flows.jsonl）。
 *
 * 伪装身份必须是 VSCode 插件进程，不是 IDE 主进程——这两条链路的 UA 不同
 * （实测：llm_utils_chat 走 TraeClient/TTNet，签到/积分走
 * `VSCode 1.107.1 (TRAE SOLO CN)`）。用 CLIENT_UA(`Trae/0.1.61`) 属于
 * 第三套不存在的身份，风控画像直接对不上。
 */
export function ugHeaders(a: Auth): Record<string, string> {
  const requestId = genUuid()
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: '*/*', // 实测值；不是 application/json
    'User-Agent': SOLO.UgUserAgent,
    Authorization: `Cloud-IDE-JWT ${a.accessToken}`,
    'X-User-Region': 'CN',
    'Accept-Language': 'zh-CN',
    'Package-Type': 'stable_cn',
    'X-Lgw-Req-Sdk-Type': '3',
    'X-Market-Client-Id': SOLO.MarketClientId, // 'VSCode 1.107.1'（不含 CN 后缀）
    'X-Device-Brand': SOLO.DeviceBrand,
    'X-Device-Type': 'windows',
    'X-OS-Version': SOLO.OSVersion,
    'App-Version': SOLO.IdeVersion,
    'X-Request-Id': requestId,
    'X-TT-Trace-Id': genTTTraceId(requestId),
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'no-cors', // 实测值；不是 cors
    'Sec-Fetch-Site': 'none',
  }
  if (a.deviceId !== '') h['X-Device-Id'] = a.deviceId
  if (a.marketUserId) h['X-Market-User-Id'] = a.marketUserId
  return h
}

/** deviceId 是否是真实客户端形态（15~16 位纯数字）。hex32 是历史遗留，见 login.ts。 */
export function isRealDeviceId(id: string): boolean {
  return /^\d{15,16}$/.test(id)
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

/**
 * OpenAI → SOLO 单 pass 改写；无法解析时原样返回。
 *
 * `functionName` 是**模型自己的归属 function**（来自 get_detail_param 的查询
 * 来源，见 fetchModels）。上游把可调用名录按 function 拆开，一个模型只有用
 * 列出它的那个 function 才调得动——发错时 HTTP 200 但流内 `code=4001`。
 * 不传则用历史默认值。
 */
export function prepareBody(src: string, functionName: string = SOLO.Function): string {
  if (src === '') return src
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(src) as Record<string, unknown>
  } catch {
    return src
  }
  obj.stream = true
  obj.function = functionName

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

/**
 * 流内业务码 → 语义分类。
 *
 * 只认 `1005` 是历史遗留，实测不够：TRAE 对「该账号没这个模型的配额」发
 * **HTTP 200 + 流内 code=4008**（`Your requests have exceeded the quota`）
 * ——2026-09-08 实测三个号里两个如此（其中一个面板还有 200 积分，说明这个
 * 配额与积分余额是两回事）。把它归进 `'client'` 就等于判成「客户端参数错」，
 * 核心按 `unknown` 只冷 30s，坏号转头又被选中。
 */
export class SoloStreamError extends Error {
  code: number
  constructor(code: number, msg: string) {
    super(`solo error code=${code} msg=${msg}`)
    this.code = code
  }
  kind(): ErrKind {
    return streamCodeKind(this.code)
  }
}

/** 流内业务码集合 → 分类（HTTP 层 classify 与流内 kind() 共用同一张表）。 */
const PLAN_LIMIT_CODES = new Set([1005, 4008])

function streamCodeKind(code: number): ErrKind {
  return PLAN_LIMIT_CODES.has(code) ? 'plan_limit' : 'client'
}

function mergeToolCallDelta(merged: Record<string, unknown>, delta: Record<string, unknown>): void {
  if (typeof delta.id === 'string' && delta.id !== '') merged.id = delta.id
  if (typeof delta.type === 'string' && delta.type !== '') merged.type = delta.type
  let df = delta.function as Record<string, unknown> | undefined
  if (df === null || typeof df !== 'object') df = delta.function_call as Record<string, unknown> | undefined
  // 顶层 name/arguments/params/input/tool_name 形态（与流式 normalizeToolCalls 同源）
  if (df === null || typeof df !== 'object') {
    const topName = delta.name ?? delta.tool_name
    const topArgs = delta.arguments ?? delta.params ?? delta.input
    if (typeof topName !== 'string' && topArgs === undefined) return
    df = {}
    if (typeof topName === 'string' && topName !== '') df.name = topName
    if (topArgs !== undefined) df.arguments = topArgs
  }
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
  /** 远端模型目录 host（只读名录；测试注入）。 */
  remoteHost?: string
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
  private remoteHost: string
  private timeoutSeconds: number
  private fetchImpl: typeof fetch
  private checkinRetryDelayMs: number
  private sleepImpl: (ms: number) => Promise<void>

  constructor(opts: SoloClientOptions = {}) {
    this.agentHost = opts.agentHost ?? SOLO.AgentHost
    this.ugHost = opts.ugHost ?? SOLO.UgHost
    this.oauthHost = opts.oauthHost ?? SOLO.OAuthHost
    this.remoteHost = opts.remoteHost ?? SOLO.RemoteHost
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

  /**
   * 触发刷新：临到期（skewMs 内过期）**或**签发超过 REFRESH_MAX_ISSUED_MS
   * （主动轮换保新鲜，见 auth.ts issuedTooLong 注释）。任一满足即刷。
   */
  async refreshTokenIfNeeded(a: Auth, skewMs: number): Promise<boolean> {
    if (!needsRefresh(a, skewMs) && !issuedTooLong(a.accessToken, REFRESH_MAX_ISSUED_MS)) return false
    await this.refreshToken(a)
    return true
  }

  /**
   * 发 llm_utils_chat 请求并返回原始 SSE body 流（调用方负责 Close）。
   * 非 2xx 时 body 为 null、返回上游状态与响应体；只有传输层失败才抛错。
   *
   * `functionName` 必须是**该模型自己的归属 function**（见 fetchModels）：
   * 发错时上游 HTTP 200 但流内 `code=4001`，看起来像「参数无效」而实际是
   * 「这个 function 不服务这个模型」。
   */
  async chatStream(a: Auth, body: string, functionName?: string): Promise<{
    body: ReadableStream<Uint8Array> | null
    status: number
    respBody: string
  }> {
    let resp: Response
    try {
      resp = await this.fetchImpl(this.agentHost + SOLO.EpChat, {
        method: 'POST',
        headers: soloHeaders(a, true),
        body: prepareBody(body, functionName),
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
  async fetchModels(a: Auth): Promise<SoloModelEntry[]> {
    // 两件事并行：远端名录（用户可见的骨架）+ 各 function 的详细表（给 config_name
    // 补归属 function 与窗口）。两者是不同 host，并行取总耗时 ≈ max(两者)。
    const [remote, perFunction] = await Promise.all([
      this.remoteModels(a),
      Promise.all(SOLO.DirectoryFunctions.map((fn) => this.detailModels(a, fn))),
    ])

    // 归属表：按 DirectoryFunctions 顺序**先命中者拥有**该 config_name。
    // 顺序即优先级——不是随手排的，见 constants.ts 的 DirectoryFunctions 注释。
    const wire = new Map<string, { fn: string; contextWindow: number; maxTokens: number; name: string }>()
    const wireByName = new Map<string, string>()
    for (const { fn, list } of perFunction) {
      for (const cfg of list) {
        const c = cfg as {
          config_name?: string
          context_window_tokens?: { dev?: number; max?: number }
          model_detail_list?: Array<{ max_tokens?: number }>
          display_config?: { display_name?: string; is_custom_model?: boolean }
        }
        const id = c.config_name
        if (id === undefined || id === '' || !isRosterCandidate(id, c.display_config?.is_custom_model)) continue
        const contextWindow = widestWindow(c.context_window_tokens)
        const maxTokens = positiveNumber(c.model_detail_list?.[0]?.max_tokens)
        const name = c.display_config?.display_name ?? ''
        const prev = wire.get(id)
        if (prev !== undefined) {
          // 归属 function 仍是**先命中者**（顺序即优先级，见 constants.ts），
          // 但窗口要取跨 function 的**更宽者**：宽的那个才是模型真实上限，
          // 窄的只是该 function 自己暴露的档位。以前这里直接 `continue`，
          // 于是先命中者报 200K、后命中者报 1000K 时窗口被锁死在 200K。
          if (contextWindow > prev.contextWindow) prev.contextWindow = contextWindow
          if (prev.maxTokens === 0 && maxTokens > 0) prev.maxTokens = maxTokens
          continue
        }
        wire.set(id, { fn, contextWindow, maxTokens, name })
        const key = displayKey(name)
        if (key !== '' && !wireByName.has(key)) wireByName.set(key, id)
      }
    }

    const out: SoloModelEntry[] = []
    const seen = new Set<string>()
    const push = (e: SoloModelEntry): void => {
      if (seen.has(e.id)) return
      seen.add(e.id)
      out.push(e)
    }
    if (remote.length > 0) {
      // 远端的每一行都是厂商愿意给用户看的模型（Trae IDE 的模型选择器读它），
      // 作为骨架：顺序按厂商的，窗口取 dev/max 里更宽的那个。
      for (const m of remote) {
        const id = wire.has(m.id) ? m.id : wireByName.get(displayKey(m.displayName))
        if (id === undefined) continue
        const w = wire.get(id)
        if (w === undefined) continue
        push({
          id,
          name: m.displayName !== '' ? m.displayName : w.name,
          function: w.fn,
          // 取**更宽**者：远端名录与详细表是两个来源、两套档位，谁报得宽谁更接近
          // 真实上限。以前是「远端有值就一律用远端」，远端只报 dev 时同样低估。
          contextWindow: Math.max(m.contextWindow, w.contextWindow),
          maxTokens: w.maxTokens,
        })
      }
      // **再并上主 function 那一家独有的行**（即本插件改动前的 roster）。
      // 为什么不只发远端名录：那种做法会**静默删掉**今天还能用的模型
      // （2026-10-10 实测 `glm-5-turbo` / `seed-code-pro-0430` / `aquila` /
      // `sagitta` / `summary` / `explore_sub_agent_v2` 都真能出内容，但不在
      // 远端名录里）。从用户的模型选择器里拿掉能用的东西不是优化，所以这里
      // 只做**纯增量**：远端给什么就给什么，主 function 原有的一个不少。
      // 其它 function 独有的内部件（title_generation / fast_apply / *-auto …）
      // 仍然不进——它们不在远端名录、也不在主 function 表里。
      // 天花板：若哪天想严格对齐 IDE 名录，把这一段删掉即可（一行级改动）。
      for (const [id, w] of wire) {
        if (w.fn !== SOLO.Function) continue
        push({ id, name: w.name, function: w.fn, contextWindow: w.contextWindow, maxTokens: w.maxTokens })
      }
    } else {
      // 远端名录拿不到时退回**主 function 一家的表**（即本插件的历史行为），
      // 而不是把详细表并集原样端出去——并集里有一半是其它 function 独有的
      // 内部件（-auto 变体、title_generation、fast_apply…），宁可少列也不把
      // 垃圾灌进模型选择器。
      for (const [id, w] of wire) {
        if (w.fn !== SOLO.Function) continue
        push({ id, name: w.name, function: w.fn, contextWindow: w.contextWindow, maxTokens: w.maxTokens })
      }
    }
    if (out.length === 0) throw new Error('models api returned empty list')
    return out
  }

  /** 一个 function 的详细表；单独失败不影响其它 function。 */
  private async detailModels(a: Auth, fn: string): Promise<{ fn: string; list: unknown[] }> {
    try {
      const data = await this.doJSON(this.agentHost + SOLO.EpModels, soloHeaders(a, false), {
        function: fn,
        config_names: null,
        need_prompt: false,
        current_config_info: null,
        poly_prompt: true,
        mode_type: null,
        agent_type: null,
      })
      const list = (data as { config_info_list?: unknown[] })?.config_info_list
      return { fn, list: Array.isArray(list) ? list : [] }
    } catch {
      return { fn, list: [] }
    }
  }

  /**
   * 远端模型目录（按 function 分组，同一模型会在多组重复）。**只读**，
   * 失败返回空数组由调用方回退——它不是本插件的主链路。
   */
  private async remoteModels(a: Auth): Promise<Array<{ id: string; displayName: string; contextWindow: number }>> {
    try {
      const url = `${this.remoteHost}${SOLO.EpRemoteModels}?functions=${encodeURIComponent(SOLO.DirectoryFunctions.join(','))}`
      const resp = await this.fetchImpl(url, {
        headers: {
          Authorization: `Cloud-IDE-JWT ${a.accessToken}`,
          'Content-Type': 'application/json',
          'x-trae-client-type': 'web',
          'x-trae-user-timezone': 'Asia/Shanghai',
          'x-preferenced-language': 'zh-cn',
          Referer: `${SOLO.RemoteHost}/`,
          'User-Agent': 'Mozilla/5.0',
        },
        signal: AbortSignal.timeout(this.timeoutSeconds * 1000),
      })
      if (!resp.ok) return []
      const json = (await resp.json()) as { data?: { list?: Array<{ models?: unknown[] }> } }
      // 同一模型出现在多个组里，各组的窗口可能不一致 ⇒ 取**最大**的，
      // 让同一个模型在面板上的窗口不随上游分组顺序变化（顺序实测不稳定）。
      const byId = new Map<string, { id: string; displayName: string; contextWindow: number }>()
      for (const group of json.data?.list ?? []) {
        for (const raw of group.models ?? []) {
          const m = raw as { name?: string; display_name?: string; context_window_tokens?: { dev?: number; max?: number } }
          const id = m.name
          if (id === undefined || id === '') continue
          const window = widestWindow(m.context_window_tokens)
          const prev = byId.get(id)
          byId.set(id, {
            id,
            displayName: m.display_name ?? prev?.displayName ?? '',
            contextWindow: Math.max(window, prev?.contextWindow ?? 0),
          })
        }
      }
      return [...byId.values()]
    } catch {
      return []
    }
  }

  /**
   * 查询签到状态。业务 code 非 0 也报错——上游一律 200，成败只在 code 里。
   *
   * 两个布尔字段的**判定维度不同**（2026-10-10 实测复核，此前 README 记反了）：
   *  - `checked_in` 按**账号**：该账号今天的签到奖励包已到账。换 deviceId 读数不变。
   *  - `did_checked_in` 按**设备**（就是 `x-device-id` 这个头的值）：这台机器今天
   *    的名额已用掉，**不区分是哪个账号用的**。同一账号带本机真实号读是 true、
   *    带另一个号读是 false，重复读不会自己变 true（只有真 claim 才置位）。
   *
   * 两者组合出的关键一态：`!checked_in && did_checked_in` = 本机名额已用、而
   * 这个账号今天什么都没领到——此时 claim 被拒（本机未复现其 code，见
   * CHECKIN_DEVICE_USED_CODE）。判定成败始终只认 checked_in。
   */
  async checkinStatus(a: Auth): Promise<{ checkedIn: boolean; didCheckedIn: boolean; credits: number; enable: boolean }> {
    const data = await this.doJSON(this.ugHost + SOLO.EpCheckinStatus, ugHeaders(a), {})
    const r = data as { checked_in?: boolean; did_checked_in?: boolean; credits?: number; enable?: boolean; code?: number; message?: string; msg?: string }
    const code = Number(r.code ?? 0)
    // 1001 = 认证失败（实测：无效 token → code 1001 + enable false）
    if (code !== 0) throw new UpstreamError(code === 1001 ? 'session_dead' : 'soft_rate', 200, `${r.message ?? r.msg ?? 'checkin status failed'} (code=${code})`)
    return {
      checkedIn: !!r.checked_in,
      didCheckedIn: !!r.did_checked_in,
      credits: Number(r.credits ?? 0),
      // enable 缺省按**开放**处理：上游省略该字段时（旧版本/灰度），`!!undefined`
      // 会把「活动正常」读成「今日未开放」，于是唯一该发的那次 claim 被自己拦下。
      // 只有明确的 false 才算关闭——少签一次的代价远大于多问一次上游。
      enable: r.enable !== false,
    }
  }

  /** 执行签到。成功与否看**业务 code**而非 HTTP 状态：上游一律 200，
   *  失败藏在 code 里。只看 HTTP 会误报成功——积分没变，用户却看到「签到成功」。
   *
   *  业务码（2026-08-31 实测；9095 见 CHECKIN_DEVICE_USED_CODE 的证据分级）：
   *  - 0    = 成功
   *  - 9095 = 上游文案是「该设备今日已参与签到」，口径指向**设备**。按防御式
   *           处理返回 'device_used'，**不当**幂等成功：若它确实按设备判，本机
   *           名额被别的账号用掉时当前账号就会拿到它，而该账号当天没有奖励包。
   *           报 already 会把「没领到」说成「已领到」——这是这里唯一不能犯的错。
   *           调用方仍以回查 `checked_in` 为唯一凭据（见 checkinNow）。
   *  - 9074 = 「参与用户太多」→ **账号级稳定拒绝，不是抖动**（2026-09-02 订正，
   *           见 CHECKIN_BUSY_CODE 注释：40 余次重试全失败、换 deviceId/token 无效）。
   *           保留一次快速重试（默认 1s）只兜「上游万一恢复成真抖动」，落空即判失败，
   *           不空耗 8s。
   *  - 9004 = 缺 `x-device-id`（见 CHECKIN_DEVICE_HEADER_MISSING_CODE）→
   *           'device_missing'，调用方据此提示重新登录，而不是当限流。
   *  - 9090 = 活动暂不可用（另一套 activity/action 体系，本插件不走）
   *  - 1001 = token/会话失效（与 chat 的 401 同义）→ session_dead
   *
   *  deviceId 依然要稳定——它参与上游风控画像，但**不必**为了绕过 9074 去换 id。 */
  async checkinClaim(a: Auth): Promise<'ok' | 'device_used' | 'device_missing'> {
    for (let attempt = 0; ; attempt++) {
      const data = await this.doJSON(this.ugHost + SOLO.EpCheckinClaim, ugHeaders(a), {})
      const r = data as { code?: number; message?: string; msg?: string }
      const code = Number(r.code ?? 0)
      const raw = r.message ?? r.msg ?? ''
      if (code === 0) return 'ok'
      if (code === CHECKIN_DEVICE_USED_CODE) return 'device_used'
      if (code === CHECKIN_DEVICE_HEADER_MISSING_CODE) {
        // 重试只会再拿一次 9004：缺的不是运气，是请求参数。
        return 'device_missing'
      }
      if (code === CHECKIN_BUSY_CODE && attempt === 0) {
        await this.sleepImpl(this.checkinRetryDelayMs)
        continue
      }
      if (code === CHECKIN_BUSY_CODE) {
        // 9074 是签到专属拒绝（账号级稳定拒绝，与 chat 限流无关），报独立分类，
        // 不污染限流计数；文案要能直接给用户看——上游原文「当前参与用户太多」
        // 单独抛出时，面板看起来像本插件坏了。
        throw new UpstreamError(
          'checkin_denied',
          200,
          `上游拒绝发放签到奖励（code=9074${raw === '' ? '' : `：${raw}`}）：该账号今天领不到，已自动重试一次仍失败，稍后再试；这不是限流，换设备或换 token 都无效`,
        )
      }
      const kind = code === 1001 ? 'session_dead' : 'soft_rate'
      throw new UpstreamError(kind, 200, `${raw === '' ? 'checkin failed' : raw} (code=${code})`)
    }
  }

  /**
   * 剩余积分：聚合**未过期**包的 (credits_limit - credits_amount)。
   *
   * 请求体必须带 require_usage/req_source（2026-09-03 抓包实测真实客户端发的是
   * `{"require_usage":true,"req_source":2}`，不是 `{}`）。
   *
   * 过期包必须跳过：签到积分是**当日发放、31 天后过期**的独立包
   * （实测 entitlement_id 形如 checkin_20260902_<uid>，每个包各 200 额度）。
   * 不过滤就是把历史上所有签到包的额度都算进「剩余」，面板越签越多、永远
   * 用不完，且掩盖真实余额。end_time/expire_time 缺失时按「不过期」保留。
   */
  async userEntUsage(a: Auth): Promise<number> {
    const data = await this.doJSON(this.ugHost + SOLO.EpEntUsage, ugHeaders(a), ENT_USAGE_BODY)
    const list = (data as { user_entitlement_pack_list?: unknown[] })?.user_entitlement_pack_list ?? []
    const nowSec = Math.floor(Date.now() / 1000)
    let remain = 0
    for (const p of list) {
      const pack = p as {
        entitlement_base_info?: { quota?: { credits_limit?: number }; end_time?: number }
        expire_time?: number
        usage?: { credits_amount?: number }
      }
      const limit = Number(pack.entitlement_base_info?.quota?.credits_limit ?? 0)
      if (limit <= 0) continue
      if (hasExpired(pack.entitlement_base_info?.end_time ?? pack.expire_time, nowSec)) continue
      const used = Number(pack.usage?.credits_amount ?? 0)
      remain += Math.max(0, limit - used)
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
