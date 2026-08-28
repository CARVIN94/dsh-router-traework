/**
 * dsh-router-traework —— DSH 插件 host half。
 *
 * 通过 cordis service `router.suppliers` 把 traework 供应商工厂暴露给 dsh-router。
 * service 值：`{ [supplierId]: (env) => SupplierModule }`。
 *
 * dsh-router 在 apply 时 `ctx.inject(['router.suppliers'], cb)` 延迟消费，
 * 本插件先挂载还是后挂载都行（service 可用即触发）。
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
  ctx.provide('router.suppliers', {
    traework: factory,
  } satisfies RouterSuppliersService)
  ctx.logger?.info?.('[dsh-router-traework] provided router.suppliers: traework')
}
