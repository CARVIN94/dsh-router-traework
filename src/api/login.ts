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
