import { fromBinary } from '@bufbuild/protobuf'
import { ServerMsgSchema, type ServerMsg, type SnapshotDelta } from '../gen/proto/omb_pb'
import { invalid, MAX_BATCH_CHILDREN, MAX_FRAME_BYTES, Reader } from './reader'
import { readSnapshot } from './snapshot'
import { copyBaseline, emptyBaseline, type Baseline } from './state'

export const BINARY_SUBPROTOCOL = 'omb.binary.v1'
export const FRAME_SNAPSHOT = 4
export const FRAME_BATCH = 5

const binarySnapshots = new WeakSet<SnapshotDelta>()

/** Compact snapshots have no map JSON; clients project their static bootstrap map. */
export function isBinarySnapshot(snapshot: SnapshotDelta): boolean {
  return binarySnapshots.has(snapshot)
}

function readChild(data: Uint8Array, state: Baseline): { message: ServerMsg; state: Baseline } {
  if (data[0] === 3) {
    const message = fromBinary(ServerMsgSchema, data.subarray(1))
    if ((message.payload.case === 'snapshot' && message.payload.value.full) ||
      (message.payload.case === 'event' && message.payload.value.kind.case === 'mapBootstrap')) state = emptyBaseline()
    return { message, state }
  }
  if (data[0] !== FRAME_SNAPSHOT) invalid()
  const reader = new Reader(data)
  reader.u8()
  const result = readSnapshot(reader, state)
  return { message: { $typeName: 'omb.v1.ServerMsg', payload: { case: 'snapshot', value: result.snapshot } }, state: result.state }
}

export class ServerFrameDecoder {
  private state = emptyBaseline()

  reset(): void { this.state = emptyBaseline() }

  decode(data: Uint8Array): ServerMsg[] {
    // Preserve legacy control acceptance; only new compact/batch framing has
    // a realtime size budget. A batch's outer bound also bounds its children.
    if (data.length === 0 || data[0] !== 3 && data.length > MAX_FRAME_BYTES) return []
    try {
      let state = copyBaseline(this.state)
      const messages: ServerMsg[] = []
      const compact: SnapshotDelta[] = []
      const child = (bytes: Uint8Array) => {
        const result = readChild(bytes, state)
        state = result.state
        messages.push(result.message)
        if (bytes[0] === FRAME_SNAPSHOT && result.message.payload.case === 'snapshot') compact.push(result.message.payload.value)
      }
      if (data[0] === FRAME_BATCH) {
        const reader = new Reader(data)
        reader.u8()
        if (reader.u8() !== 1) invalid()
        const count = reader.count(4, MAX_BATCH_CHILDREN)
        for (let i = 0; i < count; i++) child(reader.bytes(reader.u32()))
        reader.end()
      } else {
        child(data)
      }
      // Neither caller-visible messages nor baseline/reset/gap state escape a
      // failed batch. Internal records never alias these published messages.
      this.state = state
      for (const snapshot of compact) binarySnapshots.add(snapshot)
      return messages
    } catch {
      return []
    }
  }
}
