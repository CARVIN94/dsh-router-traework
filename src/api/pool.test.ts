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
