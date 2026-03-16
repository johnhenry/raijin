import { describe, it, expect } from 'vitest'
import { encode, decode } from '../src/encoding.js'

const encoder = new TextEncoder()

describe('DA encoding', () => {
  it('roundtrips data through encode/decode', async () => {
    const data = encoder.encode('hello world')
    const encoded = await encode(data)
    const decoded = await decode(encoded)

    expect(Buffer.from(decoded).toString()).toBe('hello world')
  })

  it('prepends a 3-byte magic header', async () => {
    const data = encoder.encode('test')
    const encoded = await encode(data)

    // Should start with either RJC (compressed) or RJR (raw)
    const magic = encoded.slice(0, 3)
    const raw = new Uint8Array([0x52, 0x4a, 0x52])   // "RJR"
    const comp = new Uint8Array([0x52, 0x4a, 0x43])   // "RJC"

    const isRaw = magic[0] === raw[0] && magic[1] === raw[1] && magic[2] === raw[2]
    const isComp = magic[0] === comp[0] && magic[1] === comp[1] && magic[2] === comp[2]
    expect(isRaw || isComp).toBe(true)
  })

  it('decode rejects data shorter than 3 bytes', async () => {
    await expect(decode(new Uint8Array([0x01, 0x02]))).rejects.toThrow('too short')
  })

  it('decode rejects unknown magic bytes', async () => {
    await expect(decode(new Uint8Array([0xff, 0xfe, 0xfd, 0x00]))).rejects.toThrow('unknown magic')
  })

  it('handles empty data', async () => {
    const data = new Uint8Array(0)
    const encoded = await encode(data)
    const decoded = await decode(encoded)

    expect(decoded.length).toBe(0)
  })
})
