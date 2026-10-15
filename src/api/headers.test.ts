/**
 * ugHeaders 头部对齐测试：锁定与真实客户端一致的头集合（2026-09-03 抓包实测）。
 * marketUserId 相关用例见文件末尾（该 id 服务端不提供，需本地生成并持久化）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ugHeaders, isRealDeviceId } from './upstream.ts'
import { SOLO, CLIENT_UA } from './constants.ts'
import { newMarketUserId, newDeviceId } from './login.ts'

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
  assert.equal(h['X-Device-Brand'], SOLO.DeviceBrand)
  assert.equal(h['X-Device-Type'], 'windows')
  assert.equal(h['X-Device-Id'], 'd1')
  assert.equal(h['App-Version'], SOLO.IdeVersion)
  // 无 marketUserId → 不带该头
  assert.equal(h['X-Market-User-Id'], undefined)
})

// ---------------------------------------------------------------------------
// 身份一致性（2026-09-04 订正：抓包里签到/积分走 VSCode 插件进程，
// 与 IDE 主进程的 Trae/0.1.61、TraeClient/TTNet 是三套不同 UA）
// ---------------------------------------------------------------------------
test('ugHeaders 用 VSCode 插件进程身份，不用 IDE 主进程的 Trae/x.y', () => {
  const h = ugHeaders(authOf())
  assert.equal(h['User-Agent'], 'VSCode 1.107.1 (TRAE SOLO CN)')
  assert.notEqual(h['User-Agent'], CLIENT_UA, '签到链路不是 IDE 主进程')
  // X-Market-Client-Id 与 UA 同源但不带 CN 后缀
  assert.equal(h['X-Market-Client-Id'], 'VSCode 1.107.1')
  assert.equal(h['Accept'], '*/*', '实测值是 */*，不是 application/json')
  assert.equal(h['Sec-Fetch-Mode'], 'no-cors', '实测值是 no-cors，不是 cors')
})

test('ugHeaders 不发 X-Uid（真实签到请求没有该头）', () => {
  const h = ugHeaders(authOf())
  assert.equal(h['X-Uid'], undefined, '多一个上游没见过的头 = 指纹异常')
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
})

// ---------------------------------------------------------------------------
// deviceId 形态（2026-09-04 订正：真实客户端是 16 位纯数字，不是 hex32）
// ---------------------------------------------------------------------------
test('newDeviceId 产出 16 位纯数字', () => {
  for (let i = 0; i < 20; i++) {
    assert.match(newDeviceId(), /^\d{16}$/)
  }
})

test('批量生成的 deviceId 没有共享前缀（别给风控递「批发」特征）', () => {
  // 旧实现 `10^15 + rand(9e14)` 把高位钉死在 1xxxxx，三个号放一起
  // 前几位清一色 107/113/117 —— 一眼看出是同一个生成器批量产的。
  //
  // 注意：**不能**断言「任意两号公共前缀 <= N」。随机数字串本就会偶然撞前缀
  // （生日问题：2000 个样本里出现 6 位公共前缀是正常的），这种断言会假红。
  // 真正能抓住旧缺陷的是**分布**：首位必须铺满 1-9，且每多匹配一位，
  // 数量应约 ÷10（旧实现的首位只有 1，这条直接就挂）。
  const ids = Array.from({ length: 2000 }, () => newDeviceId())
  // 首位铺满 1-9 且大致均匀
  const firsts = new Map<string, number>()
  for (const s of ids) firsts.set(s[0]!, (firsts.get(s[0]!) ?? 0) + 1)
  assert.equal(firsts.size, 9, `首位只出现了 ${[...firsts.keys()].sort().join('')}，分布太窄`)
  for (const [d, n] of firsts) {
    assert.ok(n > ids.length / 9 / 3, `首位 ${d} 只出现 ${n} 次，偏斜`)
  }
  // 公共前缀长度按 ~10 倍衰减（高位确实被随机到了）
  const byLen = new Array<number>(17).fill(0)
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      let k = 0
      while (k < 16 && ids[i]![k] === ids[j]![k]) k++
      byLen[k]!++
    }
  }
  assert.ok(byLen[0]! > 0, '样本异常')
  for (let k = 1; k <= 3; k++) {
    const ratio = byLen[k]! / byLen[k - 1]!
    assert.ok(ratio > 0.05 && ratio < 0.2, `前缀长度 ${k} 占比 ${ratio.toFixed(3)}，未呈 ~1/10 衰减`)
  }
  assert.equal(new Set(ids).size, ids.length, '2000 个号不该撞号')
})

test('newDeviceId 首位不为 0（否则不足 16 位）', () => {
  for (let i = 0; i < 50; i++) {
    assert.notEqual(newDeviceId()[0], '0')
  }
})

test('isRealDeviceId 只认 15~16 位纯数字', () => {
  assert.equal(isRealDeviceId('1711320556112436'), true)
  assert.equal(isRealDeviceId(newDeviceId()), true)
  // hex32 是历史遗留形态，必须被判为「需要迁移」
  assert.equal(isRealDeviceId('a'.repeat(32)), false)
  assert.equal(isRealDeviceId('171132055611243'), true, '15 位合法（wild-work 就是这个长度）')
  assert.equal(isRealDeviceId('17113205561124'), false, '14 位不够')
  assert.equal(isRealDeviceId('17113205561124367'), false, '17 位太长')
  assert.equal(isRealDeviceId('d1'), false)
  assert.equal(isRealDeviceId(''), false)
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
test('marketUserId + deviceId 都合规 → 不重复改写', async () => {
  const { TraeworkSupplier } = await import('./index.ts')
  let saves = 0
  const creds = {
    list: () => ['u1'],
    get: <T = unknown>(): T => ({
      auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: 0, domain: 'trae.cn', apiHost: '', machineId: 'm', deviceId: '1711320556112436', marketUserId: '6a22cc18-ab78-4c75-ab8d-04e82afaaaa0' },
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

test('存量 hex32 deviceId → 迁移成 16 位纯数字并落盘一次', async () => {
  const { TraeworkSupplier } = await import('./index.ts')
  const saved: Array<Record<string, unknown>> = []
  const creds = {
    list: () => ['u1'],
    get: <T = unknown>(): T => ({
      auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: 0, domain: 'trae.cn', apiHost: '', machineId: 'm', deviceId: 'a'.repeat(32), marketUserId: '6a22cc18-ab78-4c75-ab8d-04e82afaaaa0' },
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
  assert.equal(saved.length, 1, 'hex32 存量凭证应迁移一次')
  const auth = saved[0]?.auth as Record<string, unknown> | undefined
  assert.match(String(auth?.deviceId), /^\d{16}$/, `迁移后应是 16 位纯数字：${String(auth?.deviceId)}`)
})