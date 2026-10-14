/**
 * 账号池测试 —— 锁住 2026-09-03 的积分归属变更：
 *
 * 积分的持久化从插件（state.json）迁到核心（supplier-config.json）。
 * 插件只报值，不再写盘。两个必须守住的点：
 *   - 新账号 / 没拉到积分 → 报 -1（不能报 0，0 会把核心缓存冲成 0）
 *   - 旧 state.json 里的积分能读出来喂给核心（迁移，不让用户的旧数据凭空消失）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool, CREDITS_UNKNOWN } from './pool.ts'

type Auth = Parameters<Pool['add']>[0]

function authOf(uid: string): Auth {
  return {
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAt: 0,
    domain: 'trae.cn',
    apiHost: '',
    machineId: 'm',
    deviceId: 'd',
    uid,
    enterpriseId: '',
    nickname: uid,
    filePath: '',
  }
}

test('新账号没拉到积分 → 报 -1，不是 0', () => {
  const pool = new Pool('')
  pool.add(authOf('u1'))
  assert.equal(pool.list()[0]?.credits, CREDITS_UNKNOWN)
})

test('setCredits 只改内存（持久化归核心）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-pool-'))
  const fp = join(dir, 'state.json')
  const pool = new Pool(fp)
  pool.add(authOf('u1'))
  pool.setCredits('u1', 1234)
  assert.equal(pool.list()[0]?.credits, 1234)
})

test('迁移：旧 state.json 里的积分读得出来', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-pool-'))
  const fp = join(dir, 'state.json')
  writeFileSync(fp, JSON.stringify({ accounts: { u1: { credits: 3754.07 }, u2: { credits: -1 } } }))
  const pool = new Pool(fp)
  pool.add(authOf('u1'))
  pool.add(authOf('u2'))
  const legacy = pool.takeLegacyCredits()
  assert.equal(legacy.u1, 3754.07)
  assert.equal(legacy.u2, undefined) // 负数不当数
})

test('没有旧文件 / 文件坏了 → 迁移返回空，不炸', () => {
  assert.deepEqual(new Pool(join(tmpdir(), 'no-such-dir-xyz', 'state.json')).takeLegacyCredits(), {})
  const dir = mkdtempSync(join(tmpdir(), 'tw-pool-'))
  const fp = join(dir, 'state.json')
  writeFileSync(fp, '{ not json')
  assert.deepEqual(new Pool(fp).takeLegacyCredits(), {})
})

test('旧文件里的 order/strategy 照常读（迁移没碰坏其它字段）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-pool-'))
  const fp = join(dir, 'state.json')
  writeFileSync(fp, JSON.stringify({ accounts: { u1: { credits: 5 } }, order: ['u1'], strategy: 'round-robin' }))
  const pool = new Pool(fp)
  pool.add(authOf('u1'))
  assert.deepEqual(pool.getOrder(), ['u1'])
  assert.equal(pool.getStrategy(), 'round-robin')
})

// ---- 积分用完 → 报 quota（核心据此把该号移出选号） ----
// 背景：积分 0 的号在上游必失败，且是 **HTTP 200 + 流内 4008**（响应已提交，
// 这次请求救不回来）。只在失败后记账 = 每个请求都白撞一次才换号。报 quota 让
// 核心**提前**把该号排除，用户第一次就不会撞上。

test('积分用完（0）→ 报 quota，不再报 ok', () => {
  const pool = new Pool('')
  pool.add(authOf('u1'))
  pool.setCredits('u1', 0)
  const st = pool.list()[0]
  assert.equal(st?.credits, 0)
  assert.equal(st?.state, 'quota', '0 积分 = 额度不足，必须让核心看见')
})

test('还没拉到积分（-1）≠ 用完：仍报 ok，不能误判成 quota', () => {
  const pool = new Pool('')
  pool.add(authOf('u1'))
  assert.equal(pool.list()[0]?.credits, CREDITS_UNKNOWN)
  assert.equal(pool.list()[0]?.state, 'ok', '-1 是「不知道」，不是「用完了」')
})

test('还有余额 → 报 ok（quota 只针对 0）', () => {
  const pool = new Pool('')
  pool.add(authOf('u1'))
  pool.setCredits('u1', 0.5)
  assert.equal(pool.list()[0]?.state, 'ok', '小数余额也是余额')
})

test('token 失效优先于 quota：报 session_dead', () => {
  const pool = new Pool('')
  const a = authOf('u1')
  a.accessToken = ''
  pool.add(a)
  pool.setCredits('u1', 0)
  assert.equal(pool.list()[0]?.state, 'session_dead', '凭证都没了，先修登录')
})
