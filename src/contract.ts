/**
 * 供应商契约 —— dsh-router-traework 自含（不依赖 dsh-router 包）。
 * 与 dsh-router 的 suppliers/contract.ts 契约保持同步：
 * 通用能力（连接池/模型管理/别名/签到规则/凭证）由 dsh-router 核心统一管，
 * 本插件只提供**差异化能力**。
 */
import type { ChatRequest, ModelInfo } from './types.ts'

/** 通用配置存储（dsh-router 核心注入；连接池/模型管理/别名/积分缓存）。 */
export interface SupplierConfigStoreLike {
  get(id: string): {
    alias: string
    disabled: string[]
    custom: string[]
    poolOrder: string[]
    poolStrategy: 'fallback' | 'round-robin'
    /** 积分缓存：uid → 剩余额度（-1 = 还没拿到过）。 */
    credits: Record<string, number>
  }
  setAlias(id: string, alias: string): void
  setPoolOrder(id: string, uids: string[]): void
  setPoolStrategy(id: string, strategy: string): void
  setModelEnabled(id: string, modelId: string, enabled: boolean): void
  addCustomModel(id: string, modelId: string): void
  removeCustomModel(id: string, modelId: string): void
  setAllModelsEnabled(id: string, enabled: boolean, modelIds: string[]): void
  /** 读积分缓存；没缓存过返回 -1。 */
  getCredits(id: string, uid: string): number
  /** 合并插件报的积分：-1（未知）回落到缓存值，非 -1 写入并返回它。 */
  putCredits(id: string, uid: string, reported: number): number
  /** 删链接时清掉它的积分缓存。 */
  clearCredits(id: string, uid: string): void
}

/** 通用凭证存储（dsh-router 核心注入；不透明凭证 blob）。 */
export interface CredentialStoreLike {
  list(supplierId: string): string[]
  get<T = unknown>(supplierId: string, uid: string): T | undefined
  save(supplierId: string, uid: string, blob: unknown): void
  remove(supplierId: string, uid: string): void
}

/**
 * 核心注入的运行时环境中，本插件真正用到的部分。
 *
 * `onLateFailure` 是迟到失败上报（流式响应已提交后才发现的错误）。核心是
 * **先跑 factory 再挂这个回调**的，所以插件必须在**调用时**读它，不能在
 * 构造函数里缓存 —— 构造时读必是 undefined。
 */
export interface SupplierEnvLike {
  /**
   * 核心注入的**绝对**数据目录（`~/.dsh/profiles/<name>/data`）。
   * 插件一律从这里派生自己的落盘路径，绝不写相对路径——相对路径会跟着
   * 进程 cwd 跑，换目录启动就静默换一套空数据。
   */
  dataDir?: string
  onLateFailure?: (uid: string, model: string, state: AccountState, message: string) => void
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
  /**
   * 剩余额度。**拿不到就报 `-1`**，不是 0：
   * 插件刚重启（内存缓存空）、积分拉取失败、或压根不支持积分时都是 `-1`。
   * 核心据此保留上一次持久化下来的值 —— 报 0 会把缓存冲成 0（0 是真值
   * 「用完了」，核心分不清「拿到 0」和「没拿到」）。
   */
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
  /**
   * 迟到的失败上报（可选）——**只在响应已提交之后**才用。
   *
   * 流式请求一旦写出第一个字节就绑死（HTTP 语义），此时上游再报错已经换不了
   * 号、也改不了状态码。但「这个号坏了」对**后续**请求仍有用：不报上来它就会
   * 继续留在池里被轮转选中（实测：TRAE 三个号里两个被拒 code=4008，round-robin
   * 下 2/3 请求直接失败）。核心实现 = `pool.noteFailure`，按状态冷却/禁用。
   * 插件拿不到也不用兜底：不调用就退化成今天的行为。
   */
  onLateFailure?: (uid: string, model: string, state: AccountState, message: string) => void
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
  /**
   * 对**单个账号**调一次上游。插件不遍历账号、不管冷却、不写 res——
   * 选号/回退/健康判定全是核心的活。
   *
   * 失败原因通过返回值的 `message` 报（核心测试模型时直接拿它做诊断提示），
   * 插件不必维护「上次失败」的状态。
   */
  chatOnce(uid: string, lv: string, req: ChatRequest): Promise<ChatOnceResult>
  dispose(): void

  // ---- 差异化能力（可选） ----

  generateLoginUrl?(): string | { ok: boolean; error?: string; loginUrl?: string }
  completeLogin?(callbackUrl: string): Promise<{ uid: string; nickname: string }>
  /** 单个链接签到。遍历所有链接 + 结果汇总是 dsh-router 核心的活。
   *  status: 'ok'(签到成功) / 'already'(今日已签到) / 'error'(失败)。 */
  checkinNow?(uid: string): Promise<{ ok: boolean; status: string; message?: string }>
}
