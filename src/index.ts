/**
 * dsh-router-traework —— DSH 插件 host half。
 *
 * 通过 cordis service `router.suppliers` 把 traework 供应商工厂暴露给 dsh-router。
 * service 值：`{ [supplierId]: (env) => SupplierModule }`。
 *
 * 聚合表由 dsh-router-core 统一 provide（空表），本插件只往里追加自己的工厂，不重复
 * provide（cordis 同一 service 只允许一个插件注册）。表可用后把 traework 挂进去并广播
 * `internal/service`，让 dsh-router 按 live 表增量重扫。
 */
import type { Context } from '@deepseek-ai/cordis'
import factory from './api/plugin.ts'
import type { SupplierEnv, SupplierModule } from './contract.ts'

export const name = 'dsh-router-traework'

/** 暴露给 dsh-router 的供应商工厂表。 */
export interface RouterSuppliersService {
  [supplierId: string]: (env: SupplierEnv) => SupplierModule
}

export function apply(ctx: Context): void {
  // 等核心把聚合表 provide 出来后再追加（顺序无关：inject 延迟到服务可用才触发）。
  ctx.inject(['router.suppliers'], (sctx) => {
    const c = sctx as unknown as {
      get?: (key: string) => unknown
      router?: { suppliers?: RouterSuppliersService }
    }
    const suppliers = (c.get?.('router.suppliers') ?? c.router?.suppliers) as RouterSuppliersService | undefined
    if (!suppliers) return undefined
    if (!suppliers.traework) {
      suppliers.traework = factory
      ctx.emit('internal/service', 'router.suppliers', suppliers)
      ctx.logger?.info?.('[dsh-router-traework] registered router.suppliers: traework')
    }
    return () => { delete suppliers.traework }
  })
}
