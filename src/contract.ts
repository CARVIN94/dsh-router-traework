/**
 * 供应商契约 —— dsh-router-traework 自含（不依赖 dsh-router 包）。
 * 与 dsh-router 的 suppliers/contract.ts 契约保持同步：
 * 通用能力（连接池/模型管理/别名/签到规则/凭证）由 dsh-router 核心统一管，
 * 本插件只提供**差异化能力**。
 */
import type { ServerResponse } from 'node:http'
import type { ChatRequest, ModelInfo, SupplierAccount, SupplierStatus } from './types.ts'

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
  status(): SupplierStatus
  listModels(force?: boolean): Promise<ModelInfo[]> | ModelInfo[]
  getAlias(): string
  chatCompletions(req: ChatRequest, res: ServerResponse): Promise<boolean>
  dispose(): void

  // ---- 差异化能力（可选） ----

  /** 上次 chatCompletions 失败原因（诊断用）。测试模型由 dsh-router 核心统一走
   *  chatCompletions 路径（账号池回退/冷却自动生效），插件只需暴露失败原因。 */
  lastError?(): string | undefined
  generateLoginUrl?(): string | { ok: boolean; error?: string; loginUrl?: string }
  completeLogin?(callbackUrl: string): Promise<{ uid: string; nickname: string }>
  /** 单个链接签到。遍历所有链接 + 结果汇总是 dsh-router 核心的活。
   *  status: 'ok'(签到成功) / 'already'(今日已签到) / 'error'(失败)。 */
  checkinNow?(uid: string): Promise<{ ok: boolean; status: string; message?: string }>
}

export type { SupplierAccount }
