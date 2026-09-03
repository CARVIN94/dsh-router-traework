/**
 * 复现：真实 SOLO 上游 tool_calls 的多种形态下，normalizeToolCalls 是否丢帧。
 * 参照 trae-solo-local-api 的 llmUtilsChunkToOpenAI：上游 tool_calls 元素可带
 * 顶层 name/arguments/params/input/tool_name，也可嵌套 function/function_call。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { TraeworkSupplier } from './index.ts'
import type { SupplierConfigStoreLike, CredentialStoreLike } from '../contract.ts'

function fakeStore(): SupplierConfigStoreLike {
  return {
    get: () => ({ alias: 'traework', disabled: [], custom: ['glm-5.2'], poolOrder: [], poolStrategy: 'fallback' }),
    setAlias: () => {}, setPoolOrder: () => {}, setPoolStrategy: () => {},
    setModelEnabled: () => {}, addCustomModel: () => {}, removeCustomModel: () => {},
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
function soloSSE(outputs: string[], finish = 'tool_calls'): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  const frames = outputs.map((o) => `event: output\ndata: ${o}\n\n`)
  frames.push(`event: done\ndata: {"finish_reason":"${finish}"}\n\n`)
  return new ReadableStream<Uint8Array>({
    start(ctrl) { for (const f of frames) ctrl.enqueue(enc.encode(f)); ctrl.close() },
  })
}
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
    const r = await sup.chatOnce('u1', { model: 'glm-5.2', stream: true, rawBody: JSON.stringify({ model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }], stream: true }) })
    assert.equal(r.ok, true, JSON.stringify(r))
    if (!('stream' in r)) throw new Error('expected stream')
    const reader = r.stream.getReader()
    const dec = new TextDecoder()
    let text = ''
    for (;;) { const { done, value } = await reader.read(); if (done) break; text += dec.decode(value, { stream: true }) }
    const out: Array<{ index: number; args: string }> = []
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ')) continue
      const payload = line.slice(6).trim()
      if (payload === '[DONE]') continue
      const obj = JSON.parse(payload) as { choices?: Array<{ delta?: { tool_calls?: Array<{ index?: number; function?: { arguments?: string } }> } }> }
      for (const tc of obj.choices?.[0]?.delta?.tool_calls ?? []) {
        if (typeof tc.function?.arguments === 'string') out.push({ index: tc.index ?? 0, args: tc.function.arguments })
      }
    }
    return out
  } finally {
    sup.dispose()
    globalThis.fetch = origFetch
  }
}
function joinByIndex(fragments: Array<{ index: number; args: string }>): string[] {
  const byIdx = new Map<number, string>()
  for (const f of fragments) byIdx.set(f.index, (byIdx.get(f.index) ?? '') + f.args)
  return [...byIdx.keys()].sort((a, b) => a - b).map((i) => byIdx.get(i) ?? '')
}

test('形态A：顶层 name+arguments 分帧（trae-solo-local-api 支持的真实形态）', async () => {
  const args = await streamToolArgs([
    '{"response":"","tool_calls":[{"index":0,"id":"call_1","name":"bash","arguments":"{\\"command\\":"}]}',
    '{"response":"","tool_calls":[{"index":0,"arguments":" \\"ls\\"}"}]}',
  ])
  assert.deepEqual(joinByIndex(args), ['{"command": "ls"}'], '顶层 name/arguments 分帧不应丢')
})

test('形态B：顶层 name+params 分帧', async () => {
  const args = await streamToolArgs([
    '{"response":"","tool_calls":[{"index":0,"id":"call_1","name":"bash","params":"{\\"command\\":"}]}',
    '{"response":"","tool_calls":[{"index":0,"params":" \\"ls\\"}"}]}',
  ])
  assert.deepEqual(joinByIndex(args), ['{"command": "ls"}'], '顶层 name/params 分帧不应丢')
})

test('形态C：function 首帧 + 顶层 arguments 续帧（混合形态）', async () => {
  const args = await streamToolArgs([
    '{"response":"","tool_calls":[{"index":0,"id":"call_1","function":{"name":"bash","arguments":"{\\"command\\":"}}]}',
    '{"response":"","tool_calls":[{"index":0,"arguments":" \\"ls\\"}"}]}',
  ])
  assert.deepEqual(joinByIndex(args), ['{"command": "ls"}'], '混合形态续帧不应丢')
})

test('形态D：partial_arguments 承载参数（不应被 delete 掉）', async () => {
  const args = await streamToolArgs([
    '{"response":"","tool_calls":[{"index":0,"id":"call_1","function_call":{"name":"bash","partial_arguments":"{\\"command\\":"}}]}',
    '{"response":"","tool_calls":[{"index":0,"function_call":{"partial_arguments":" \\"ls\\"}"}}]}',
  ])
  assert.deepEqual(joinByIndex(args), ['{"command": "ls"}'], 'partial_arguments 不应被丢弃')
})
