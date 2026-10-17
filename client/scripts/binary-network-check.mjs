// Real Go writer -> TypeScript decoder -> application world, without a mock codec.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import WebSocket from 'ws'
import { create } from '@bufbuild/protobuf'
import {
  BINARY_SUBPROTOCOL, ServerFrameDecoder, isBinarySnapshot, ClientMsgSchema,
  RoomAction_Kind, encodeClient,
} from '../../packages/protocol/src/index.ts'
import { emptyWorld, applySnapshot } from '../src/game/world.ts'
import { parseMapDef } from '../src/game/mapdef.ts'

const work = resolve(process.env.OMB_NETWORK_ARTIFACTS || `../.artifacts/binary-smoke-${Date.now()}`)
mkdirSync(work, { recursive: true })
writeFileSync(resolve(work, 'config.yaml'), 'ai:\n  enabled: false\nauth:\n  enabled: false\n')
const port = Number(process.env.OMB_NETWORK_PORT || 28973)
const base = `http://127.0.0.1:${port}`
const server = spawn(resolve(process.env.OMB_BINARY || '../server/omb.exe'), ['-addr', `127.0.0.1:${port}`], {
  cwd: work, stdio: ['ignore', 'ignore', 'pipe'],
  env: { ...process.env, OMB_CONFIG_DIR: work, AUTH_ENABLED: 'false', OMB_DEFAULT_SOLO_BOTS: '0' },
})
let failure
server.on('error', error => { failure = error })
server.stderr.on('data', bytes => {
  if (String(bytes).includes('compact snapshot encoding failed')) failure = new Error(String(bytes))
})
const clients = []
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(test, label) {
  const end = Date.now() + 20000
  while (Date.now() < end) {
    if (failure) throw failure
    if (server.exitCode !== null) throw new Error(`server exited: ${server.exitCode}`)
    if (await test()) return
    await pause(20)
  }
  throw new Error(`timed out: ${label}`)
}

async function connect({ compact = true, spectator = false, nick = 'binary-check' } = {}) {
  const socket = new WebSocket(`${base.replace('http:', 'ws:')}/ws`, compact ? [BINARY_SUBPROTOCOL] : [])
  const decoder = new ServerFrameDecoder()
  const state = { socket, world: emptyWorld(), frames: {}, messages: 0, snapshots: 0, fulls: 0, room: false, versions: 0, largeControls: 0 }
  clients.push(state)
  const send = payload => socket.send(encodeClient(create(ClientMsgSchema, { payload })))
  state.send = send
  socket.on('error', error => { failure = error })
  socket.on('message', bytes => {
    try {
      state.frames[bytes[0]] = (state.frames[bytes[0]] || 0) + 1
      if (bytes[0] === 3 && bytes.length > 65536) state.largeControls++
      if (bytes[0] === 0) { socket.send(Uint8Array.of(1, ...bytes.subarray(1))); return }
      const messages = decoder.decode(bytes)
      assert.ok(messages.length, `valid server frame failed TS decoding: ${bytes.subarray(0, 24).toString('hex')}`)
      state.messages += messages.length
      for (const message of messages) {
        if (message.payload.case === 'event') {
          const event = message.payload.value.kind
          if (event.case === 'roomState') state.room = true
          if (event.case === 'scriptVersions') state.versions = event.value.versions.length
          if (event.case === 'mapBootstrap') {
            state.world = emptyWorld()
            state.world.staticMap = parseMapDef(event.value.mapJson)
          }
        }
        if (message.payload.case === 'snapshot') {
          const snapshot = message.payload.value
          assert.equal(isBinarySnapshot(snapshot), compact)
          assert.equal(applySnapshot(state.world, snapshot), 'applied')
          state.snapshots++
          if (snapshot.full) state.fulls++
        }
      }
    } catch (error) { failure = error }
  })
  await once(socket, 'open')
  assert.equal(socket.protocol, compact ? BINARY_SUBPROTOCOL : '')
  assert.equal(socket.extensions, '', 'no general compression extension')
  send({ case: spectator ? 'spectate' : 'join', value: { roomCode: 'BINCHK', nick, color: '#12abef' } })
  await until(() => state.room, 'join acknowledgement')
  return state
}

try {
  await until(() => fetch(`${base}/healthz`).then(response => response.ok).catch(() => false), 'server ready')
  const host = await connect()
  const legacy = await connect({ compact: false, nick: 'legacy-check' })
  const spectator = await connect({ spectator: true })
  host.send({ case: 'roomAction', value: { kind: RoomAction_Kind.WARMUP } })
  await until(() => clients.every(client => client.world.tick > 90), 'all clients apply warmup snapshots')
  assert.ok(host.world.timeLeftS > 65535, '24-hour warmup survives the wire')
  assert.ok(host.world.localMap?.partial, 'compact player reconstructs local metadata')
  assert.notEqual(host.world.self?.inputGeneration, undefined, 'optional input-generation contract survives')
  assert.equal(spectator.world.self, undefined)
  assert.equal(spectator.world.localMap, undefined, 'spectator keeps full static map')
  assert.ok(spectator.world.robots.size >= host.world.robots.size)
  const fulls = host.fulls
  host.send({ case: 'resyncRequest', value: {} })
  await until(() => host.fulls > fulls, 'reliable compact resync full')
  assert.ok(host.frames[4] > 0 && spectator.frames[4] > 0)
  assert.equal(legacy.frames[4], undefined)
  assert.equal(legacy.frames[5], undefined)
  for (let i = 0; i < 3; i++) {
    host.send({ case: 'scriptSubmit', value: { clientScriptId: i + 1, source: `function tick(bot) {}\n/*${'x'.repeat(24 * 1024)}*/` } })
    await until(() => host.versions === i + 1, 'reliable script history')
  }
  assert.ok(host.largeControls > 0, 'large script histories remain standalone reliable controls')
  console.log(JSON.stringify(clients.map(({ frames, messages, snapshots, fulls, world }) => ({
    frames, messages, snapshots, fulls, tick: world.tick, robots: world.robots.size,
  })), null, 2))
  console.log('binary network integration passed: compact + legacy + spectator + resync + large history')
} finally {
  for (const { socket } of clients) socket.terminate()
  if (server.exitCode === null) {
    const exited = once(server, 'exit')
    server.kill()
    await exited
  }
}
