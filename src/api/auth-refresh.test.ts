/**
 * token 主动轮换测试 —— 锁定「签发超 15 天即刷新」的判定。
 *
 * 背景（2026-09-16，对齐 codebuddy 的修法）：上游可服务端吊销旧凭据（JWT 远未
 * 过期仍 401、refresh 报会话不存在——codebuddy 2026-06 批实测）。只按临到期判的话
 * 一份签发很久的旧 token 会被一直复用。TRAE token 有效期 14 天，本判定主要兜
 * 「自然刷新没发生」的场景。
 *
 * 判据表（与 codebuddy 三条一致）：
 *   1. 签发超 15 天 → 刷（即使远未临到期）
 *   2. 签发 1 天且未临到期 → 不刷（保持旧行为）
 *   3. 无 iat（解不出签发时间）→ 回落仅按 expiresAt 判，不误刷
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { issuedTooLong, tokenIssuedAtMs, type Auth } from './auth.ts'
import { SoloClient } from './upstream.ts'

const DAY = 24 * 3600_000
const MAX_ISSUED = 15 * DAY

/** 造一个带指定 iat/exp（Unix 秒）的假 JWT accessToken。 */
function makeToken(iatSec: number, expSec?: number): string {
  const b64 = (s: string): string => Buffer.from(s).toString('base64').replace(/=+$/, '')
  const payload: Record<string, unknown> = { data: { id: 'u' }, iat: iatSec, exp: expSec ?? iatSec + 14 * 86400 }
  return `${b64('{"alg":"RS256","typ":"JWT"}')}.${b64(JSON.stringify(payload))}.sig`
}

function fakeAuth(accessToken: string, expiresAtSec: number): Auth {
  return {
    accessToken,
    refreshToken: 'ref',
    expiresAt: expiresAtSec,
    domain: 'trae.cn',
    apiHost: '',
    machineId: '',
    deviceId: '',
    uid: 'u',
    enterpriseId: '',
    nickname: 'N',
    filePath: '',
  }
}

test('tokenIssuedAtMs：解出顶层 iat；坏 token 返回 null', () => {
  const now = Date.now()
  const t = makeToken(Math.floor(now / 1000))
  const iat = tokenIssuedAtMs(t)
  assert.ok(iat !== null && Math.abs(iat - now) < 2000, 'iat 应解出且接近当前时间')
  assert.equal(tokenIssuedAtMs('not-a-jwt'), null, '非 JWT → null')
  assert.equal(tokenIssuedAtMs('a.b.c'), null, 'payload 非 JSON → null')
})

test('签发超过 15 天 → issuedTooLong=true（即使远未临到期）', () => {
  const now = Date.now()
  const t = makeToken(Math.floor((now - 16 * DAY) / 1000))
  assert.equal(issuedTooLong(t, MAX_ISSUED, now), true)
})

test('签发 1 天且未临到期 → issuedTooLong=false（保持旧行为）', () => {
  const now = Date.now()
  const t = makeToken(Math.floor((now - 1 * DAY) / 1000))
  assert.equal(issuedTooLong(t, MAX_ISSUED, now), false)
})

test('无 iat → issuedTooLong=false（回落仅按 expiresAt 判，不误刷）', () => {
  assert.equal(issuedTooLong('not-a-jwt', MAX_ISSUED), false)
})

test('refreshTokenIfNeeded：签发超 15 天时尝试刷新（不发出则不触发）', async () => {
  const now = Date.now()
  const calls: string[] = []
  const client = new SoloClient({
    fetchImpl: (async (_url, init) => {
      calls.push(String((init?.headers as Record<string, string> | undefined)?.['Content-Type'] ?? ''))
      return new Response(JSON.stringify({ Result: { Token: makeToken(Math.floor(now / 1000)), RefreshToken: 'ref2', TokenExpireDuration: 14 * 86400 } }), { status: 200 })
    }) as typeof fetch,
  })
  const a = fakeAuth(makeToken(Math.floor((now - 16 * DAY) / 1000), Math.floor((now + 14 * DAY) / 1000)), Math.floor((now + 14 * DAY) / 1000))
  const refreshed = await client.refreshTokenIfNeeded(a, DAY)
  assert.equal(refreshed, true, '签发 16 天必须触发刷新')
  assert.notEqual(a.refreshToken, 'ref', 'refreshToken 应被上游返回值替换')
})

test('refreshTokenIfNeeded：签发 1 天且未临到期 → 不触发', async () => {
  const now = Date.now()
  const client = new SoloClient({
    fetchImpl: (async () => {
      throw new Error('should not be called')
    }) as typeof fetch,
  })
  const a = fakeAuth(makeToken(Math.floor((now - 1 * DAY) / 1000)), Math.floor((now + 14 * DAY) / 1000))
  const refreshed = await client.refreshTokenIfNeeded(a, DAY)
  assert.equal(refreshed, false, '未临到期且签发新 → 不刷')
})
