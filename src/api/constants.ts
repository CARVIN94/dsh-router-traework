/**
 * TRAE SOLO 上游技术常量（SPEC §1，来自实测，禁止改动）。
 * 移植自 traework2api/internal/upstream/constants.go。
 */
import { join } from 'node:path'

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
  /** 默认 function：拿不到模型自己的归属时用它（也是历史行为，保持不变）。 */
  Function: 'solo_work_lite',
  /**
   * 查模型表时要问的 function 列表，**顺序 = 归属优先级**（先命中的 function
   * 拥有该 config_name，chat 时按它回放）。
   *
   * 上游把可调用名录**按 function 拆开**（SOLO 各模式各一张表），而一个模型
   * 只有用**列出它的那个 function** 才调得动：2026-10-10 实测，只发
   * `solo_work_lite` 时 `glm-5.1` / `qwen-3.5` / `kimi-k2.5` / `minimax-m2.7` /
   * `qwen-3.6-plus` / `glm-5v-turbo` / `Doubao-Seed-Code` 全部 HTTP 200 但流内
   * `code=4001`（参数无效），换成各自归属的 function 立刻正常出内容。
   *
   * 现行 Function 排第一：它已经验证可用，放首位让既有模型的归属不发生变动。
   */
  DirectoryFunctions: [
    'solo_work_lite',
    'solo_work_remote',
    'solo_agent_remote',
    'chat_v3',
    'solo_coder',
    'builder_v3',
  ],
  /**
   * 远端模型目录（Trae IDE 模型选择器读的就是它）：按 function 分组返回
   * **厂商自己给用户看的**名录。实测 2026-10-10：它 32 个模型与「详细表并集」
   * 的交集正是这 32 个，而详细表并集另有 32 个内部件
   * （title_generation / fast_apply / search_agent_* / *-auto …）不对用户展示。
   * 所以以它为**骨架**、详细表只用来补 config_name / function / 窗口。
   */
  RemoteHost: 'https://solo.trae.cn',
  EpRemoteModels: '/api/remote/v1/models',
  /**
   * 签到/积分（api.trae.cn）走的是 **VSCode 插件进程**，UA 与 IDE 主进程的
   * `Trae/0.1.61`(CLIENT_UA)、`TraeClient/TTNet` 都不同（2026-09-03 抓包实测）。
   * 三者混用 = 同一账号出现三套客户端身份，风控画像对不上。
   */
  UgUserAgent: 'VSCode 1.107.1 (TRAE SOLO CN)',
  /** X-Market-Client-Id 与 UA 同源但**不带 CN 后缀**（实测值）。 */
  MarketClientId: 'VSCode 1.107.1',

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
  timeoutSeconds: number
  /** 覆盖上游 host（测试用）。 */
  agentHost?: string
  ugHost?: string
  oauthHost?: string
}

/**
 * 默认配置（对应 traework2api cmd/server/config.go）。
 *
 * `dataDir` 是 dsh-router 核心注入的**绝对**数据目录（`~/.dsh/profiles/<name>/data`）。
 * 以前这里写死相对路径 `data/state.json`，落盘位置跟着进程 cwd 跑——从别的目录
 * 启动 `dsh web` 就静默换一套空数据。必须从核心拿，不要自己拼。
 */
export function defaultConfig(dataDir = ''): TraewConfig {
  const env = process.env
  const num = (v: string | undefined, d: number): number => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : d
  }
  return {
    authDir: dataDir !== '' ? join(dataDir, 'auths') : 'auths',
    stateFile: dataDir !== '' ? join(dataDir, 'state.json') : 'data/state.json',
    apiKey: env.TW2A_API_KEY ?? '',
    defaultModel: env.TW2A_DEFAULT_MODEL ?? DEFAULT_CONFIG_NAME,
    planCooldownMs: 12 * 3600_000,
    softCooldownMs: 60_000,
    errThreshold: num(env.TW2A_ERR_THRESHOLD, 3),
    errCooldownMs: 10 * 60_000,
    refreshSkewMs: 24 * 3600_000,
    timeoutSeconds: num(env.TW2A_TIMEOUT_SECONDS, 120),
    agentHost: env.TW2A_SOLO_AGENT_HOST,
    ugHost: env.TW2A_SOLO_UG_HOST,
    oauthHost: env.TW2A_SOLO_OAUTH_HOST,
  }
}
