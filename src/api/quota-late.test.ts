/**
 * 流内业务码分类 + 迟到失败上报回归测试。
 *
 * 背景（2026-09-08 实测）：TRAE 对「该账号没这个模型的配额」发 **HTTP 200
 * + 流内 `event: error code=4008`**。三个号里两个如此，其中一个面板还有
 * 200 积分（说明这个配额与积分余额无关）。
 *
 * 修复前 `kind()` 只认 1005，4008 落进 `'client'` → 核心按 `unknown` 只冷
 * 30s，且流式失败压根没上报给核心 —— 坏号一直留在池里被轮转选中，
 * round-robin 下 2/3 请求直接失败。
 *
 * 这里锁死两件事：
 *   1. 4008 归类为 plan_limit（→ 契约状态 quota → 核心冷 10 分钟）
 *   2. 流式路径经 env.onLateFailure 把 (uid, model, state) 报给核心
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { TraeworkSupplier } from './index.ts'
import { classify, SoloStreamError } from './upstream.ts'
import type { SupplierConfigStoreLike, CredentialStoreLike, SupplierEnvLike, AccountState } from '../contract.ts'

function fakeStore(): SupplierConfigStoreLike {
  return {
    get: () => ({ alias: 'traework', disabled: [], custom: ['glm-5.2'], poolOrder: [], poolStrategy: 'fallback', credits: {} }),
    setAlias: () => {},
    setPoolOrder: () => {},
    setPoolStrategy: () => {},
    setModelEnabled: () => {},
    addCustomModel: () => {},
    removeCustomModel: () => {},
    setAllModelsEnabled: () => {},
    getCredits: () => -1,
    putCredits: (_i: string, _u: string, reported: number) => reported,
    clearCredits: () => {},
  }
}

function fakeCreds(): CredentialStoreLike {
  const map = new Map<string, unknown>()
  return {
    list: () => [...map.keys()],
    get: <T = unknown>(_s: string, uid: string): T | undefined => map.get(uid) as T | undefined,
    save: (_s, uid, blob) => { map.set(uid, blob) },
    remove: (_s, uid) => { map.delete(uid) },
  }
}

/** 一条流内 error 帧（HTTP 200，错误藏在流里）。 */
function soloErrorSSE(code: number, msg: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(enc.encode(`event: error\ndata: {"code":${code},"message":"${msg}"}\n\n`))
      ctrl.close()
    },
  })
}

/** 跑一次流式 chatOnce，收集：读到的全部文本 + onLateFailure 上报记录。 */
async function runStream(code: number, msg: string): Promise<{
  text: string
  reports: Array<{ uid: string; model: string; state: AccountState; message: string }>
}> {
  const creds = fakeCreds()
  creds.save('traework', 'u1', {
    auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Math.floor(Date.now() / 1000) + 48 * 3600, domain: 'trae.cn', apiHost: '', machineId: 'm', deviceId: 'd' },
    account: { uid: 'u1', enterpriseId: '', nickname: 'u1' },
  })
  const reports: Array<{ uid: string; model: string; state: AccountState; message: string }> = []
  const env: SupplierEnvLike = {
    onLateFailure: (uid, model, state, message) => { reports.push({ uid, model, state, message }) },
  }
  const origFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(soloErrorSSE(code, msg), { status: 200 })) as typeof fetch
  const sup = new TraeworkSupplier({ stateFile: '' }, fakeStore(), creds, () => {}, env)
  await sup.start()
  try {
    const r = await sup.chatOnce('u1', 'auto', {
      model: 'glm-5.2',
      stream: true,
      rawBody: JSON.stringify({ model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    assert.equal(r.ok, true, JSON.stringify(r))
    if (!('stream' in r)) throw new Error('expected stream')
    const reader = r.stream.getReader()
    const dec = new TextDecoder()
    let text = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      text += dec.decode(value, { stream: true })
    }
    return { text, reports }
  } finally {
    sup.dispose()
    globalThis.fetch = origFetch
  }
}

test('code=4008 归类为 plan_limit（不是 client）', () => {
  assert.equal(new SoloStreamError(4008, 'quota').kind(), 'plan_limit')
  assert.equal(new SoloStreamError(1005, 'plan').kind(), 'plan_limit')
  // 真·客户端错误不能被误判成额度问题
  assert.equal(new SoloStreamError(4001, 'bad param').kind(), 'client')
})

test('classify 对非 2xx 响应体里的额度码同样判定 plan_limit', () => {
  assert.equal(classify(200, '{"code":4008,"message":"exceeded"}'), 'plan_limit')
  assert.equal(classify(200, '{"code":1005,"message":"plan"}'), 'plan_limit')
  assert.equal(classify(429, '{"code":9999}'), 'soft_rate')
  assert.equal(classify(404, 'not found'), 'not_found')
})

test('流式 4008：错误帧如实吐给客户端（不是空响应）', async () => {
  const { text } = await runStream(4008, 'Your requests have exceeded the quota.')
  assert.ok(text.includes('code=4008'), `错误信息必须对客户端可见: ${text}`)
  assert.ok(text.includes('quota'), `错误原因要带着: ${text}`)
  assert.ok(text.includes('[DONE]'), '必须有终止帧')
})

test('流式 4008：经 onLateFailure 上报核心（uid + 模型 + quota）', async () => {
  const { reports } = await runStream(4008, 'Your requests have exceeded the quota.')
  assert.equal(reports.length, 1, '只上报一次（不能每个 chunk 报一次）')
  assert.equal(reports[0]!.uid, 'u1')
  assert.equal(reports[0]!.model, 'glm-5.2', '模型 id 要剥掉供应商前缀')
  assert.equal(reports[0]!.state, 'quota', '4008 → plan_limit → 契约状态 quota')
  assert.ok(reports[0]!.message.includes('4008'))
})

test('没有 onLateFailure 通道时不炸（老核心退化成只记日志）', async () => {
  const creds = fakeCreds()
  creds.save('traework', 'u1', {
    auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Math.floor(Date.now() / 1000) + 48 * 3600, domain: 'trae.cn', apiHost: '', machineId: 'm', deviceId: 'd' },
    account: { uid: 'u1', enterpriseId: '', nickname: 'u1' },
  })
  const origFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(soloErrorSSE(4008, 'quota'), { status: 200 })) as typeof fetch
  const sup = new TraeworkSupplier({ stateFile: '' }, fakeStore(), creds, () => {})
  await sup.start()
  try {
    const r = await sup.chatOnce('u1', 'auto', {
      model: 'glm-5.2',
      stream: true,
      rawBody: JSON.stringify({ model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    assert.equal(r.ok, true)
  } finally {
    sup.dispose()
    globalThis.fetch = origFetch
  }
})
