/**
 * TRAE SOLO auth 解析/序列化。移植自 traework2api/internal/auth/auth.go。
 * 凭证存储由 dsh-router 核心 CredentialStore 统一管，这里只负责格式。
 * 兼容两种磁盘形态：
 *   嵌套形 {"auth":{...},"account":{...}}  （登录脚本产出，现有 trae-*.json）
 *   扁平形 {"accessToken":...,"uid":...}   （手建）
 */

/** 归一化后的账号凭证。可变字段 AccessToken/RefreshToken/ExpiresAt 由调用方加锁保护。 */
export interface Auth {
  accessToken: string
  refreshToken: string
  /** Unix 秒；<=0 表示未知。 */
  expiresAt: number
  domain: string
  apiHost: string
  machineId: string
  deviceId: string
  uid: string
  enterpriseId: string
  nickname: string
  /** 落盘路径；refresh 后原子写回。 */
  filePath: string
}

/** 解析错误：missing accessToken 是硬错误，其余为格式错误。 */
export class AuthParseError extends Error {}

/** 将当前 token 的 JWT（accessToken）快照返回。 */
export function jwt(a: Auth): string {
  return a.accessToken
}

export function refreshTokenValue(a: Auth): string {
  return a.refreshToken
}

/** 报告 token 是否将在 withinMs 内过期（或已过期/无 expiry）。 */
export function needsRefresh(a: Auth, withinMs: number): boolean {
  if (a.expiresAt <= 0) return true
  return Date.now() + withinMs >= a.expiresAt * 1000
}

function parseNested(raw: unknown): Omit<Auth, 'filePath'> {
  const n = raw as {
    auth?: Record<string, unknown>
    account?: Record<string, unknown>
  }
  const auth = n.auth ?? {}
  const account = n.account ?? {}
  const at = String(auth.accessToken ?? '')
  if (at.trim() === '') throw new AuthParseError('parse_error: missing accessToken')
  return {
    accessToken: at,
    refreshToken: String(auth.refreshToken ?? ''),
    expiresAt: Number(auth.expiresAt ?? 0) || 0,
    domain: String(auth.domain ?? ''),
    apiHost: String(auth.apiHost ?? ''),
    machineId: String(auth.machineId ?? ''),
    deviceId: String(auth.deviceId ?? ''),
    uid: String(account.uid ?? ''),
    enterpriseId: String(account.enterpriseId ?? ''),
    nickname: String(account.nickname ?? ''),
  }
}

function parseFlat(raw: unknown): Omit<Auth, 'filePath'> {
  const f = raw as Record<string, unknown>
  const at = String(f.accessToken ?? '')
  if (at.trim() === '') throw new AuthParseError('parse_error: missing accessToken')
  return {
    accessToken: at,
    refreshToken: String(f.refreshToken ?? ''),
    expiresAt: Number(f.expiresAt ?? 0) || 0,
    domain: String(f.domain ?? ''),
    apiHost: String(f.apiHost ?? ''),
    machineId: String(f.machineId ?? ''),
    deviceId: String(f.deviceId ?? ''),
    uid: String(f.uid ?? ''),
    enterpriseId: String(f.enterpriseId ?? ''),
    nickname: String(f.nickname ?? ''),
  }
}

/** 解析 auth 文件内容（嵌套形或扁平形）。 */
export function parseAuth(rawText: string): Omit<Auth, 'filePath'> {
  let obj: unknown
  try {
    obj = JSON.parse(rawText)
  } catch {
    throw new AuthParseError('storage_parse_error: invalid JSON')
  }
  if (obj === null || typeof obj !== 'object') {
    throw new AuthParseError('storage_parse_error: not an object')
  }
  if ('auth' in (obj as Record<string, unknown>)) {
    return parseNested(obj)
  }
  return parseFlat(obj)
}

/** 生成凭证落盘文档（嵌套形）。由 CredentialStore 统一存储。 */
export function toAuthDoc(a: Auth): Record<string, unknown> {
  return {
    auth: {
      accessToken: a.accessToken,
      refreshToken: a.refreshToken,
      expiresAt: a.expiresAt,
      domain: a.domain,
      apiHost: a.apiHost,
      machineId: a.machineId,
      deviceId: a.deviceId,
    },
    account: {
      uid: a.uid,
      enterpriseId: a.enterpriseId,
      nickname: a.nickname,
    },
  }
}
