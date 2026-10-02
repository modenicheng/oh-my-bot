/** 二进制是版本来源；开发构建和请求失败显示 dev。 */
export function appVersionLabel(value: string | null | undefined): string {
  if (!value || value === 'dev') return 'dev'
  return value.startsWith('v') ? value : `v${value}`
}

/** 启动时异步读取，不阻塞手势和音频解锁。 */
export async function initAppVersion(): Promise<void> {
  const footer = document.getElementById('app-version')
  if (!footer) return
  try {
    const res = await fetch('/api/version')
    if (!res.ok) return
    const payload: unknown = await res.json()
    const version =
      typeof payload === 'object' && payload !== null && 'version' in payload
        ? payload.version
        : undefined
    if (typeof version !== 'string' || version.length === 0 || version.length > 64) return
    footer.textContent = appVersionLabel(version)
  } catch {
    // 版本查询失败不影响进入游戏，保留初始 dev 文案。
  }
}
