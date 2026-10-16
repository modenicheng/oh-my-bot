export const MAX_FRAME_BYTES = 65536
export const MAX_BATCH_CHILDREN = 64

export function invalid(): never {
  throw new Error('Malformed binary v1 frame')
}

// ignoreBOM preserves a leading U+FEFF, just like protobuf/Go string values.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export class Reader {
  private readonly view: DataView
  private offset = 0

  constructor(private readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  }

  private take(length: number): number {
    if (length > this.data.length - this.offset) invalid()
    const start = this.offset
    this.offset += length
    return start
  }

  u8(): number { return this.view.getUint8(this.take(1)) }
  u16(): number { return this.view.getUint16(this.take(2), true) }
  i16(): number { return this.view.getInt16(this.take(2), true) }
  u32(): number { return this.view.getUint32(this.take(4), true) }
  i32(): number { return this.view.getInt32(this.take(4), true) }

  bytes(length: number): Uint8Array {
    const start = this.take(length)
    return this.data.subarray(start, start + length)
  }

  string(): string { return utf8.decode(this.bytes(this.u16())) }

  bool(): boolean {
    const value = this.u8()
    if (value > 1) invalid()
    return value === 1
  }

  count(minimumBytes: number, maximum = 65535): number {
    const count = this.u16()
    if (count > maximum || count * minimumBytes > this.data.length - this.offset) invalid()
    return count
  }

  end(): void {
    if (this.offset !== this.data.length) invalid()
  }
}
