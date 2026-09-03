/**
 * TRAE SOLO 登录流程（移植自 traework2api/login.sh）：
 *   生成 machine/device id → 构造登录 URL → 用户浏览器登录 →
 *   回调 127.0.0.1:18080/authorize?refreshToken=...&userInfo=... → 粘贴回来 →
 *   解析回调 → ExchangeToken → GetUserInfo → 落盘 auths/trae-{uid}.json。
 */
import { randomBytes } from 'node:crypto'
import { SOLO } from './constants.ts'

/** 生成 hex32 machine/device id。 */
export function randomId(): string {
  return randomBytes(16).toString('hex')
}

/**
 * 生成 X-Market-User-Id 用的 uuid-v4。
 *
 * 这个 id **服务端不提供**：抓包翻遍 315 条流的响应体都没有它，auth.ts 也注明
 * 是「TRAE 客户端本地为该账号分配的标识」。所以它只能由本插件在登录时生成，
 * 并随凭证**持久化**——每次请求现生成会破坏指纹稳定性（真实客户端对同一账号
 * 始终发同一个值，请求头突变的账号更容易被风控盯上）。
 */
export function newMarketUserId(): string {
  const b = randomBytes(16)
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** 构造登录 URL（带新 machine/device id）。 */
export function buildLoginUrl(machineId: string, deviceId: string): string {
  const params = new URLSearchParams({
    login_version: '1',
    auth_from: 'solo',
    login_channel: 'native_ide',
    plugin_version: '2.3.62834',
    auth_type: 'local',
    client_id: SOLO.ClientID,
    redirect: '0',
    login_trace_id: randomBytes(8).toString('hex'),
    auth_callback_url: 'http://127.0.0.1:18080/authorize',
    machine_id: machineId,
    device_id: deviceId,
    x_device_id: deviceId,
    x_machine_id: machineId,
    x_device_brand: 'PC',
    x_device_type: 'PC',
    x_os_version: '1.0',
    x_app_version: SOLO.IdeVersion,
    x_app_type: 'stable',
  })
  return `${SOLO.ConsoleHost}/authorization?${params.toString()}`
}

function parseJsonParam(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined
  for (const val of [raw, decodeURIComponent(raw)]) {
    try {
      const obj = JSON.parse(val) as Record<string, unknown>
      if (obj !== null && typeof obj === 'object') return obj
    } catch {
      // 尝试下一层
    }
  }
  return undefined
}

/** 从回调 URL 提取登录凭证。 */
export interface LoginCallbackData {
  refreshToken: string
  userInfo: Record<string, unknown>
  userJwt: Record<string, unknown>
}

/** 解析回调链接（parse_qs + unquote 处理 URL 编码）。 */
export function parseLoginCallback(callbackUrl: string): LoginCallbackData {
  const qs = new URLSearchParams(callbackUrl.split('?')[1] ?? '')
  return {
    refreshToken: qs.get('refreshToken') ?? '',
    userInfo: parseJsonParam(qs.get('userInfo') ?? undefined) ?? {},
    userJwt: parseJsonParam(qs.get('userJwt') ?? undefined) ?? {},
  }
}
