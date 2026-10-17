export type View = 'join' | 'room' | 'game' | 'manual' | 'replays' | 'replay-player' | 'spectator' | 'live'
export type WorkbenchPanel = 'docs' | 'editor' | 'snippets' | 'ai'
export interface RouteExtra { doc?: string; replay?: string; panels?: WorkbenchPanel[] }
/** 建房时长设置（分钟；仅在创建房间时上送生效，undefined = 服务器默认）。 */
export interface JoinDurations { matchMinutes?: number; coreOpenMinutes?: number }
export interface JoinProfile extends JoinDurations { roomCode: string; nick: string; color: string; spectatorMode?: boolean }
const profileKey = 'omb.join'
const views: View[] = ['join', 'room', 'game', 'manual', 'replays', 'replay-player', 'spectator', 'live']

export function readRoute(url = new URL(location.href)): { roomCode: string; view: View } & RouteExtra {
  const roomCode = (url.searchParams.get('room') ?? '').toUpperCase()
  const view = url.searchParams.get('view') as View
  return {
    roomCode: /^[A-Z0-9]{4,8}$/.test(roomCode) ? roomCode : '',
    view: views.includes(view) ? view : 'room',
    doc: url.searchParams.get('doc') || undefined,
    replay: url.searchParams.get('replay') || undefined,
    panels: (['docs', 'editor', 'snippets', 'ai'] as const).filter(panel => (url.searchParams.get('panels') ?? '').split(',').includes(panel)),
  }
}

export function saveProfile(profile: JoinProfile): void {
  try { sessionStorage.setItem(profileKey, JSON.stringify(profile)) } catch { /* storage can be disabled */ }
}

export function clearProfile(): void {
  try { sessionStorage.removeItem(profileKey) } catch { /* storage can be disabled */ }
}

export function loadProfile(roomCode: string): JoinProfile | null {
  try {
    const p = JSON.parse(sessionStorage.getItem(profileKey) ?? 'null') as JoinProfile | null
    return p && p.roomCode === roomCode && typeof p.nick === 'string' && p.nick.trim().length > 0 && p.nick.length <= 16
      && /^#[0-9a-f]{6}$/i.test(p.color) ? validDurations(p) : null
  } catch { return null }
}

/** 时长字段宽松校验：非正整数剔除（旧 profile / 手改 storage），保持 undefined 语义。 */
function validDurations(p: JoinProfile): JoinProfile {
  const out: JoinProfile = { roomCode: p.roomCode, nick: p.nick, color: p.color }
  if (p.spectatorMode === true) out.spectatorMode = true
  if (Number.isInteger(p.matchMinutes) && (p.matchMinutes as number) > 0) out.matchMinutes = p.matchMinutes
  if (Number.isInteger(p.coreOpenMinutes) && (p.coreOpenMinutes as number) > 0) out.coreOpenMinutes = p.coreOpenMinutes
  return out
}

export function writeRoute(view: View, roomCode?: string, extra?: RouteExtra): void {
  const url = new URL(location.href)
  if (roomCode) url.searchParams.set('room', roomCode)
  url.searchParams.set('view', view)
  if (view !== 'manual' && view !== 'game') url.searchParams.delete('doc')
  else if (extra?.doc) url.searchParams.set('doc', extra.doc)
  if (view === 'game' && extra?.panels?.length) url.searchParams.set('panels', extra.panels.join(','))
  else url.searchParams.delete('panels')
  if ((view === 'replay-player' || view === 'spectator') && extra?.replay) url.searchParams.set('replay', extra.replay)
  else url.searchParams.delete('replay')
  history.replaceState(null, '', url)
}
