import { describe, expect, it, vi, afterEach } from 'vitest'
import { clearProfile, loadProfile, readRoute, saveProfile, writeRoute } from './route'

afterEach(() => vi.unstubAllGlobals())

describe('spectator routes', () => {
  it('keeps live and recorded spectator routes distinct', () => {
    expect(readRoute(new URL('http://localhost/?view=live&room=WATCH1'))).toMatchObject({ view: 'live', roomCode: 'WATCH1' })
    expect(readRoute(new URL('http://localhost/?view=spectator&replay=WATCH1-000000001'))).toMatchObject({ view: 'spectator', replay: 'WATCH1-000000001' })
    expect(readRoute(new URL('http://localhost/?view=live&room=../../x'))).toMatchObject({ view: 'live', roomCode: '' })
  })

  it('serializes a live room without player identity, panel or replay state', () => {
    let written = ''
    vi.stubGlobal('location', new URL('http://localhost/?view=game&room=OLDROOM&doc=index.md&replay=OLDROOM-000000001'))
    vi.stubGlobal('history', { replaceState: (_state: unknown, _title: string, url: string) => { written = url } })
    writeRoute('live', 'WATCH1')
    const url = new URL(written)
    expect(Object.fromEntries(url.searchParams)).toEqual({ room: 'WATCH1', view: 'live' })
  })

  it('clears the stored join profile so refresh cannot auto-rejoin', () => {
    const values = new Map<string, string>()
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    })
    const profile = { roomCode: 'LEAVE1', nick: 'pilot', color: '#22d3ee' }
    saveProfile(profile)
    expect(loadProfile('LEAVE1')).toEqual(profile)
    clearProfile()
    expect(loadProfile('LEAVE1')).toBeNull()
  })

  it('round-trips creation-time duration settings through the stored profile', () => {
    const values = new Map<string, string>()
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    })
    saveProfile({ roomCode: 'DURA1', nick: 'pilot', color: '#22d3ee', matchMinutes: 12, coreOpenMinutes: 3 })
    expect(loadProfile('DURA1')).toMatchObject({ matchMinutes: 12, coreOpenMinutes: 3 })
    // 旧 profile / 手改 storage 的非正整数时长：剔除而不是拒绝整个身份。
    values.set('omb.join', JSON.stringify({ roomCode: 'DURA1', nick: 'pilot', color: '#22d3ee', matchMinutes: -2, coreOpenMinutes: 'x' }))
    expect(loadProfile('DURA1')).toEqual({ roomCode: 'DURA1', nick: 'pilot', color: '#22d3ee' })
  })

  it('round-trips the host spectator creation intent without changing read-only routes', () => {
    const values = new Map<string, string>()
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    })
    saveProfile({ roomCode: 'HOST1', nick: 'host', color: '#22d3ee', spectatorMode: true })
    expect(loadProfile('HOST1')).toMatchObject({ spectatorMode: true })
    expect(loadProfile('HOST1')?.spectatorMode).toBe(true)
    expect(readRoute(new URL('http://localhost/?view=live&room=HOST1')).view).toBe('live')
  })
})
