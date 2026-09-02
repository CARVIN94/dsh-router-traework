/**
 * 定时任务：每日签到 + token 预刷新。移植自 traework2api/internal/scheduler/scheduler.go。
 * 签到成功后重新查积分，积分 > 0 的冷却账号自动解冻。
 * 9074 是账号级稳定拒绝（见 upstream.ts CHECKIN_BUSY_CODE 注释），claim 只快速重试
 * 一次（1s）兜抖动，落空即失败——不空耗 8s。
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

  /** 立即对所有账号刷新 token（session 失效的体现由 chatOnce 报告给核心）。 */
  runRefreshNow(): void {
    for (const st of this.cfg.pool.list()) {
      const a = this.cfg.pool.authByUID(st.uid)
      if (!a || refreshTokenValue(a) === '') continue
      if (!needsRefresh(a, this.cfg.refreshSkewMs)) continue
      this.cfg.client
        .refreshToken(a)
        .then(() => this.cfg.saveAuth(a))
        .then(() => this.log(`refresh ${st.uid}: ok`))
        .catch((err: unknown) => {
          // 只记日志：禁用是核心的策略，这里不替它决定
          this.log(`refresh ${st.uid}: ${(err as Error).message}`)
        })
    }
  }

  /** 立即对所有账号执行签到 + 积分刷新 + 解冻。 */
  runCheckinNow(): void {
    for (const st of this.cfg.pool.list()) {
      this.checkinOne(st.uid)
    }
  }

  /** 对单个账号执行签到。真实语义（参考 traework2api / wild-work）：
   *  status 判定：checked_in=true → 今日已签；!enable → 未开放；
   *  仅 !checkedIn && enable 才 claim，claim 后**重查 status 确认**才算成功。
   *
   *  为什么必须回查：积分（user_ent_usage）是**所有包**的聚合剩余额度，
   *  实测某账号签到前后都是同一个数——拿它判成败会谎报「签到成功」。
   *  只有 status.checked_in 是这次签到的真凭据。 */
  async checkinOne(uid: string): Promise<{ ok: boolean; status: 'ok' | 'already' | 'disabled' | 'error'; message?: string }> {
    const st = this.cfg.pool.list().find((s) => s.uid === uid)
    if (st === undefined) return { ok: false, status: 'error', message: '链接不存在' }
    const a = this.cfg.pool.authByUID(uid)
    if (!a || refreshTokenValue(a) === '') return { ok: false, status: 'error', message: '凭证缺失' }
    try {
      const status = await this.cfg.client.checkinStatus(a)
      if (status.checkedIn) {
        await this.refreshCredits(uid, a)
        // 今日已签到（traework 服务端 1 天 1 次），幂等成功
        return { ok: true, status: 'already', message: '今日已签到' }
      }
      if (!status.enable) {
        return { ok: false, status: 'disabled', message: '今日签到未开放' }
      }
      const claimed = await this.cfg.client.checkinClaim(a)
      this.log(`checkin ${uid}: ${claimed}`)
      // 回查：claim 返回 0 也不代表真签上了，checked_in 才是凭据
      const after = await this.cfg.client.checkinStatus(a)
      await this.refreshCredits(uid, a)
      if (!after.checkedIn) {
        return { ok: false, status: 'error', message: '签到未生效：上游未标记已签到' }
      }
      // 上游按账号判重：已签到是幂等成功，不是失败
      return claimed === 'already'
        ? { ok: true, status: 'already', message: '今日已签到' }
        : { ok: true, status: 'ok', message: '签到成功' }
    } catch (err) {
      const message = (err as Error).message
      this.log(`checkin ${uid}: ${message}`)
      return { ok: false, status: 'error', message }
    }
  }

  /** 刷新积分（失败不阻断——积分只供面板显示，不是签到成败的凭据）。 */
  private async refreshCredits(uid: string, a: Auth): Promise<void> {
    try {
      this.cfg.pool.setCreditsAfterCheckin(uid, await this.cfg.client.userEntUsage(a))
    } catch (err) {
      this.log(`checkin ${uid}: 积分刷新失败 ${(err as Error).message}`)
    }
  }
}
