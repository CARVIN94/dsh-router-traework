/**
 * ugHeaders 头部对齐测试：锁定与真实客户端一致的头集合（2026-09-03 抓包实测）。
 * marketUserId 相关用例见文件末尾（该 id 服务端不提供，需本地生成并持久化）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ugHeaders } from './upstream.ts'
import { SOLO, CLIENT_UA } from './constants.ts'
import { newMarketUserId } from './login.ts'

function authOf(over: Partial<Record<string, string>> = {}): Parameters<typeof ugHeaders>[0] {
  return {
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAt: 0,
    domain: 'trae.cn',
    apiHost: '',
    machineId: 'm1',
    deviceId: 'd1',
    uid: '4135677434275728',
    enterpriseId: '',
    nickname: 'carvin',
    filePath: '',
    ...over,
  }
}

test('ugHeaders 携带全部真实客户端头（除 market-user-id）', () => {
  const h = ugHeaders(authOf())
  assert.equal(h['Content-Type'], 'application/json')
  assert.equal(h['X-User-Region'], 'CN')
  assert.equal(h['Package-Type'], 'stable_cn')
  assert.equal(h['X-Lgw-Req-Sdk-Type'], '3')
  assert.equal(h['X-Market-Client-Id'], CLIENT_UA)
  assert.equal(h['X-Device-Brand'], SOLO.DeviceBrand)
  assert.equal(h['X-Device-Type'], 'windows')
  assert.equal(h['X-Device-Id'], 'd1')
  assert.equal(h['App-Version'], SOLO.IdeVersion)
  // 无 marketUserId → 不带该头
  assert.equal(h['X-Market-User-Id'], undefined)
})

test('ugHeaders 有 request-id / trace-id 且格式正确', () => {
  const h = ugHeaders(authOf())
  // uuid-v4 格式
  assert.match(h['X-Request-Id'] ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  // tt-trace-id: 00-32hex-16hex-01
  assert.equal(h['X-TT-Trace-Id']?.length, 55)
  assert.ok((h['X-TT-Trace-Id'] ?? '').startsWith('00-'))
  assert.ok((h['X-TT-Trace-Id'] ?? '').endsWith('-01'))
})

test('ugHeaders 每次都生成新 trace（每次请求独立标识）', () => {
  const a = ugHeaders(authOf())
  const b = ugHeaders(authOf())
  assert.notEqual(a['X-Request-Id'], b['X-Request-Id'])
  assert.notEqual(a['X-TT-Trace-Id'], b['X-TT-Trace-Id'])
})

test('ugHeaders 带 marketUserId → 输出 X-Market-User-Id', () => {
  const h = ugHeaders(authOf({ marketUserId: '6a22cc18-ab78-4c75-ab8d-04e82afaaaa0' }))
  assert.equal(h['X-Market-User-Id'], '6a22cc18-ab78-4c75-ab8d-04e82afaaaa0')
  assert.equal(h['X-Uid'], '4135677434275728')
})

// ---------------------------------------------------------------------------
// marketUserId 的落盘与补齐（服务端不提供，只能本地生成并持久化）
// ---------------------------------------------------------------------------
test('newMarketUserId 产出 uuid-v4 且每次不同', () => {
  const a = newMarketUserId()
  const b = newMarketUserId()
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, `应为 uuid-v4：${a}`)
  assert.notEqual(a, b, '每次应生成不同 id')
})
test('存量凭证缺失 marketUserId → 自动补齐并落盘（否则该头永远不发）', async () => {
  const { TraeworkSupplier } = await import('./index.ts')
  const saved: Array<Record<string, unknown>> = []
  const creds = {
    list: () => ['u1'],
    get: <T = unknown>(): T => ({
      auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: 0, domain: 'trae.cn', apiHost: '', machineId: 'm', deviceId: 'd' },
      account: { uid: 'u1', enterpriseId: '', nickname: 'u1' },
    }) as T,
    save: (_s: string, _uid: string, blob: unknown) => { saved.push(blob as Record<string, unknown>) },
    remove: () => {},
  }
  const store = {
    get: () => ({ alias: 'traework', disabled: [], custom: [], poolOrder: [], poolStrategy: 'fallback' as const, credits: {} }),
    setAlias: () => {}, setPoolOrder: () => {}, setPoolStrategy: () => {},
    setModelEnabled: () => {}, addCustomModel: () => {}, removeCustomModel: () => {}, setAllModelsEnabled: () => {},
    getCredits: () => -1, putCredits: (_i: string, _u: string, reported: number) => reported, clearCredits: () => {},
  }
  const sup = new TraeworkSupplier({ stateFile: '' }, store, creds, () => {})
  await sup.start()
  sup.dispose()
  assert.equal(saved.length, 1, '应为缺字段的存量凭证补写一次')
  const auth = saved[0]?.auth as Record<string, unknown> | undefined
  const mid = auth?.marketUserId
  assert.equal(typeof mid, 'string', '补齐后应写入 marketUserId')
  assert.match(String(mid), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})
test('已有 marketUserId 的凭证 → 不重复改写', async () => {
  const { TraeworkSupplier } = await import('./index.ts')
  let saves = 0
  const creds = {
    list: () => ['u1'],
    get: <T = unknown>(): T => ({
      auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: 0, domain: 'trae.cn', apiHost: '', machineId: 'm', deviceId: 'd', marketUserId: '6a22cc18-ab78-4c75-ab8d-04e82afaaaa0' },
      account: { uid: 'u1', enterpriseId: '', nickname: 'u1' },
    }) as T,
    save: () => { saves += 1 },
    remove: () => {},
  }
  const store = {
    get: () => ({ alias: 'traework', disabled: [], custom: [], poolOrder: [], poolStrategy: 'fallback' as const, credits: {} }),
    setAlias: () => {}, setPoolOrder: () => {}, setPoolStrategy: () => {},
    setModelEnabled: () => {}, addCustomModel: () => {}, removeCustomModel: () => {}, setAllModelsEnabled: () => {},
    getCredits: () => -1, putCredits: (_i: string, _u: string, reported: number) => reported, clearCredits: () => {},
  }
  const sup = new TraeworkSupplier({ stateFile: '' }, store, creds, () => {})
  await sup.start()
  sup.dispose()
  assert.equal(saves, 0, '已有值不该重复落盘（否则每次启动都换 id，指纹不稳）')
})