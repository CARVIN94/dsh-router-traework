/**
 * 模型名录与 function 回放测试 —— node --test 直接跑。
 *
 * 锁定的行为（2026-10-10 对真实上游实测得出，别改回去）：
 *
 *   1. **上游把可调用名录按 function 拆开**，一个模型只有用「列出它的那个
 *      function」才调得动。只发 solo_work_lite 时实测 7 个模型 HTTP 200 但流内
 *      `code=4001`（参数无效）——看起来像请求写错了，实际是「这个 function 不
 *      服务这个模型」。改成回放各自归属的 function 后全部正常出内容。
 *   2. **context_length 必须落盘**，单位是 K（核心 comboContextWindow 换算回
 *      token）。此前 fetchModels 恒填 `contextWindow: 0`，于是核心那条
 *      `if (m.contextWindow > 0)` 永不成立 → 窗口永远拿不到 → 自动压缩一直跳过。
 *   3. **roster 以远端名录为骨架**：详细表并集里有一半是内部件
 *      （title_generation / fast_apply / search_agent_* / *-auto …），不该进
 *      模型选择器；远端名录正是厂商给用户看的那一份。
 *   4. 远端名录**拿不到**时退回「主 function 一家的表」（历史行为），而不是把
 *      并集原样端出去。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { SoloClient, prepareBody } from './upstream.ts'
import type { Auth } from './auth.ts'

const auth: Auth = {
  accessToken: 'at', refreshToken: 'rt', expiresAt: 0, domain: 'trae.cn',
  apiHost: '', machineId: 'm', deviceId: '1711320556112436', uid: 'u1',
  enterpriseId: '', nickname: 'u1', filePath: '',
}

/** 详细表一行（只放本测试关心的字段）。 */
function detail(configName: string, dev: number, maxTokens: number, displayName = configName, isCustom = false) {
  return {
    config_name: configName,
    context_window_tokens: { dev },
    model_detail_list: [{ max_tokens: maxTokens }],
    display_config: { display_name: displayName, is_custom_model: isCustom },
  }
}

type Route = { detail?: Record<string, unknown[]>; remote?: unknown; remoteStatus?: number; chat?: (body: Record<string, unknown>) => unknown }

/** 装一个假上游：/get_detail_param 按 function 回表，/models 回远端名录，llm_utils_chat 记录收到的 body。 */
function installFake(route: Route): { restore: () => void; chats: Array<Record<string, unknown>> } {
  const orig = globalThis.fetch
  const chats: Array<Record<string, unknown>> = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url)
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    if (u.includes('/api/remote/v1/models')) {
      return new Response(JSON.stringify(route.remote ?? { data: { list: [] } }), { status: route.remoteStatus ?? 200 })
    }
    if (u.includes('/api/ide/v1/get_detail_param')) {
      const fn = String(body.function ?? '')
      return new Response(JSON.stringify({ config_info_list: route.detail?.[fn] ?? [] }), { status: 200 })
    }
    if (u.includes('/llm_utils_chat')) {
      chats.push(body)
      return new Response(route.chat ? JSON.stringify(route.chat(body)) : '{}', { status: 200 })
    }
    // 凭据刷新：chatOnce 会在 token 临到期时先刷一次，这里给个可用的新 token
    if (u.includes('ExchangeToken')) {
      return new Response(JSON.stringify({ Result: { Token: 'fresh-at', TokenExpireAt: Date.now() + 86400_000 } }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  return { restore: () => { globalThis.fetch = orig }, chats }
}

test('fetchModels：远端名录做骨架，详细表补归属 function 与窗口', async () => {
  const { restore } = installFake({
    detail: {
      solo_work_lite: [detail('glm-5.2', 200000, 32000, 'GLM-5.2'), detail('glm-5-turbo', 200000, 32000, 'GLM-5-Turbo')],
      solo_agent_remote: [detail('glm-5.1', 200000, 32000, 'GLM-5.1')],
      // 其它 function 独有的内部件：不该进模型选择器
      chat_v3: [detail('title_generation', 200000, 1000, 'Title')],
    },
    remote: {
      data: {
        list: [
          { function: 'solo_work_lite', models: [{ name: 'glm-5.2', display_name: 'GLM-5.2', context_window_tokens: { dev: 200000 } }] },
          { function: 'solo_agent_remote', models: [{ name: 'glm-5.1', display_name: 'GLM-5.1', context_window_tokens: { dev: 200000 } }] },
        ],
      },
    },
  })
  try {
    const models = await new SoloClient({ timeoutSeconds: 5 }).fetchModels(auth)
    const ids = models.map((m) => m.id)
    // 远端名录的两行在最前（顺序按厂商）
    assert.deepEqual(ids.slice(0, 2), ['glm-5.2', 'glm-5.1'])
    // 归属 function = 列出它的那一家，chat 必须回放它
    assert.equal(models[0]?.function, 'solo_work_lite')
    assert.equal(models[1]?.function, 'solo_agent_remote', 'glm-5.1 归属 solo_agent_remote，不能报成默认值')
    assert.equal(models[0]?.contextWindow, 200000)
    assert.equal(models[0]?.maxTokens, 32000)
    // 主 function 独有的行**保留**（纯增量：不从用户手里拿走今天还能用的模型）
    assert.ok(ids.includes('glm-5-turbo'), '主 function 原有的模型一个都不能少')
    // 其它 function 独有的内部件不进
    assert.equal(ids.includes('title_generation'), false, '内部件不该进模型选择器')
  } finally {
    restore()
  }
})

test('fetchModels：远端名录拿不到 → 退回主 function 一家的表（不是并集）', async () => {
  const { restore } = installFake({
    remoteStatus: 500,
    detail: {
      solo_work_lite: [detail('glm-5.2', 200000, 32000)],
      solo_agent_remote: [detail('glm-5.1', 200000, 32000), detail('search_agent_qwen_fast', 200000, 1000)],
    },
  })
  try {
    const models = await new SoloClient({ timeoutSeconds: 5 }).fetchModels(auth)
    assert.deepEqual(models.map((m) => m.id), ['glm-5.2'], '只回主 function 那一家，别把内部件并集端出去')
    assert.equal(models[0]?.contextWindow, 200000)
  } finally {
    restore()
  }
})

test('fetchModels：同一模型在多组出现 → 窗口取最大（上游分组顺序不稳定）', async () => {
  const { restore } = installFake({
    remote: {
      data: {
        list: [
          { function: 'solo_work_remote', models: [{ name: 'Doubao-Seed-2.1-Pro', display_name: 'x', context_window_tokens: { dev: 116000 } }] },
          { function: 'chat_v3', models: [{ name: 'Doubao-Seed-2.1-Pro', display_name: 'x', context_window_tokens: { dev: 256000 } }] },
        ],
      },
    },
    detail: { solo_work_lite: [detail('Doubao-Seed-2.1-Pro', 256000, 32000, 'x')] },
  })
  try {
    const models = await new SoloClient({ timeoutSeconds: 5 }).fetchModels(auth)
    assert.equal(models.length, 1)
    assert.equal(models[0]?.contextWindow, 256000, '同一模型取更宽的那个，别让面板窗口随分组顺序变化')
  } finally {
    restore()
  }
})

test('prepareBody：显式 function 覆盖默认值；不传则回落默认', () => {
  const body = JSON.stringify({ model: 'glm-5.1', messages: [] })
  assert.equal(JSON.parse(prepareBody(body, 'solo_agent_remote')).function, 'solo_agent_remote')
  assert.equal(JSON.parse(prepareBody(body)).function, 'solo_work_lite', '不传时保持历史默认')
})

test('chat 回放归属 function：模型不属于默认 function 时按登记的 function 发出', async () => {
  const { TraeworkSupplier } = await import('./index.ts')
  const creds = {
    list: () => ['u1'],
    get: <T = unknown>(): T => ({
      auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Math.floor(Date.now() / 1000) + 3600, domain: 'trae.cn', apiHost: '', machineId: 'm', deviceId: '1711320556112436' },
      account: { uid: 'u1', enterpriseId: '', nickname: 'u1' },
    }) as T,
    save: () => {},
    remove: () => {},
  }
  const store = {
    get: () => ({ alias: 'traework', disabled: [], custom: [], poolOrder: [], poolStrategy: 'fallback' as const, credits: {} }),
    setAlias: () => {}, setPoolOrder: () => {}, setPoolStrategy: () => {},
    setModelEnabled: () => {}, addCustomModel: () => {}, removeCustomModel: () => {}, setAllModelsEnabled: () => {},
    getCredits: () => -1, putCredits: (_i: string, _u: string, reported: number) => reported, clearCredits: () => {},
  }
  const fake = installFake({
    detail: { solo_agent_remote: [detail('glm-5.1', 200000, 32000, 'GLM-5.1')] },
    remote: {
      data: { list: [{ function: 'solo_agent_remote', models: [{ name: 'glm-5.1', display_name: 'GLM-5.1', context_window_tokens: { dev: 200000 } }] }] },
    },
    chat: () => ({ choices: [{ message: { role: 'assistant', content: 'x' } }] }),
  })
  try {
    const sup = new TraeworkSupplier({ stateFile: '' }, store, creds, () => {})
    await sup.start()
    // 先拉一次模型表，登记归属
    await sup.listModels()
    const r = await sup.chatOnce('u1', 'auto', {
      model: 'glm-5.1',
      stream: true,
      rawBody: JSON.stringify({ model: 'glm-5.1', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(fake.chats[0]?.function, 'solo_agent_remote', '必须回放该模型自己的 function，否则上游回 4001')
    sup.dispose()
  } finally {
    fake.restore()
  }
})

test('listModels 落 context_length（契约单位 K），不再是 0', async () => {
  const { TraeworkSupplier } = await import('./index.ts')
  const creds = {
    list: () => ['u1'],
    get: <T = unknown>(): T => ({
      auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Math.floor(Date.now() / 1000) + 3600, domain: 'trae.cn', apiHost: '', machineId: 'm', deviceId: '1711320556112436' },
      account: { uid: 'u1', enterpriseId: '', nickname: 'u1' },
    }) as T,
    save: () => {},
    remove: () => {},
  }
  const store = {
    get: () => ({ alias: 'traework', disabled: [], custom: [], poolOrder: [], poolStrategy: 'fallback' as const, credits: {} }),
    setAlias: () => {}, setPoolOrder: () => {}, setPoolStrategy: () => {},
    setModelEnabled: () => {}, addCustomModel: () => {}, removeCustomModel: () => {}, setAllModelsEnabled: () => {},
    getCredits: () => -1, putCredits: (_i: string, _u: string, reported: number) => reported, clearCredits: () => {},
  }
  const fake = installFake({
    detail: { solo_work_lite: [detail('glm-5.2', 256000, 32000, 'GLM-5.2')] },
    remote: {
      data: { list: [{ function: 'solo_work_lite', models: [{ name: 'glm-5.2', display_name: 'GLM-5.2', context_window_tokens: { dev: 256000 } }] }] },
    },
  })
  try {
    const sup = new TraeworkSupplier({ stateFile: '' }, store, creds, () => {})
    await sup.start()
    const models = await sup.listModels()
    const hit = models.find((m) => m.id === 'glm-5.2')
    assert.equal(hit?.context_length, 256, '256000 token → 256K（核心按 K 存，换算回 token）')
    sup.dispose()
  } finally {
    fake.restore()
  }
})

/**
 * 闲置账号的 accessToken 早就过期了（实测本机三个号全是），而「获取模型」这条
 * 路以前**不刷 token**：拿旧 token 打上游 → 401 → catch 吞掉 → 返回空列表。
 * 用户看到的是「点了获取模型没反应」，完全看不出是 token 的锅。
 *
 * 同类欠账三处：获取模型 / 拉积分 / 签到（只有 chatOnce 刷）。签到那处已单独
 * 锁住，这里锁获取模型这条最容易被点到的路。
 */
test('获取模型前先刷过期 token（闲置号不该静默拿到空列表）', async () => {
  const { TraeworkSupplier } = await import('./index.ts')
  const calls: string[] = []
  const orig = globalThis.fetch
  globalThis.fetch = (async (url: string) => {
    const u = String(url)
    if (u.endsWith('/oauth/ExchangeToken')) {
      calls.push('refresh')
      return new Response(JSON.stringify({ Result: { Token: 'fresh-at', TokenExpireAt: Date.now() + 86400_000 } }), { status: 200 })
    }
    if (u.includes('/api/remote/v1/models')) {
      calls.push('remote')
      return new Response(JSON.stringify({ data: { list: [{ function: 'solo_work_lite', models: [{ name: 'glm-5.2', display_name: 'GLM-5.2', context_window_tokens: { dev: 200000 } }] }] } }), { status: 200 })
    }
    if (u.includes('/api/ide/v1/get_detail_param')) {
      calls.push('detail')
      return new Response(JSON.stringify({ config_info_list: [detail('glm-5.2', 200000, 32000, 'GLM-5.2')] }), { status: 200 })
    }
    return new Response(JSON.stringify({ user_entitlement_pack_list: [] }), { status: 200 })
  }) as typeof fetch
  const creds = {
    list: () => ['u1'],
    // expiresAt 已过期 → needsRefresh 必然为真
    get: <T = unknown>(): T => ({
      auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: 1, domain: 'trae.cn', apiHost: '', machineId: 'm', deviceId: '1711320556112436' },
      account: { uid: 'u1', enterpriseId: '', nickname: 'u1' },
    }) as T,
    save: () => {},
    remove: () => {},
  }
  const store = {
    get: () => ({ alias: 'traework', disabled: [], custom: [], poolOrder: [], poolStrategy: 'fallback' as const, credits: {} }),
    setAlias: () => {}, setPoolOrder: () => {}, setPoolStrategy: () => {},
    setModelEnabled: () => {}, addCustomModel: () => {}, removeCustomModel: () => {}, setAllModelsEnabled: () => {},
    getCredits: () => -1, putCredits: (_i: string, _u: string, reported: number) => reported, clearCredits: () => {},
  }
  try {
    const sup = new TraeworkSupplier({ stateFile: '' }, store, creds, () => {})
    await sup.start()
    calls.length = 0
    const models = await sup.listModels(true)
    assert.equal(calls[0], 'refresh', '拉模型前必须先刷 token，否则静默拿到空表')
    assert.ok(models.some((m) => m.id === 'glm-5.2'), '刷完要真的拿到模型')
    sup.dispose()
  } finally {
    globalThis.fetch = orig
  }
})
