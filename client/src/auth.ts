// OIDC 登录态管理（服务端 server/internal/auth 配套）：自签 HMAC token 的
// 存取与解码 + 服务端开关探测。token 格式 b64(payload).b64(sig)，载荷
// sub/name/exp；存 localStorage（跨会话保持登录），WS 以 ?token= 查询参数
// 过升级门禁（浏览器 WebSocket API 无法自定义请求头）。服务端未启用认证时
// /auth/status 404，全部入口自然隐藏，行为与未接入认证一致。
// 登录流程：/auth/login → IdP → /auth/callback → 302 /?token=…，本模块在
// 启动时把 token 落入存储并立即清洗地址栏（服务端已设 Referrer-Policy）。

const TOKEN_KEY = 'omb.oidc.token'

/** 时钟偏移容忍：exp 前 30s 内即视为过期（本机时钟略快于签发端）。 */
const EXPIRY_SLACK_MS = 30_000

export interface AuthClaims {
  sub: string
  name: string
  exp: number
}

/** 解码 token 载荷（不验签——签名校验只在服务端有意义）；格式非法返回 null。 */
export function decodeToken(token: string): AuthClaims | null {
  const pRaw = token.split('.')[0]
  if (!pRaw) return null
  try {
    const b64 = pRaw.replace(/-/g, '+').replace(/_/g, '/')
    const json = new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)))
    const p = JSON.parse(json) as Partial<AuthClaims>
    if (typeof p.sub !== 'string' || !p.sub || typeof p.name !== 'string' || typeof p.exp !== 'number') return null
    return { sub: p.sub, name: p.name, exp: p.exp }
  } catch {
    return null
  }
}

/** 从 ?token= 提取登录 token（纯函数便于单测）；无/畸形返回 null。 */
export function extractTokenFromSearch(search: string): string | null {
  const token = new URLSearchParams(search).get('token')
  return token && token.includes('.') ? token : null
}

/** 启动调用一次：登录回跳的 ?token= 落入 localStorage 并立即清洗地址栏。 */
export function consumeTokenFromURL(): void {
  const token = extractTokenFromSearch(location.search)
  if (!token) return
  try {
    localStorage.setItem(TOKEN_KEY, token)
  } catch { /* storage 可被禁用；本次会话退化为未登录 */ }
  const url = new URL(location.href)
  url.searchParams.delete('token')
  history.replaceState(null, '', url)
}

function storedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

/** 清除登录态（无服务端会话，本地清除即登出）。 */
export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY)
  } catch { /* ignore */ }
}

/** 有效登录 claims（未过期）；否则 null。 */
export function validClaims(now = Date.now()): AuthClaims | null {
  const token = storedToken()
  if (!token) return null
  const claims = decodeToken(token)
  if (!claims || claims.exp * 1000 - EXPIRY_SLACK_MS <= now) return null
  return claims
}

/** WS 拨号附加的认证查询串；无 token 时为空串。 */
export function wsAuthQuery(): string {
  const token = storedToken()
  return token ? `?token=${encodeURIComponent(token)}` : ''
}

/** 服务端是否启用认证；404（旧服务器）/网络错误一律视为未启用。 */
export async function fetchAuthEnabled(): Promise<boolean> {
  try {
    const res = await fetch('/auth/status', { cache: 'no-store' })
    if (!res.ok) return false
    const body = await res.json() as { enabled?: boolean }
    return body.enabled === true
  } catch {
    return false
  }
}

/** 登录入口；带当前房码让 IdP 往返后表单自动恢复。 */
export function loginHref(roomCode = ''): string {
  return roomCode ? `/auth/login?room=${encodeURIComponent(roomCode)}` : '/auth/login'
}
