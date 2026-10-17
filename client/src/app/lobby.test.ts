// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EvRoomState_State, RoomAction_Kind } from '@omb/protocol'
import { Lobby } from './lobby'

const html = readFileSync('client/index.html', 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')

function fixture(nick = 'host') {
  document.body.innerHTML = html.match(/<body[^>]*>([\s\S]*)<\/body>/)![1]!
  const join = vi.fn(), roomAction = vi.fn()
  const lobby = new Lobby({ selfNick: () => nick, inGame: () => false, join, roomAction, watchLive: vi.fn() })
  return { lobby, join, roomAction }
}

afterEach(() => document.body.replaceChildren())

describe('host spectator lobby', () => {
  it('saves the creation toggle in the submitted join profile and clears it with identity', () => {
    const { lobby, join } = fixture()
    lobby.restore({ roomCode: 'HOST01', nick: 'host', color: '#22d3ee', spectatorMode: true })
    document.getElementById('btn-join')!.click()
    expect(join).toHaveBeenCalledWith(expect.objectContaining({ spectatorMode: true, roomCode: 'HOST01' }))
    lobby.clearIdentity()
    expect((document.getElementById('in-spectator-mode') as HTMLInputElement).checked).toBe(false)
  })

  it('uses the server mode only for the matching local host and resets it before another join', () => {
    const { lobby } = fixture()
    lobby.update(EvRoomState_State.R_IDLE, 'host', 0, 0, false, true)
    expect(lobby.isHostSpectator).toBe(true)
    expect(document.getElementById('room-state')?.textContent).toContain('真人 0 · 观战主持')
    lobby.update(EvRoomState_State.R_IDLE, 'another-host', 1, 0, false, true)
    expect(lobby.isHostSpectator).toBe(false)
    lobby.beginJoin('NEXT01')
    expect(lobby.isHostSpectator).toBe(false)
  })

  it('retains host commands with no player seat and displays the server roster error', () => {
    const { lobby, roomAction } = fixture()
    lobby.update(EvRoomState_State.R_IDLE, 'host', 0, 0, false, true)
    expect(document.getElementById('btn-start')!.hidden).toBe(false)
    document.getElementById('btn-start')!.click()
    document.getElementById('btn-solo-bots')!.click()
    expect(roomAction.mock.calls.map(call => call[0])).toEqual([RoomAction_Kind.START, RoomAction_Kind.SOLO_BOTS])
    lobby.showRoomError('至少需要一名真人参赛者或自动 Bot')
    expect(document.getElementById('room-error')!.hidden).toBe(false)
    expect(document.getElementById('room-error')!.textContent).toContain('至少需要')
  })
})
