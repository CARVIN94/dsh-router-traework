/**
 * 流式转换回归测试 —— 锁死 SOLO SSE → OpenAI SSE 的 tool_call 行为。
 *
 * 关键坑（2026-09-02 实测）：SOLO 把工具参数**分帧下发**，首帧带 name，
 * 续帧只有 arguments。normalizeToolCalls 曾把「没有 name 的帧」一律当垃圾
 * 丢掉 → 续帧参数丢失 → 下游在 [DONE] 判 EMPTY_RESPONSE
 * （"upstream closed the stream before 1 tool call argument was complete"）。
 * 现在按 index 记录已见首帧，续帧放行，只有真垃圾（无 function / 显式空名 /
 * 没见过 index 的首帧）才丢。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { TraeworkSupplier } from './index.ts'
import type { SupplierConfigStoreLike, CredentialStoreLike } from '../contract.ts'

function fakeStore(): SupplierConfigStoreLike {
  return {
    get: () => ({ alias: 'traework', disabled: [], custom: ['glm-5.2'], poolOrder: [], poolStrategy: 'fallback' }),
    setAlias: () => {},
    setPoolOrder: () => {},
    setPoolStrategy: () => {},
    setModelEnabled: () => {},
    addCustomModel: () => {},
    removeCustomModel: () => {},
    setAllModelsEnabled: () => {},
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

/** 构造一个 SOLO SSE 响应体（output 帧序列 + done）。 */
function soloSSE(outputs: string[], finish = 'tool_calls'): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  const frames = outputs.map((o) => `event: output\ndata: ${o}\n\n`)
  frames.push(`event: done\ndata: {"finish_reason":"${finish}"}\n\n`)
  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const f of frames) ctrl.enqueue(enc.encode(f))
      ctrl.close()
    },
  })
}

/** 跑一次流式 chatOnce，返回按 index 分组的 tool_call arguments 片段。 */
async function streamToolArgs(outputs: string[]): Promise<Array<{ index: number; args: string }>> {
  const creds = fakeCreds()
  creds.save('traework', 'u1', {
    auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Math.floor(Date.now() / 1000) + 48 * 3600, domain: 'trae.cn', apiHost: '', machineId: 'm', deviceId: 'd' },
    account: { uid: 'u1', enterpriseId: '', nickname: 'u1' },
  })
  const origFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(soloSSE(outputs), { status: 200 })) as typeof fetch
  const sup = new TraeworkSupplier({ stateFile: '' }, fakeStore(), creds, () => {})
  await sup.start()
  try {
    const r = await sup.chatOnce('u1', {
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
    const out: Array<{ index: number; args: string }> = []
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ')) continue
      const payload = line.slice(6).trim()
      if (payload === '[DONE]') continue
      const obj = JSON.parse(payload) as { choices?: Array<{ delta?: { tool_calls?: Array<{ index?: number; function?: { arguments?: string } }> } }> }
      const tcs = obj.choices?.[0]?.delta?.tool_calls
      for (const tc of tcs ?? []) {
        if (typeof tc.function?.arguments === 'string') {
          out.push({ index: tc.index ?? 0, args: tc.function.arguments })
        }
      }
    }
    return out
  } finally {
    sup.dispose()
    globalThis.fetch = origFetch
  }
}

/** 按 index 拼接 arguments（模拟下游累积）。 */
function joinByIndex(fragments: Array<{ index: number; args: string }>): string[] {
  const byIdx = new Map<number, string>()
  for (const f of fragments) byIdx.set(f.index, (byIdx.get(f.index) ?? '') + f.args)
  return [...byIdx.keys()].sort((a, b) => a - b).map((i) => byIdx.get(i) ?? '')
}

test('分帧 tool_call：续帧（无 name）放行，参数完整拼接', async () => {
  const args = await streamToolArgs([
    '{"response":"","tool_calls":[{"index":0,"id":"call_1","function_call":{"name":"bash","arguments":"{\\"command\\":"}}]}',
    '{"response":"","tool_calls":[{"index":0,"function_call":{"arguments":" \\"ls\\"}"}}]}',
  ])
  assert.deepEqual(joinByIndex(args), ['{"command": "ls"}'], '续帧参数不能丢')
})

test('单帧完整 tool_call：原样透传', async () => {
  const args = await streamToolArgs([
    '{"response":"","tool_calls":[{"index":0,"id":"call_1","function_call":{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}}]}',
  ])
  assert.deepEqual(joinByIndex(args), ['{"command":"ls"}'])
})

test('垃圾 tool_call：无 function 的帧被丢弃', async () => {
  const args = await streamToolArgs([
    '{"response":"","tool_calls":[{"index":0,"id":"call_1"}]}',
    '{"response":"","tool_calls":[{"index":0,"function_call":{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}}]}',
  ])
  // 首帧无 function 是垃圾，但第二帧带名字是合法首帧 → 放行
  assert.deepEqual(joinByIndex(args), ['{"command":"ls"}'])
})

test('垃圾 tool_call：没见过 index 的无名首帧被丢弃', async () => {
  const args = await streamToolArgs([
    '{"response":"","tool_calls":[{"index":0,"function_call":{"arguments":"{\\"command\\":"}}]}',
  ])
  assert.equal(args.length, 0, '无名的垃圾首帧不应转发')
})

test('垃圾 tool_call：显式空名首帧被丢弃', async () => {
  const args = await streamToolArgs([
    '{"response":"","tool_calls":[{"index":0,"function_call":{"name":"","arguments":"{\\"command\\":\\"ls\\"}"}}]}',
  ])
  assert.equal(args.length, 0, '空名首帧不应转发')
})

test('多个 tool_call 并行分帧：各自按 index 拼接', async () => {
  const args = await streamToolArgs([
    '{"response":"","tool_calls":[{"index":0,"id":"c0","function_call":{"name":"bash","arguments":"{\\"command\\":"}},{"index":1,"id":"c1","function_call":{"name":"read","arguments":"{\\"path\\":"}}]}',
    '{"response":"","tool_calls":[{"index":0,"function_call":{"arguments":" \\"ls\\"}"}},{"index":1,"function_call":{"arguments":" \\"/tmp\\"}"}}]}',
  ])
  assert.deepEqual(joinByIndex(args), ['{"command": "ls"}', '{"path": "/tmp"}'])
})
