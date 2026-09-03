/**
 * traework 供应商插件入口 —— 把 TRAE SOLO 实现包装成符合契约的 SupplierModule。
 *
 * 作为 dsh-router 的外部供应商：通过 router.suppliers service 把 factory 暴露给
 * dsh-router 加载。通用能力（连接池/模型管理/别名/签到规则/凭证）由 dsh-router
 * 核心统一管（env 注入），这里只暴露差异化方法。
 */
import { TraeworkSupplier } from './index.ts'
import type { ChatOnceResult, SupplierEnv, SupplierModule, SupplierStatusNow } from '../contract.ts'
import type { ModelInfo, ChatRequest } from '../types.ts'

export const id = 'traework'
export const name = 'traework'
export const priority = 0
/** 面板图标（TRAE 官方 logo，取自 trae.cn/work 页面。SVG data URI）。 */
export const icon =
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="21" fill="none" viewBox="0 0 28 21"><g clip-path="url(#a)"><path fill="#0a0a0a" d="M28.002 20.846H4v-3.998H0V.846h28.002zM4 16.848h20.002V4.845H4zm10.002-6.062-2.829 2.828-2.828-2.828 2.828-2.829zm8-.002-2.828 2.828-2.829-2.828 2.829-2.829z"/></g><defs><clipPath id="a"><path fill="#0a0a0a" d="M0 .846h28.002v20H0z"/></clipPath></defs></svg>`,
  )

let instance: TraeworkSupplier | undefined

/** factory：dsh-router 调用它构造实例（env 注入 store/credentials）。 */
export default function factory(env: SupplierEnv): SupplierModule & { removeLink?(uid: string): Promise<boolean> } {
  if (!instance) {
    instance = new TraeworkSupplier({}, env.store, env.credentials, env.log)
    // 加载即启动：扫凭证、起调度器、刷积分（失败不阻断）
    void instance.start().catch((err: unknown) => {
      env.log(`traework start: ${(err as Error).message}`)
    })
  }
  return {
    id,
    name,
    priority,
    icon,
    status: (): SupplierStatusNow => instance!.status(),
    listModels: (force?: boolean): ModelInfo[] | Promise<ModelInfo[]> => instance!.listModels(force),
    chatOnce: (uid: string, req: ChatRequest): Promise<ChatOnceResult> => instance!.chatOnce(uid, req),
    dispose: (): void => instance!.dispose(),
    generateLoginUrl: (): string => instance!.generateLoginUrl(),
    completeLogin: (url: string): Promise<{ uid: string; nickname: string }> => instance!.completeLogin(url),
    removeLink: (uid: string): Promise<boolean> => instance!.removeLink(uid),
    checkinNow: (uid: string): Promise<{ ok: boolean; status: string; message?: string }> => instance!.checkinNow(uid),
  }
}
