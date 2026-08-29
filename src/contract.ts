/**
 * 供应商契约 —— dsh-router-traework 自含（不依赖 dsh-router 包）。
 * 与 dsh-router 的 suppliers/contract.ts 契约保持同步：
 * 通用能力（连接池/模型管理/别名/签到规则/凭证）由 dsh-router 核心统一管，
 * 本插件只提供**差异化能力**。
 */
import type { ChatRequest, ModelInfo } from './types.ts'

/** 通用配置存储（dsh-router 核心注入；连接池/模型管理/别名）。 */
export interface SupplierConfigStoreLike {
  get(id: string): {
    alias: string
    disabled: string[]
    custom: string[]
    poolOrder: string[]
    poolStrategy: 'fallback' | 'round-robin'
  }
  setAlias(id: string, alias: string): void
  setPoolOrder(id: string, uids: string[]): void
  setPoolStrategy(id: string, strategy: string): void
  setModelEnabled(id: string, modelId: string, enabled: boolean): void
  addCustomModel(id: string, modelId: string): void
  removeCustomModel(id: string, modelId: string): void
  setAllModelsEnabled(id: string, enabled: boolean, modelIds: string[]): void
}

/** 通用凭证存储（dsh-router 核心注入；不透明凭证 blob）。 */
export interface CredentialStoreLike {
  list(supplierId: string): string[]
  get<T = unknown>(supplierId: string, uid: string): T | undefined
  save(supplierId: string, uid: string, blob: unknown): void
  remove(supplierId: string, uid: string): void
}

/**
 * 账户此刻的状态 —— 插件**解读**上游信号后的语义状态。
 * 插件只报「现在怎么了」，不说「该怎么办」：冷却多久、是否禁用、要不要换号
 * 都是核心的策略。
 */
export type AccountState =
  | 'ok'            // 正常
  | 'rate_limit'    // 限流（429 类）
  | 'quota'         // 额度/权益不足
  | 'session_dead'  // 凭证彻底失效，必须重新登录才能恢复
  | 'unavailable'   // 上游不可用（404 / 服务下线）
  | 'transport'     // 网络/连接层失败（没拿到 HTTP 状态）
  | 'unknown'       // 说不清是什么错
  /** 这个模型不属于本供应商（不是账号的失败）。核心据此跳过整个供应商换下一个，
   *  而不是记在账号头上——否则组合里每有一个别人家的模型，就会给无关账号攒
   *  一次错误，攒够阈值把它冷却掉。 */
  | 'no_such_model'

/** 账号「现在状态」（插件只报它观察到的部分）。 */
export interface SupplierAccountNow {
  uid: string
  nickname?: string
  credits: number
  state: AccountState
  message?: string
}

/** 插件报的供应商状态。 */
export interface SupplierStatusNow {
  id: string
  name: string
  accounts: SupplierAccountNow[]
}

/** 一次上游调用的结果。 */
export type ChatOnceResult =
  /** 流式：插件已把上游协议转成 OpenAI SSE，核心只负责 pipe 到 res。 */
  | { ok: true; stream: ReadableStream<Uint8Array> }
  /** 非流式：核心写 JSON。 */
  | { ok: true; status: number; body: string }
  /** 失败：核心据此做冷却/禁用/换号。 */
  | { ok: false; state: AccountState; message: string }

/** 供应商配置：dsh-router 核心注入的运行时环境。 */
export interface SupplierEnv {
  /** 数据目录（state.json / keys.json 所在目录）。 */
  dataDir: string
  /** 日志。 */
  log: (msg: string) => void
  /** 通用配置存储。 */
  store: SupplierConfigStoreLike
  /** 通用凭证存储。 */
  credentials: CredentialStoreLike
}

/** 供应商模块 —— 契约（核心必须，差异化可选）。 */
export interface SupplierModule {
  readonly id: string
  readonly name: string
  readonly priority?: number
  /** 图标（URL 或 SVG data URI），面板供应商卡片显示。可选。 */
  readonly icon?: string

  // ---- 核心（必须） ----
  /** 报账号「现在状态」（插件只报它观察到的）。冷却/禁用/错误累计由核心叠加。 */
  status(): SupplierStatusNow
  listModels(force?: boolean): Promise<ModelInfo[]> | ModelInfo[]
  getAlias(): string
  /**
   * 对**单个账号**调一次上游。插件不遍历账号、不管冷却、不写 res——
   * 选号/回退/健康判定全是核心的活。
   */
  chatOnce(uid: string, req: ChatRequest): Promise<ChatOnceResult>
  dispose(): void

  // ---- 差异化能力（可选） ----

  /** 上次 chatOnce 失败原因（诊断用）。测试模型由 dsh-router 核心统一走
   *  chatOnce 路径（账号池回退/冷却自动生效），插件只需暴露失败原因。 */
  lastError?(): string | undefined
  generateLoginUrl?(): string | { ok: boolean; error?: string; loginUrl?: string }
  completeLogin?(callbackUrl: string): Promise<{ uid: string; nickname: string }>
  /** 单个链接签到。遍历所有链接 + 结果汇总是 dsh-router 核心的活。
   *  status: 'ok'(签到成功) / 'already'(今日已签到) / 'error'(失败)。 */
  checkinNow?(uid: string): Promise<{ ok: boolean; status: string; message?: string }>
}
