/**
 * 签到流程测试 —— node --test 直接跑（Node 24 原生剥 TS 类型）。
 *
 * 锁定的行为（都是实测踩出来的，别改回去）：
 *   - 9074 是**账号级稳定拒绝**（2026-09-02 实测订正，见 upstream.ts），
 *     但保留一次快速重试（1s）兜「上游万一恢复成真抖动」——首次 9074 会
 *     重试一次，落空才判失败（不空耗 8s）
 *   - 9074 重试耗尽才报错，且错误里带 code
 *   - 签到成败以回查 status.checked_in 为准，不靠积分（积分是所有包的聚合
 *     剩余额度，实测签到前后可能是同一个数，拿它判成败会谎报成功）
 *   - 已签到（checked_in=true）是幂等成功，不是失败
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Scheduler } from './scheduler.ts'
import { SoloClient } from './upstream.ts'
import { Pool } from './pool.ts'

/** 构造一个入池账号（credits 只写内存，不落盘）。 */
function makePool(uid: string, a: Auth): Pool {
  const pool = new Pool('')
  pool.add(a)
  return pool
}

type Auth = Parameters<Pool['add']>[0]

function authOf(uid: string): Auth {
  return {
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    domain: 'trae.cn',
    apiHost: '',
    machineId: 'm1',
    deviceId: 'd1',
    uid,
    enterpriseId: '',
    nickname: uid,
    filePath: '',
  }
}

/** 假上游：按脚本依次应答 status / claim 序列，记录调用轨迹。 */
function fakeClient(script: {
  status: Array<Record<string, unknown>>
  claim: Array<Record<string, unknown>>
  usage?: Array<Record<string, unknown>>
  onCall?: (kind: 'status' | 'claim' | 'usage', n: number) => void
}): SoloClient {
  const i = { status: 0, claim: 0, usage: 0 }
  const fetchImpl = async (url: string): Promise<Response> => {
    const u = String(url)
    let body: Record<string, unknown>
    let kind: 'status' | 'claim' | 'usage'
    if (u.endsWith('/checkin_credits/claim')) {
      kind = 'claim'
      body = script.claim[i.claim] ?? { code: 0 }
      script.onCall?.(kind, i.claim)
      i.claim++
    } else if (u.endsWith('/checkin_credits/status')) {
      kind = 'status'
      body = script.status[i.status] ?? { code: 0, checked_in: true, enable: true, credits: 200 }
      script.onCall?.(kind, i.status)
      i.status++
    } else {
      kind = 'usage'
      body = script.usage?.[i.usage] ?? { user_entitlement_pack_list: [] }
      script.onCall?.(kind, i.usage)
      i.usage++
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  return new SoloClient({ fetchImpl: fetchImpl as unknown as typeof fetch, checkinRetryDelayMs: 0, sleep: async () => {} })
}

function makeScheduler(client: SoloClient, pool: Pool, log: string[] = []): Scheduler {
  return new Scheduler({
    pool,
    client,
    checkinHour: 9,
    refreshHours: [3],
    refreshSkewMs: 0,
    saveAuth: () => {},
    log: (m) => log.push(m),
  })
}

const UID = 'u1'

test('9074 首次失败后重试一次即成功', async () => {
  const calls: string[] = []
  const client = fakeClient({
    status: [
      { code: 0, checked_in: false, enable: true, credits: 200 }, // 前置：今日未签
      { code: 0, checked_in: true, enable: true, credits: 200 }, // 回查：已签上
    ],
    claim: [
      { code: 9074, message: '当前参与用户太多，请稍后再试' },
      { code: 0, message: 'success' },
    ],
    onCall: (kind, n) => calls.push(`${kind}#${n}`),
  })
  const pool = makePool(UID, authOf(UID))
  const r = await makeScheduler(client, pool).checkinOne(UID)
  assert.equal(r.status, 'ok')
  assert.equal(r.ok, true)
  // claim 发过两次：第一次 9074，重试后成功
  assert.equal(calls.filter((c) => c.startsWith('claim')).length, 2)
})

test('9074 重试后仍然 9074 → 报错且带 code', async () => {
  const client = fakeClient({
    status: [{ code: 0, checked_in: false, enable: true, credits: 200 }],
    claim: [
      { code: 9074, message: '当前参与用户太多，请稍后再试' },
      { code: 9074, message: '当前参与用户太多，请稍后再试' },
    ],
  })
  const pool = makePool(UID, authOf(UID))
  const r = await makeScheduler(client, pool).checkinOne(UID)
  assert.equal(r.ok, false)
  assert.equal(r.status, 'error')
  assert.match(r.message ?? '', /9074/)
})

test('claim 返回 0 但回查未标记已签到 → 判失败（不谎报成功）', async () => {
  const client = fakeClient({
    status: [
      { code: 0, checked_in: false, enable: true, credits: 200 },
      { code: 0, checked_in: false, enable: true, credits: 200 }, // 回查：没签上
    ],
    claim: [{ code: 0, message: 'success' }],
    usage: [{ user_entitlement_pack_list: [{ entitlement_base_info: { quota: { credits_limit: 200 } }, usage: { credits_amount: 0 } }] }],
  })
  const pool = makePool(UID, authOf(UID))
  const r = await makeScheduler(client, pool).checkinOne(UID)
  assert.equal(r.ok, false)
  assert.equal(r.status, 'error')
  assert.match(r.message ?? '', /未标记已签到/)
})

test('已签到是幂等成功，不是失败', async () => {
  const client = fakeClient({
    status: [{ code: 0, checked_in: true, enable: true, credits: 200 }],
    claim: [],
  })
  const pool = makePool(UID, authOf(UID))
  const r = await makeScheduler(client, pool).checkinOne(UID)
  assert.equal(r.ok, true)
  assert.equal(r.status, 'already')
})

test('enable=false → 未开放，不发 claim', async () => {
  let claimCalls = 0
  const client = fakeClient({
    status: [{ code: 0, checked_in: false, enable: false, credits: 200 }],
    claim: [{ code: 0 }],
    onCall: (kind) => {
      if (kind === 'claim') claimCalls++
    },
  })
  const pool = makePool(UID, authOf(UID))
  const r = await makeScheduler(client, pool).checkinOne(UID)
  assert.equal(r.ok, false)
  assert.equal(r.status, 'disabled')
  assert.equal(claimCalls, 0)
})

test('status 业务 code 非 0 → 报错（上游一律 200，成败只在 code 里）', async () => {
  const client = fakeClient({
    status: [{ code: 1001, message: '认证失败' }],
    claim: [],
  })
  const pool = makePool(UID, authOf(UID))
  const r = await makeScheduler(client, pool).checkinOne(UID)
  assert.equal(r.ok, false)
  assert.equal(r.status, 'error')
  assert.match(r.message ?? '', /1001/)
})

test('积分刷新失败不阻断签到成功', async () => {
  const logs: string[] = []
  const client = fakeClient({
    status: [
      { code: 0, checked_in: true, enable: true, credits: 200 },
    ],
    claim: [],
    usage: [],
  })
  // usage 返回非 JSON 结构 → userEntUsage 算出 0 也不该让签到失败
  const pool = makePool(UID, authOf(UID))
  const r = await makeScheduler(client, pool, logs).checkinOne(UID)
  assert.equal(r.ok, true)
  assert.equal(r.status, 'already')
})
