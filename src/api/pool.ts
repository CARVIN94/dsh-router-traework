/**
 * 账号池（凭证侧）：内存索引 + 积分 + state.json 持久化。
 *
 * 选号/冷却/禁用/错误累计已归 dsh-router 核心（AccountPool）——这里只管
 * 「有哪些账号、凭证是什么、积分多少、顺序如何」，不再判定谁健康。
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Auth } from './auth.ts'
import type { AccountState } from '../contract.ts'


/** 账号选择策略，与组合策略一致。 */
export type PoolStrategy = 'fallback' | 'round-robin'

/** 外部连接池配置源（dsh-router 通用层 SupplierConfigStore）。 */
export interface PoolConfigSource {
  getOrder: () => string[]
  getStrategy: () => PoolStrategy
  setOrder: (uids: string[]) => void
  setStrategy: (strategy: PoolStrategy) => void
}

/** 单个账号「现在状态」（脱敏，不含 token）。冷却/禁用由核心叠加。 */
export interface AccountStatus {
  uid: string
  nickname?: string
  credits: number
  state: AccountState
}

interface Entry {
  a: Auth
  credits: number
}

interface StateFile {
  accounts: Record<string, { credits: number }>
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
    this.byUID.set(a.uid, { a, credits: 0 })
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
        this.byUID.set(a.uid, { a, credits: 0 })
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



  /** 签到后更新积分（冷却/禁用由核心管，这里只报上游事实）。 */
  setCreditsAfterCheckin(uid: string, remain: number): void {
    const e = this.byUID.get(uid)
    if (e) e.credits = remain
    this.saveLocked()
  }



  authByUID(uid: string): Auth | undefined {
    return this.byUID.get(uid)?.a
  }

  /** 返回所有账号状态（按连接池顺序，稳定输出）。
   *  只报「现在状态」：凭证 + 积分。冷却/禁用/错误累计由核心叠加。 */
  list(): AccountStatus[] {
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
        state: e.a.accessToken === '' ? 'session_dead' : 'ok',
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
      sf.accounts[uid] = { credits: e.credits }
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
