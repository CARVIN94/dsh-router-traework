/**
 * 账号池：内存索引 + 冷却/禁用状态机 + state.json 持久化。
 * 挑选策略（与组合相同）：fallback = 按 order 顺序取第一个 healthy；
 * round-robin = 轮转游标取 healthy。order 由用户在连接池拖动排序。
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Auth } from './auth.ts'

export type CoolKind = 'plan_limit' | 'soft_rate' | 'error_threshold'

export const COOL_KIND: Record<CoolKind, string> = {
  plan_limit: 'plan_limit',
  soft_rate: 'soft_rate',
  error_threshold: 'error_threshold',
}

/** 账号选择策略，与组合策略一致。 */
export type PoolStrategy = 'fallback' | 'round-robin'

/** 外部连接池配置源（dsh-router 通用层 SupplierConfigStore）。 */
export interface PoolConfigSource {
  getOrder: () => string[]
  getStrategy: () => PoolStrategy
  setOrder: (uids: string[]) => void
  setStrategy: (strategy: PoolStrategy) => void
}

/** 单个账号对外暴露的状态（脱敏，不含 token）。 */
export interface AccountStatus {
  uid: string
  nickname?: string
  credits: number
  cooling: boolean
  until?: string
  reason?: string
  disabled: boolean
  err_count?: number
}

interface Entry {
  a: Auth
  credits: number
  disabled: boolean
  reason: string
  until: number // epoch ms；0 = 无冷却
  errCount: number
}

function healthy(e: Entry, now: number): boolean {
  if (e.disabled) return false
  if (e.until !== 0 && now < e.until) return false
  return true
}

interface StateFile {
  accounts: Record<
    string,
    { credits: number; disabled: boolean; reason?: string; until?: string }
  >
  /** 连接池顺序（uid 数组，拖动排序结果）。 */
  order?: string[]
  /** 账号选择策略。 */
  strategy?: PoolStrategy
}

/** 账号池。 */
export class Pool {
  private byUID = new Map<string, Entry>()
  private stateFp = ''
  private config?: PoolConfigSource
  private order: string[] = []
  private strategy: PoolStrategy = 'fallback'
  /** round-robin 轮转游标。 */
  private rrCursor = 0

  constructor(stateFp = '', config?: PoolConfigSource) {
    this.stateFp = stateFp
    this.config = config
    if (config) {
      this.order = config.getOrder()
      this.strategy = config.getStrategy()
    }
    if (stateFp !== '') this.load()
  }

  /** 加入账号；已存在则保留原状态、更新凭证。 */
  add(a: Auth): void {
    const e = this.byUID.get(a.uid)
    if (e) {
      e.a = a // 保留 credits/cooling 状态
      return
    }
    this.byUID.set(a.uid, { a, credits: 0, disabled: false, reason: '', until: 0, errCount: 0 })
    if (!this.order.includes(a.uid)) {
      this.order.push(a.uid)
      if (this.config) this.config.setOrder([...this.order])
    }
  }

  /** 用最新扫描结果对齐池：新账号加入、消失的账号剔除。 */
  syncToDir(auths: Auth[]): void {
    const seen = new Set<string>()
    for (const a of auths) {
      seen.add(a.uid)
      const e = this.byUID.get(a.uid)
      if (e) e.a = a
      else {
        this.byUID.set(a.uid, { a, credits: 0, disabled: false, reason: '', until: 0, errCount: 0 })
        if (!this.order.includes(a.uid)) this.order.push(a.uid)
      }
    }
    for (const uid of this.byUID.keys()) {
      if (!seen.has(uid)) this.byUID.delete(uid)
    }
    // 剔除已消失账号的顺序项
    const alive = new Set(this.byUID.keys())
    if (this.order.some((uid) => !alive.has(uid))) {
      this.order = this.order.filter((uid) => alive.has(uid))
      if (this.config) this.config.setOrder([...this.order])
      else this.saveLocked()
    }
  }

  /** 按当前策略选一个 healthy 账号；无可用返回 undefined。 */
  pick(): Auth | undefined {
    return this.pickExcluding(undefined)
  }

  /** 同上，但跳过 tried 中的 uid（请求级轮转）。 */
  pickExcluding(tried?: Set<string>): Auth | undefined {
    const now = Date.now()
    const healthyList = this.orderedHealthy(tried, now)
    if (healthyList.length === 0) return undefined
    if (this.strategy === 'round-robin') {
      const start = this.rrCursor % healthyList.length
      this.rrCursor = this.rrCursor + 1
      return healthyList[start]?.a
    }
    // fallback：按 order 顺序取第一个
    return healthyList[0]?.a
  }

  /** 按 order 输出 healthy 账号（跳过 tried）。 */
  private orderedHealthy(tried: Set<string> | undefined, now: number): Entry[] {
    const byUID = this.byUID
    const ranked = [...this.order].filter((uid) => !tried?.has(uid) && byUID.has(uid))
    // order 外的账号（新加入未排）追加在后面
    for (const [uid, e] of byUID) {
      if (!tried?.has(uid) && !this.order.includes(uid)) ranked.push(uid)
    }
    const out: Entry[] = []
    for (const uid of ranked) {
      const e = byUID.get(uid)
      if (e && healthy(e, now)) out.push(e)
    }
    return out
  }

  /** 当前策略。 */
  getStrategy(): PoolStrategy {
    return this.strategy
  }

  /** 设置策略（fallback/round-robin）。 */
  setStrategy(strategy: PoolStrategy): void {
    if (strategy !== 'fallback' && strategy !== 'round-robin') return
    this.strategy = strategy
    if (this.config) this.config.setStrategy(strategy)
    else this.saveLocked()
  }

  /** 当前连接池顺序（uid 数组）。 */
  getOrder(): string[] {
    return [...this.order]
  }

  /** 设置连接池顺序（拖动排序结果）。 */
  setOrder(uids: string[]): void {
    const alive = new Set(this.byUID.keys())
    const next = [...new Set(uids)].filter((uid) => alive.has(uid))
    // 保留 order 外仍存活的账号
    for (const uid of this.byUID.keys()) {
      if (!next.includes(uid)) next.push(uid)
    }
    this.order = next
    if (this.config) this.config.setOrder([...this.order])
    else this.saveLocked()
  }

  setCredits(uid: string, credits: number): void {
    const e = this.byUID.get(uid)
    if (e) e.credits = credits
    this.saveLocked()
  }

  /** 冷却账号至 now+d。 */
  cooldown(uid: string, _kind: CoolKind, dMs: number, reason: string): void {
    const e = this.byUID.get(uid)
    if (e) {
      e.until = Date.now() + dMs
      e.reason = reason
      e.errCount = 0
    }
    this.saveLocked()
  }

  /** 永久禁用（session 失效），需人工重登后恢复。 */
  disable(uid: string, reason: string): void {
    const e = this.byUID.get(uid)
    if (e) {
      e.disabled = true
      e.reason = reason
    }
    this.saveLocked()
  }

  /** 签到后解冻：仅当 remain > 0 且账号处于冷却（非禁用）时恢复。 */
  reenableIfCredits(uid: string, remain: number): void {
    const e = this.byUID.get(uid)
    if (e) {
      e.credits = remain
      if (remain > 0 && !e.disabled) {
        e.until = 0
        e.reason = ''
        e.errCount = 0
      }
    }
    this.saveLocked()
  }

  /** 记录一次错误；达到 threshold 自动冷却 d。 */
  noteError(uid: string, threshold: number, dMs: number): void {
    const e = this.byUID.get(uid)
    if (e) {
      e.errCount++
      if (e.errCount >= threshold) {
        e.until = Date.now() + dMs
        e.reason = 'consecutive errors'
        e.errCount = 0
      }
    }
    this.saveLocked()
  }

  /** 成功请求重置错误计数。 */
  noteSuccess(uid: string): void {
    const e = this.byUID.get(uid)
    if (e) e.errCount = 0
  }

  authByUID(uid: string): Auth | undefined {
    return this.byUID.get(uid)?.a
  }

  /** 返回所有账号状态（按连接池顺序，稳定输出）。 */
  list(): AccountStatus[] {
    const now = Date.now()
    const out: AccountStatus[] = []
    const alive = new Set(this.byUID.keys())
    const ranked = [...this.order].filter((uid) => alive.has(uid))
    for (const uid of this.byUID.keys()) {
      if (!ranked.includes(uid)) ranked.push(uid)
    }
    for (const uid of ranked) {
      const e = this.byUID.get(uid)
      if (e === undefined) continue
      out.push({
        uid,
        nickname: e.a.nickname || undefined,
        credits: e.credits,
        cooling: e.until !== 0 && now < e.until,
        until: e.until !== 0 ? new Date(e.until).toISOString() : undefined,
        reason: e.reason || undefined,
        disabled: e.disabled,
        err_count: e.errCount || undefined,
      })
    }
    return out
  }

  private load(): void {
    let raw: string
    try {
      raw = readFileSync(this.stateFp, 'utf8')
    } catch {
      return
    }
    let sf: StateFile
    try {
      sf = JSON.parse(raw) as StateFile
    } catch {
      return
    }
    for (const [uid, s] of Object.entries(sf.accounts ?? {})) {
      this.byUID.set(uid, {
        a: { accessToken: '', refreshToken: '', expiresAt: 0, domain: '', apiHost: '', machineId: '', deviceId: '', uid, enterpriseId: '', nickname: '', filePath: '' },
        credits: s.credits,
        disabled: s.disabled,
        reason: s.reason ?? '',
        until: s.until ? new Date(s.until).getTime() : 0,
        errCount: 0,
      })
    }
    if (!this.config) {
      if (Array.isArray(sf.order)) {
        const alive = new Set(this.byUID.keys())
        this.order = sf.order.filter((uid) => alive.has(uid))
      }
      if (sf.strategy === 'fallback' || sf.strategy === 'round-robin') this.strategy = sf.strategy
    }
  }

  private saveLocked(): void {
    if (this.stateFp === '') return
    const sf: StateFile = {
      accounts: {},
      order: this.config ? [] : [...this.order],
      strategy: this.config ? 'fallback' : this.strategy,
    }
    for (const [uid, e] of this.byUID) {
      sf.accounts[uid] = {
        credits: e.credits,
        disabled: e.disabled,
        reason: e.reason || undefined,
        until: e.until !== 0 ? new Date(e.until).toISOString() : undefined,
      }
    }
    try {
      const dir = dirname(this.stateFp)
      if (dir !== '' && dir !== '.') mkdirSync(dir, { recursive: true })
      const raw = JSON.stringify(sf, null, 2)
      const tmp = this.stateFp + '.tmp'
      writeFileSync(tmp, raw, { mode: 0o600 })
      renameSync(tmp, this.stateFp)
    } catch {
      // 持久化失败不阻断运行
    }
  }
}
