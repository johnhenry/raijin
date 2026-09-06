import { describe, it, expect } from 'vitest'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import {
  encode,
  decode,
  MAX_DECOMPRESSED_SIZE,
  DADecodeError,
  DASizeLimitError,
  type Inflate,
} from '../src/encoding.js'

const encoder = new TextEncoder()

/**
 * A real raw-DEFLATE codec, so the compressed branch is exercised with
 * genuine compressed data rather than a stand-in.
 *
 * fflate is an *optional* dependency and is not installed here, so without an
 * injected codec `encode()` never compresses and `decode()` never reaches its
 * inflate path — the entire compressed frame, including every size guard on
 * it, would go untested. `DecodeOptions.inflate` is the seam that exists for
 * exactly this: an environment where the optional fflate import does not
 * resolve. fflate's `deflateSync`/`inflateSync` produce and consume raw
 * DEFLATE, which is what `node:zlib`'s `*Raw` functions produce and consume,
 * so this is the same wire format the shipped default would handle.
 */
const deflate = (data: Uint8Array): Uint8Array =>
  new Uint8Array(deflateRawSync(Buffer.from(data.buffer, data.byteOffset, data.byteLength)))

/**
 * A *bounded* inflater, matching the contract `Inflate` documents: it refuses
 * to produce more than `limit` bytes rather than inflating first and checking
 * after. This is what the shipped fflate adapter does with its `out` buffer.
 */
const boundedInflate: Inflate = (data, limit) =>
  new Uint8Array(
    inflateRawSync(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
      maxOutputLength: limit,
    }),
  )

/** An inflater that ignores its bound — the shape of the original bug. */
const unboundedInflate: Inflate = (data) =>
  new Uint8Array(inflateRawSync(Buffer.from(data.buffer, data.byteOffset, data.byteLength)))

const codec = { deflate, inflate: boundedInflate }

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

  // ── Compressed frames ───────────────────────────────────────────────

  describe('compressed frames', () => {
    it('roundtrips a compressible payload through the compressed branch', async () => {
      const data = new Uint8Array(64 * 1024).fill(0x41)
      const encoded = await encode(data, codec)

      // "RJC" — the compressed branch really was taken.
      expect(Array.from(encoded.subarray(0, 3))).toEqual([0x52, 0x4a, 0x43])
      expect(encoded.length).toBeLessThan(data.length)

      const decoded = await decode(encoded, codec)
      expect(decoded).toEqual(data)
    })

    it('falls back to a raw frame when compression would not save space', async () => {
      // Random bytes do not compress; the frame must not grow.
      const data = new Uint8Array(1024)
      for (let i = 0; i < data.length; i++) data[i] = (i * 7919) % 256
      const incompressible = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data))
      const encoded = await encode(incompressible, codec)

      expect(Array.from(encoded.subarray(0, 3))).toEqual([0x52, 0x4a, 0x52]) // "RJR"
      expect(await decode(encoded, codec)).toEqual(incompressible)
    })
  })

  // ── Decompression bomb ──────────────────────────────────────────────
  //
  // decode() runs on bytes that came off a DA layer, which is to say off the
  // network from whoever chose to post them. DEFLATE reaches ~1000:1, so a
  // few kilobytes can ask for gigabytes. See issue #24.
  describe('decompression limits', () => {
    /** 64 MiB of zeros — compresses to a few tens of KiB. A real bomb. */
    function makeBomb(): { data: Uint8Array; uncompressedSize: number } {
      const uncompressedSize = 64 * 1024 * 1024
      const bomb = new Uint8Array(uncompressedSize)
      const compressed = deflate(bomb)
      // Sanity: this is only a bomb if it is genuinely tiny.
      expect(compressed.length).toBeLessThan(uncompressedSize / 500)
      return { data: bomb, uncompressedSize }
    }

    it('refuses a zip bomb without inflating it', async () => {
      const { data, uncompressedSize } = makeBomb()
      const encoded = await encode(data, { deflate })

      expect(Array.from(encoded.subarray(0, 3))).toEqual([0x52, 0x4a, 0x43])
      // The whole point: a payload that expands to 64 MiB travels as a
      // handful of kilobytes.
      expect(encoded.length).toBeLessThan(200 * 1024)

      // The inflater must never be reached — refusing *after* inflating is
      // not refusing, the memory is already gone by then.
      let inflateCalls = 0
      const counting: Inflate = (d, limit) => {
        inflateCalls++
        return boundedInflate(d, limit)
      }

      await expect(
        decode(encoded, { inflate: counting, maxDecompressedSize: 1024 * 1024 }),
      ).rejects.toThrow(DASizeLimitError)

      expect(inflateCalls).toBe(0)

      const err = await decode(encoded, { inflate: counting, maxDecompressedSize: 1024 * 1024 })
        .catch((e: unknown) => e as DASizeLimitError)
      expect(err).toBeInstanceOf(DASizeLimitError)
      expect(err.limit).toBe(1024 * 1024)
      expect(err.requested).toBe(uncompressedSize)
    })

    it('applies a 16 MiB default cap when none is configured', async () => {
      expect(MAX_DECOMPRESSED_SIZE).toBe(16 * 1024 * 1024)

      const { data } = makeBomb() // 64 MiB — over the default
      const encoded = await encode(data, { deflate })

      let inflateCalls = 0
      const counting: Inflate = (d, limit) => {
        inflateCalls++
        return boundedInflate(d, limit)
      }

      // No maxDecompressedSize passed: the default has to be doing the work.
      await expect(decode(encoded, { inflate: counting })).rejects.toThrow(DASizeLimitError)
      expect(inflateCalls).toBe(0)
    })

    it('bounds the inflater when a frame lies about its decompressed size', async () => {
      // Declare 1 KiB, then hand over a stream that expands to 8 MiB. The
      // declaration passes the cheap check, so the inflater's bound is the
      // only thing left standing between the frame and 8 MiB of memory.
      const real = new Uint8Array(8 * 1024 * 1024)
      const compressed = deflate(real)

      const lengthHeader = new Uint8Array([0x80, 0x08]) // LEB128 for 1024
      const encoded = new Uint8Array(3 + lengthHeader.length + compressed.length)
      encoded.set([0x52, 0x4a, 0x43], 0)
      encoded.set(lengthHeader, 3)
      encoded.set(compressed, 3 + lengthHeader.length)

      const limits: number[] = []
      const recording: Inflate = (d, limit) => {
        limits.push(limit)
        return boundedInflate(d, limit)
      }

      await expect(decode(encoded, { inflate: recording })).rejects.toThrow(DADecodeError)
      // The inflater was handed the declared size, not the 16 MiB cap — the
      // tightest bound available, so the liar is stopped at 1 KiB.
      expect(limits).toEqual([1024])
    })

    it('fails closed when the inflater ignores its bound', async () => {
      // The original bug, preserved as an inflater: inflate everything, ask
      // questions later. The post-inflation check cannot save the memory, but
      // it must not let oversized output through as if it were fine.
      const real = new Uint8Array(4 * 1024 * 1024).fill(0x5a)
      const compressed = deflate(real)

      const lengthHeader = new Uint8Array([0x80, 0x08]) // LEB128 for 1024
      const encoded = new Uint8Array(3 + lengthHeader.length + compressed.length)
      encoded.set([0x52, 0x4a, 0x43], 0)
      encoded.set(lengthHeader, 3)
      encoded.set(compressed, 3 + lengthHeader.length)

      /*
       * `DASizeLimitError extends DADecodeError`, so asserting the parent
       * cannot tell the two adjacent guards apart. This input trips the
       * declared-length check, NOT the size cap: `out.length > limit`
       * compares 4 MiB against maxDecompressedSize (16 MiB) and is false, so
       * only `out.length !== declared` fires. Deleting the size cap left this
       * test green; deleting the length check fails it.
       *
       * Asserting the exact class pins which one is doing the work.
       */
      const rejection = await decode(encoded, { inflate: unboundedInflate }).then(
        () => null,
        (err: unknown) => err,
      )
      expect(rejection).toBeInstanceOf(DADecodeError)
      expect(rejection).not.toBeInstanceOf(DASizeLimitError)
      expect(String((rejection as Error).message)).toMatch(/declared/)
    })

    it('trips the size cap, distinguishably, when output exceeds it', async () => {
      /*
       * The guard the test above cannot reach. It needs output larger than
       * `maxDecompressedSize`, not merely larger than the declared length --
       * and it must be asserted as DASizeLimitError specifically, or the
       * parent class swallows the distinction again.
       */
      const cap = 1024
      const real = new Uint8Array(64 * 1024).fill(0x5a)
      const compressed = deflate(real)

      const lengthHeader = new Uint8Array([0x80, 0x08]) // LEB128 for 1024
      const encoded = new Uint8Array(3 + lengthHeader.length + compressed.length)
      encoded.set([0x52, 0x4a, 0x43], 0)
      encoded.set(lengthHeader, 3)
      encoded.set(compressed, 3 + lengthHeader.length)

      const rejection = await decode(encoded, {
        inflate: unboundedInflate,
        maxDecompressedSize: cap,
      }).then(
        () => null,
        (err: unknown) => err,
      )
      expect(rejection, 'the size cap fired, not the length check').toBeInstanceOf(DASizeLimitError)
    })

    it('honours a custom maxDecompressedSize', async () => {
      const data = new Uint8Array(64 * 1024).fill(0x41)
      const encoded = await encode(data, codec)

      // Just under the payload's size — refused.
      await expect(
        decode(encoded, { ...codec, maxDecompressedSize: 64 * 1024 - 1 }),
      ).rejects.toThrow(DASizeLimitError)

      // Exactly the payload's size — allowed. The cap is inclusive.
      expect(await decode(encoded, { ...codec, maxDecompressedSize: 64 * 1024 })).toEqual(data)
    })

    it('caps a raw frame too, so decode has one size postcondition', async () => {
      const data = new Uint8Array(4096).fill(0x11)
      const encoded = await encode(data) // no deflate available → raw frame
      expect(Array.from(encoded.subarray(0, 3))).toEqual([0x52, 0x4a, 0x52])

      await expect(decode(encoded, { maxDecompressedSize: 4095 })).rejects.toThrow(DASizeLimitError)
      expect(await decode(encoded, { maxDecompressedSize: 4096 })).toEqual(data)
    })

    it('reports a refusal as a typed error, not whatever zlib threw', async () => {
      const real = new Uint8Array(2 * 1024 * 1024)
      const compressed = deflate(real)
      const lengthHeader = new Uint8Array([0x80, 0x08]) // LEB128 for 1024
      const encoded = new Uint8Array(3 + lengthHeader.length + compressed.length)
      encoded.set([0x52, 0x4a, 0x43], 0)
      encoded.set(lengthHeader, 3)
      encoded.set(compressed, 3 + lengthHeader.length)

      const err = await decode(encoded, { inflate: boundedInflate }).catch((e: unknown) => e)

      // A caller catching DADecodeError should not also have to know about
      // ERR_BUFFER_TOO_LARGE, or about which compression library is in use.
      expect(err).toBeInstanceOf(DADecodeError)
      expect((err as Error).name).toBe('DADecodeError')
      // ...but the original failure is still reachable for debugging.
      expect((err as { cause?: unknown }).cause).toBeInstanceOf(Error)
    })

    it('rejects a truncated compressed frame', async () => {
      // "RJC" and nothing else — no length header, no body.
      await expect(decode(new Uint8Array([0x52, 0x4a, 0x43]))).rejects.toThrow(DADecodeError)
      // A length header but no body.
      await expect(decode(new Uint8Array([0x52, 0x4a, 0x43, 0x10]))).rejects.toThrow(/truncated/)
    })

    it('rejects a nonsensical maxDecompressedSize', async () => {
      const encoded = await encode(encoder.encode('hi'))
      await expect(decode(encoded, { maxDecompressedSize: -1 })).rejects.toThrow(DADecodeError)
      await expect(decode(encoded, { maxDecompressedSize: 1.5 })).rejects.toThrow(DADecodeError)
    })
  })
})
