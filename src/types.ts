/**
 * 类型定义 —— dsh-router-traework 自含（不依赖 dsh-router 包）。
 * 与 dsh-router 的 router/types.ts 契约保持同步。
 */
import type { AccountState, ChatOnceResult, SupplierAccountNow, SupplierStatusNow } from './contract.ts'

export type { AccountState, SupplierAccountNow, SupplierStatusNow }

/** OpenAI 模型条目。 */
export interface ModelInfo {
  id: string
  context_length?: number
}

/** 面板展示的模型（含启用状态）。 */
export interface ModelWithEnabled extends ModelInfo {
  enabled: boolean
  custom?: boolean
}

/** 一次 /v1/chat/completions 请求。 */
export interface ChatRequest {
  /** 原始请求体 JSON 字符串。 */
  rawBody: string
  stream: boolean
  model: string
}

/**
 * 供应商接口。核心负责账号池（选号/冷却/禁用/错误累计/遍历回退），
 * 供应商只对**单个账号**调一次上游并报告结果，不碰 res。
 */
export interface Supplier {
  readonly id: string
  readonly name: string
  readonly priority: number
  /** 报账号「现在状态」。冷却/禁用/错误累计由核心叠加。 */
  status(): SupplierStatusNow
  listModels(force?: boolean): Promise<ModelInfo[]> | ModelInfo[]
  modelsWithEnabled(): Promise<ModelWithEnabled[]> | ModelWithEnabled[]
  customModelIds?(): string[]
  chatOnce(uid: string, lv: string, req: ChatRequest): Promise<ChatOnceResult>
  removeLink?(uid: string): Promise<boolean>
  dispose(): void
}
