export type View = 'join' | 'room' | 'game' | 'manual' | 'replays' | 'replay-player' | 'spectator'
export type WorkbenchPanel = 'docs' | 'editor'
export interface RouteExtra { doc?: string; replay?: string; panels?: WorkbenchPanel[] }
export interface JoinProfile { roomCode: string; nick: string; color: string }
const profileKey = 'omb.join'
const views: View[] = ['join', 'room', 'game', 'manual', 'replays', 'replay-player', 'spectator']

export function readRoute(url = new URL(location.href)): { roomCode: string; view: View } & RouteExtra {
  const roomCode = (url.searchParams.get('room') ?? '').toUpperCase()
  const view = url.searchParams.get('view') as View
  return {
    roomCode: /^[A-Z0-9]{4,8}$/.test(roomCode) ? roomCode : '',
    view: views.includes(view) ? view : 'room',
    doc: url.searchParams.get('doc') || undefined,
    replay: url.searchParams.get('replay') || undefined,
    panels: (['docs', 'editor'] as const).filter(panel => (url.searchParams.get('panels') ?? '').split(',').includes(panel)),
  }
}

export function saveProfile(profile: JoinProfile): void {
  try { sessionStorage.setItem(profileKey, JSON.stringify(profile)) } catch { /* storage can be disabled */ }
}

export function loadProfile(roomCode: string): JoinProfile | null {
  try {
    const p = JSON.parse(sessionStorage.getItem(profileKey) ?? 'null') as JoinProfile | null
    return p && p.roomCode === roomCode && typeof p.nick === 'string' && p.nick.trim().length > 0 && p.nick.length <= 16
      && /^#[0-9a-f]{6}$/i.test(p.color) ? p : null
  } catch { return null }
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
