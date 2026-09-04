/**
 * 积分（ide_user_ent_usage）计算测试。
 *
 * 锁定的行为（都是 2026-09-03/04 抓包实测踩出来的）：
 *   - 请求体必须是 {require_usage:true,req_source:2}，不是 {}（真实客户端实测值）
 *   - 过期包必须跳过：签到积分是**当日发放、31 天后过期**的独立包，
 *     不过滤就是把历史所有签到包的额度累加进「剩余」，面板越签越多
 *   - credits_amount 是**已用**，剩余 = limit - used，且不为负
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { SoloClient } from './upstream.ts'

type Auth = Parameters<SoloClient['userEntUsage']>[0]

function authOf(): Auth {
  return {
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAt: 0,
    domain: 'trae.cn',
    apiHost: '',
    machineId: 'm1',
    deviceId: '1711320556112436',
    uid: 'u1',
    enterpriseId: '',
    nickname: 'u1',
    filePath: '',
  }
}

/** 造一个假上游，记录请求体并回指定响应。 */
function clientWith(body: unknown): { client: SoloClient; bodies: string[] } {
  const bodies: string[] = []
  const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
    bodies.push(String(init?.body ?? ''))
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  return { client: new SoloClient({ fetchImpl: fetchImpl as unknown as typeof fetch }), bodies }
}

/** 造一个权益包。end 为 Unix 秒；不传 = 不过期。 */
function pack(limit: number, used: number, end?: number): Record<string, unknown> {
  return {
    entitlement_base_info: { quota: { credits_limit: limit }, end_time: end ?? 0 },
    usage: { credits_amount: used },
  }
}

test('请求体带 require_usage/req_source（真实客户端实测值）', async () => {
  const { client, bodies } = clientWith({ user_entitlement_pack_list: [] })
  await client.userEntUsage(authOf())
  assert.deepEqual(JSON.parse(bodies[0] ?? '{}'), { require_usage: true, req_source: 2 })
})

test('剩余积分 = Σ(limit - used)，跨包累加', async () => {
  const { client } = clientWith({
    user_entitlement_pack_list: [pack(2000, 200.8772), pack(2000, 1595.5964)],
  })
  const remain = await client.userEntUsage(authOf())
  assert.ok(Math.abs(remain - 2203.5264) < 1e-6, `got ${remain}`)
})

test('过期包不计入剩余（签到包 31 天过期，不滤会越签越多）', async () => {
  const past = Math.floor(Date.now() / 1000) - 3600
  const future = Math.floor(Date.now() / 1000) + 3600
  const { client } = clientWith({
    user_entitlement_pack_list: [
      pack(200, 0, past), // 昨天发的签到包 → 已过期，跳过
      pack(200, 0, future), // 今天发的签到包 → 计入
    ],
  })
  const remain = await client.userEntUsage(authOf())
  assert.equal(remain, 200, `过期的 200 不该算进去，got ${remain}`)
})

test('end_time 缺失/0 → 视作不过期（老包结构没有该字段）', async () => {
  const { client } = clientWith({
    user_entitlement_pack_list: [pack(500, 100)],
  })
  assert.equal(await client.userEntUsage(authOf()), 400)
})

test('已用超过额度 → 该包记 0，不倒扣', async () => {
  const { client } = clientWith({
    user_entitlement_pack_list: [pack(100, 150), pack(500, 0)],
  })
  assert.equal(await client.userEntUsage(authOf()), 500, '负值会被 clamp 到 0')
})

test('无积分包（额度型订阅，如免费包）→ 剩余 0 且不炸', async () => {
  const { client } = clientWith({ user_entitlement_pack_list: [] })
  assert.equal(await client.userEntUsage(authOf()), 0)
})
