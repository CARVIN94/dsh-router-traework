/**
 * TRAE SOLO 登录流程（移植自 traework2api/login.sh）：
 *   生成 machine/device id → 构造登录 URL → 用户浏览器登录 →
 *   回调 127.0.0.1:18080/authorize?refreshToken=...&userInfo=... → 粘贴回来 →
 *   解析回调 → ExchangeToken → GetUserInfo → 落盘 auths/trae-{uid}.json。
 */
import { randomBytes } from 'node:crypto'
import { SOLO } from './constants.ts'

/** 生成 hex32 machine id（真实客户端 machine_id 就是 32 字节 hex，抓包实证）。 */
export function randomId(): string {
  return randomBytes(16).toString('hex')
}

/**
 * 生成 16 位纯数字 device id。
 *
 * 形态必须对齐真实客户端（2026-09-03 抓包实测 x-device-id = `1711320556112436`，
 * 16 位纯数字）。旧实现发 hex32，在风控眼里根本不是一个设备号——
 * TRAE-Automatic-sign-in 也注明「必须用 16 位数字 Aha 设备号，用 GUID/UUID 会
 * 触发 9074」。
 *
 * **16 位要均匀随机，不能用 `10^15 + rand` 那种写法**：后者把高位钉死在
 * `1xxxxx`，批量生成的号摆一起共享可识别的前缀（实测迁移出来的三个号前几位
 * 都是 107/113/117），等于主动给风控递「同一生成器批发」的特征。
 * 首位取 1-9（不能是 0，否则不是 16 位），后 15 位逐位均匀取 0-9。
 */
export function newDeviceId(): string {
  const digits = randomBytes(16)
  let out = String(1 + (digits[0]! % 9)) // 首位 1-9，保证恰好 16 位
  for (let i = 1; i < 16; i++) out += String(digits[i]! % 10)
  return out
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
