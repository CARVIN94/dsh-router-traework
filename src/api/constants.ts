/**
 * TRAE SOLO 上游技术常量（SPEC §1，来自实测，禁止改动）。
 * 移植自 traework2api/internal/upstream/constants.go。
 */

export const SOLO = {
  AgentHost: 'https://trae-api-cn.mchost.guru',
  UgHost: 'https://api.trae.cn',
  OAuthHost: 'https://api.trae.com.cn',
  ConsoleHost: 'https://www.trae.cn',
  ClientID: 'en1oxy7wnw8j9n', // SOLO stable
  AppID: '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
  // 版本码**决定上游返回哪张模型配置表**，比 IdeVersion 更关键（2026-09-03
  // 实测）：X-Ide-Version 用 0.1.43 还是 0.1.61 都不影响结果，
  // 但 version-code=20260716 → 35 个模型、无 glm-5.3；20260820 → 36 个、含
  // glm-5.3。更糟的是拿 20260716 直接调 glm-5.3：上游 HTTP 200 但流里回
  // `event:error code=4001`（参数无效）——列表和实际可用性是同一张表。
  // 真实客户端 0.1.61 发的就是 20260820（抓包实证）。
  IdeVersion: '0.1.61',
  IdeVersionCode: '20260820',
  DeviceBrand: '83DG',
  OSVersion: 'Windows 11 Pro',
  Function: 'solo_work_lite',

  // 端点
  EpChat: '/api/agent/v3/llm_utils_chat',
  EpModels: '/api/ide/v1/get_detail_param',
  EpExchange: '/cloudide/api/v3/trae/oauth/ExchangeToken',
  EpUserInfo: '/cloudide/api/v3/trae/GetUserInfo',
  EpCheckinStatus: '/trae/api/v2/ug/checkin_credits/status',
  EpCheckinClaim: '/trae/api/v2/ug/checkin_credits/claim',
  EpEntUsage: '/trae/api/v2/pay/ide_user_ent_usage',
} as const

export const CLIENT_UA = `Trae/${SOLO.IdeVersion}`

/** 默认模型（实测可用）。 */
export const DEFAULT_CONFIG_NAME = 'glm-5.2'

/** 默认配置（对应 traework2api cmd/server/config.go）。 */
export interface TraewConfig {
  authDir: string
  stateFile: string
  apiKey: string
  defaultModel: string
  planCooldownMs: number
  softCooldownMs: number
  errThreshold: number
  errCooldownMs: number
  refreshSkewMs: number
  checkinHour: number
  refreshHours: number[]
  timeoutSeconds: number
  /** 覆盖上游 host（测试用）。 */
  agentHost?: string
  ugHost?: string
  oauthHost?: string
}

export function defaultConfig(env: NodeJS.ProcessEnv = process.env): TraewConfig {
  const num = (v: string | undefined, d: number): number => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : d
  }
  const refreshHours = (env.TW2A_REFRESH_HOURS ?? '3')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 23)
  return {
    authDir: env.TW2A_AUTH_DIR ?? 'auths',
    stateFile: env.TW2A_STATE_FILE ?? 'data/state.json',
    apiKey: env.TW2A_API_KEY ?? '',
    defaultModel: env.TW2A_DEFAULT_MODEL ?? DEFAULT_CONFIG_NAME,
    planCooldownMs: 12 * 3600_000,
    softCooldownMs: 60_000,
    errThreshold: num(env.TW2A_ERR_THRESHOLD, 3),
    errCooldownMs: 10 * 60_000,
    refreshSkewMs: 24 * 3600_000,
    checkinHour: num(env.TW2A_CHECKIN_HOUR, 9),
    refreshHours: refreshHours.length > 0 ? refreshHours : [3],
    timeoutSeconds: num(env.TW2A_TIMEOUT_SECONDS, 120),
    agentHost: env.TW2A_SOLO_AGENT_HOST,
    ugHost: env.TW2A_SOLO_UG_HOST,
    oauthHost: env.TW2A_SOLO_OAUTH_HOST,
  }
}
