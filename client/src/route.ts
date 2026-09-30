export type View = 'join' | 'room' | 'game' | 'manual' | 'replays' | 'replay-player'
export interface JoinProfile { roomCode: string; nick: string; color: string }
const profileKey = 'omb.join'
const views: View[] = ['join', 'room', 'game', 'manual', 'replays', 'replay-player']

export function readRoute(url = new URL(location.href)): { roomCode: string; view: View; doc?: string; replay?: string } {
  const roomCode = (url.searchParams.get('room') ?? '').toUpperCase()
  const view = url.searchParams.get('view') as View
  return {
    roomCode: /^[A-Z0-9]{4,8}$/.test(roomCode) ? roomCode : '',
    view: views.includes(view) ? view : 'room',
    doc: url.searchParams.get('doc') || undefined,
    replay: url.searchParams.get('replay') || undefined,
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

export function writeRoute(view: View, roomCode?: string, extra?: { doc?: string; replay?: string }): void {
  const url = new URL(location.href)
  if (roomCode) url.searchParams.set('room', roomCode)
  url.searchParams.set('view', view)
  if (view !== 'manual') url.searchParams.delete('doc')
  else if (extra?.doc) url.searchParams.set('doc', extra.doc)
  if (view !== 'replay-player') url.searchParams.delete('replay')
  else if (extra?.replay) url.searchParams.set('replay', extra.replay)
  history.replaceState(null, '', url)
}
