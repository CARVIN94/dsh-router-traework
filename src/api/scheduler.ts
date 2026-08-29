/**
 * 定时任务：每日签到 + token 预刷新。移植自 traework2api/internal/scheduler/scheduler.go。
 * 签到成功后重新查积分，积分 > 0 的冷却账号自动解冻。
 */
import type { SoloClient } from './upstream.ts'
import type { Pool } from './pool.ts'
import type { Auth } from './auth.ts'
import { needsRefresh, refreshTokenValue } from './auth.ts'

export interface SchedulerConfig {
  pool: Pool
  client: SoloClient
  checkinHour: number
  refreshHours: number[]
  refreshSkewMs: number
  /** 凭证写回（dsh-router 凭证存储，核心统一管）。 */
  saveAuth: (a: Auth) => void
  log?: (msg: string) => void
}

function nextFire(now: Date, hours: number[]): Date {
  let earliest: Date | undefined
  for (const h of hours) {
    const t = new Date(now)
    t.setHours(h, 0, 0, 0)
    if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1)
    if (earliest === undefined || t.getTime() < earliest.getTime()) earliest = t
  }
  return earliest ?? new Date(now.getTime() + 3600_000)
}

/** 调度器：每分钟检查一次，到整点触发对应任务。 */
export class Scheduler {
  private cfg: SchedulerConfig
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = false

  constructor(cfg: SchedulerConfig) {
    this.cfg = cfg
  }

  /** 启动循环。 */
  start(): void {
    this.stopped = false
    const tick = (): void => {
      if (this.stopped) return
      const now = new Date()
      const h = now.getHours()
      if (this.cfg.refreshHours.includes(h)) {
        this.runRefreshNow()
      }
      if (this.cfg.checkinHour === h) {
        this.runCheckinNow()
      }
      const next = nextFire(now, [...this.cfg.refreshHours, this.cfg.checkinHour])
      const delay = Math.min(Math.max(next.getTime() - now.getTime(), 1000), 3600_000)
      this.timer = setTimeout(tick, delay)
    }
    tick()
  }

  /** 停止循环。 */
  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private log(msg: string): void {
    this.cfg.log?.(`[dsh-router traework scheduler] ${msg}`)
  }

  /** 立即对所有账号刷新 token；session 失效的自动禁用。 */
  runRefreshNow(): void {
    for (const st of this.cfg.pool.list()) {
      if (st.disabled) continue
      const a = this.cfg.pool.authByUID(st.uid)
      if (!a || refreshTokenValue(a) === '') continue
      if (!needsRefresh(a, this.cfg.refreshSkewMs)) continue
      this.cfg.client
        .refreshToken(a)
        .then(() => this.cfg.saveAuth(a))
        .then(() => this.log(`refresh ${st.uid}: ok`))
        .catch((err: unknown) => {
          this.log(`refresh ${st.uid}: ${(err as Error).message}`)
          const ue = err as { kind?: string }
          if (ue.kind === 'session_dead') this.cfg.pool.disable(st.uid, 'session dead')
        })
    }
  }

  /** 立即对所有账号执行签到 + 积分刷新 + 解冻。 */
  runCheckinNow(): void {
    for (const st of this.cfg.pool.list()) {
      if (st.disabled) continue
      this.checkinOne(st.uid)
    }
  }

  /** 对单个账号执行签到。真实语义（参考 traework2api）：
   *  status 判定：checked_in=true → 今日已签；!enable → 未开放；
   *  仅 !checkedIn && enable 才 claim（claim HTTP 200 即成功，业务判定靠 status）。 */
  async checkinOne(uid: string): Promise<{ ok: boolean; status: 'ok' | 'already' | 'disabled' | 'error'; message?: string }> {
    const st = this.cfg.pool.list().find((s) => s.uid === uid)
    if (st === undefined || st.disabled) return { ok: false, status: 'disabled', message: '链接不可用或已禁用' }
    const a = this.cfg.pool.authByUID(uid)
    if (!a || refreshTokenValue(a) === '') return { ok: false, status: 'error', message: '凭证缺失' }
    try {
      const status = await this.cfg.client.checkinStatus(a)
      if (status.checkedIn) {
        // 今日已签到（traework 服务端 1 天 1 次）
        const remain = await this.cfg.client.userEntUsage(a)
        this.cfg.pool.reenableIfCredits(uid, remain)
        return { ok: true, status: 'already', message: '今日已签到' }
      }
      if (!status.enable) {
        return { ok: false, status: 'disabled', message: '今日签到未开放' }
      }
      const claimed = await this.cfg.client.checkinClaim(a)
      this.log(`checkin ${uid}: ${claimed}`)
      const remain = await this.cfg.client.userEntUsage(a)
      this.cfg.pool.reenableIfCredits(uid, remain)
      // 上游按设备判重：已签到是幂等成功，不是失败
      return claimed === 'already'
        ? { ok: true, status: 'already', message: '今日已签到' }
        : { ok: true, status: 'ok', message: '签到成功' }
    } catch (err) {
      const message = (err as Error).message
      this.log(`checkin ${uid}: ${message}`)
      return { ok: false, status: 'error', message }
    }
  }
}
