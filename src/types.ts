/**
 * 类型定义 —— dsh-router-traework 自含（不依赖 dsh-router 包）。
 * 与 dsh-router 的 router/types.ts 契约保持同步。
 */
import type { ServerResponse } from 'node:http'

/** 面板展示的账号状态（脱敏）。 */
export interface SupplierAccount {
  uid: string
  nickname?: string
  credits: number
  cooling: boolean
  until?: string
  reason?: string
  disabled: boolean
  err_count?: number
}

/** 供应商面板状态。 */
export interface SupplierStatus {
  id: string
  name: string
  accounts: SupplierAccount[]
}

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
 * 供应商接口。chatCompletions 直接向 res 写响应（流式 SSE 或 JSON），
 * 成功返回 true；返回 false 表示"该供应商无健康账号可服务"（触发路由器
 * 轮换到下一个供应商）。
 */
export interface Supplier {
  readonly id: string
  readonly name: string
  readonly priority: number
  status(): SupplierStatus
  listModels(force?: boolean): Promise<ModelInfo[]> | ModelInfo[]
  modelsWithEnabled(): Promise<ModelWithEnabled[]> | ModelWithEnabled[]
  getAlias(): string
  customModelIds?(): string[]
  chatCompletions(req: ChatRequest, res: ServerResponse): Promise<boolean>
  testModel(id: string): Promise<{ ok: boolean; error?: string }>
  removeLink?(uid: string): Promise<boolean>
  dispose(): void
}
