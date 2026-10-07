import { describe, it, expect } from 'vitest'
import { encodeMessage, decodeMessage, WireFormatError, toHex, fromHex } from '../src/index.js'

// Deterministic PRNG (mulberry32) so a failing seed reproduces.
function prng(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    bytes(n: number) {
      const b = new Uint8Array(n)
      for (let i = 0; i < n; i++) b[i] = Math.floor(next() * 256)
      return b
    },
  }
}

function genBigint(r: ReturnType<typeof prng>): bigint {
  const edge = [0n, 1n, -1n, 255n, 256n, -256n, 2n ** 64n, -(2n ** 64n), 2n ** 256n - 1n, -(2n ** 255n)]
  if (r.int(3) === 0) return edge[r.int(edge.length)]
  const bits = 1 + r.int(600)
  let v = 0n
  for (const byte of r.bytes(Math.ceil(bits / 8))) v = (v << 8n) | BigInt(byte)
  v &= (1n << BigInt(bits)) - 1n
  return r.int(2) ? -v : v
}

function genStr(r: ReturnType<typeof prng>): string {
  const pool = ['', 'a', 'pre-prepare', 'héllo', '日本語', '\u0000', '😀 emoji', 'with "quotes"', '__proto__', 'constructor']
  if (r.int(2)) return pool[r.int(pool.length)]
  let s = ''
  for (let i = r.int(20); i > 0; i--) s += String.fromCodePoint(r.int(0xd7ff) + 1)
  return s
}

function genValue(r: ReturnType<typeof prng>, depth = 0): unknown {
  const kinds = depth >= 4 ? 7 : 9
  switch (r.int(kinds)) {
    case 0: return null
    case 1: return r.int(2) === 1
    case 2: return [0, -0, 1.5, -1e308, Number.MAX_SAFE_INTEGER, Infinity, -Infinity, NaN, 5e-324, r.next() * 1e6][r.int(10)]
    case 3: return genBigint(r)
    case 4: return genStr(r)
    case 5: return r.bytes([0, 1, 32, 64, r.int(300)][r.int(5)])
    case 6: return genBigint(r)
    case 7: return Array.from({ length: r.int(5) }, () => genValue(r, depth + 1))
    default: {
      const o: Record<string, unknown> = {}
      for (let i = r.int(5); i > 0; i--) {
        Object.defineProperty(o, genStr(r), { value: genValue(r, depth + 1), enumerable: true, writable: true, configurable: true })
      }
      return o
    }
  }
}

// Structural form for comparison: bytes -> hex tag, bigints tagged, objects as sorted [key, value] pairs.
function norm(v: unknown): unknown {
  if (v instanceof Uint8Array) return { bytes: toHex(v) }
  if (typeof v === 'bigint') return { big: v.toString() }
  if (typeof v === 'number') return { num: Object.is(v, -0) ? '-0' : String(v) }
  if (Array.isArray(v)) return v.map(norm)
  if (v && typeof v === 'object') {
    return Object.keys(v).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])])
  }
  return v
}

describe('wire codec: round trip', () => {
  it('round-trips 3000 random values (property test)', () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const r = prng(seed)
      const v = genValue(r)
      const enc = encodeMessage(v)
      const dec = decodeMessage(enc)
      expect(norm(dec), `seed ${seed}`).toStrictEqual(norm(v))
      // canonical: re-encoding the decoded value gives identical bytes
      expect(toHex(encodeMessage(dec)), `seed ${seed}`).toBe(toHex(enc))
    }
  })

  it('bigint edge cases', () => {
    const cases = [0n, 1n, -1n, 127n, 128n, 255n, 256n, -255n, 2n ** 63n, -(2n ** 63n), 2n ** 64n - 1n, 10n ** 100n, -(10n ** 100n), 2n ** 4096n]
    for (const c of cases) expect(decodeMessage(encodeMessage(c))).toBe(c)
  })

  it('Uint8Array edge cases: empty, large, all byte values; decoded bytes are copies', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i)
    const big = new Uint8Array(1_000_000).fill(7)
    for (const b of [new Uint8Array(0), all, big]) {
      const out = decodeMessage<Uint8Array>(encodeMessage(b))
      expect(out).toBeInstanceOf(Uint8Array)
      expect(out.length).toBe(b.length)
      expect(out.every((x, i) => x === b[i])).toBe(true)
    }
    const enc = encodeMessage(new Uint8Array([1, 2, 3]))
    const out = decodeMessage<Uint8Array>(enc)
    enc.fill(0)
    expect([...out]).toEqual([1, 2, 3]) // does not alias the input buffer
  })

  it('subarray views encode their visible bytes only', () => {
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9])
    expect([...decodeMessage<Uint8Array>(encodeMessage(backing.subarray(2, 5)))]).toEqual([1, 2, 3])
  })

  it('numbers: -0, NaN and infinities survive; all NaNs encode identically', () => {
    expect(Object.is(decodeMessage(encodeMessage(-0)), -0)).toBe(true)
    expect(decodeMessage(encodeMessage(NaN))).toBeNaN()
    const odd = new DataView(new ArrayBuffer(8))
    odd.setUint32(0, 0x7ff80001)
    expect(toHex(encodeMessage(odd.getFloat64(0)))).toBe(toHex(encodeMessage(NaN)))
  })

  it('distinguishes 1 (number) from 1n (bigint) and "1" (string)', () => {
    const encs = [1, 1n, '1', [1], true].map((v) => toHex(encodeMessage(v)))
    expect(new Set(encs).size).toBe(encs.length)
  })

  it('object key order does not affect the encoding; undefined properties are omitted', () => {
    const a = encodeMessage({ b: 1n, a: new Uint8Array([1]), c: undefined })
    const b = encodeMessage({ a: new Uint8Array([1]), b: 1n })
    expect(toHex(a)).toBe(toHex(b))
    expect(decodeMessage(a)).toStrictEqual({ a: new Uint8Array([1]), b: 1n })
  })

  it('a "__proto__" key is data, not a prototype', () => {
    const o = Object.defineProperty({}, '__proto__', { value: { polluted: 1n }, enumerable: true, configurable: true, writable: true })
    const dec = decodeMessage<Record<string, unknown>>(encodeMessage(o))
    expect(Object.getPrototypeOf(dec)).toBe(Object.prototype)
    expect(Object.keys(dec)).toEqual(['__proto__'])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('matches the documented byte-level examples', () => {
    expect(toHex(encodeMessage(null))).toBe('0100')
    expect(toHex(encodeMessage(true))).toBe('0102')
    expect(toHex(encodeMessage(0n))).toBe('010300000000')
    expect(toHex(encodeMessage(256n))).toBe('0103000000020100')
    expect(toHex(encodeMessage(-1n))).toBe('01040000000101')
    expect(toHex(encodeMessage('hi'))).toBe('0106000000026869')
    expect(toHex(encodeMessage(new Uint8Array([0xab])))).toBe('010700000001ab')
    expect(toHex(encodeMessage(1))).toBe('01053ff0000000000000')
    expect(toHex(encodeMessage([null]))).toBe('0108000000010' + '0')
    expect(toHex(encodeMessage({ a: 1n }))).toBe('01090000000100000001' + '61' + '0300000001' + '01')
  })
})

describe('wire codec: encode rejects the unrepresentable', () => {
  it.each([
    ['undefined', undefined],
    ['function', () => 1],
    ['symbol', Symbol('x')],
    ['Map', new Map()],
    ['Date', new Date()],
    ['lone surrogate', '\ud800'],
    ['undefined in array', [undefined]],
    ['typed array other than Uint8Array', new Uint16Array(2)],
  ])('%s', (_n, v) => {
    expect(() => encodeMessage(v)).toThrow(TypeError)
  })

  it('nesting beyond 64 levels', () => {
    let v: unknown = null
    for (let i = 0; i < 70; i++) v = [v]
    expect(() => encodeMessage(v)).toThrow(TypeError)
  })
})

describe('wire codec: decode rejects malformed and non-canonical input', () => {
  const dec = (hex: string) => () => decodeMessage(fromHex(hex))
  it.each([
    ['empty input', ''],
    ['wrong version', '0200'],
    ['unknown tag', '01ff'],
    ['truncated bigint', '0103000000050102'],
    ['trailing bytes', '010000'],
    ['bigint with leading zero byte', '01030000000200ff'],
    ['negative zero', '010400000000'],
    ['truncated string', '010600000005686'],
    ['invalid utf-8', '01060000000 1ff'.replace(' ', '')],
    ['array length larger than input', '0108ffffffff'],
    ['object length larger than input', '0109ffffffff'],
    ['unsorted object keys', '01090000000200000001' + '62' + '00' + '00000001' + '61' + '00'],
    ['duplicate object keys', '01090000000200000001' + '61' + '00' + '00000001' + '61' + '00'],
    ['non-canonical NaN', '01057ff8000000000001'],
    ['truncated number', '0105 3ff0'.replace(' ', '')],
  ])('%s', (_n, hex) => {
    expect(dec(hex)).toThrow(WireFormatError)
  })

  it('nesting beyond 64 levels', () => {
    const hex = '01' + '0800000001'.repeat(70) + '00'
    expect(dec(hex)).toThrow(WireFormatError)
  })

  it('every truncation of a valid message is rejected, never mis-decoded', () => {
    const enc = encodeMessage({ a: [1n, new Uint8Array([1, 2]), 'x', null, { b: -5n }], c: 1.5 })
    for (let n = 0; n < enc.length; n++) {
      expect(() => decodeMessage(enc.subarray(0, n)), `len ${n}`).toThrow(WireFormatError)
    }
  })

  it('fuzz: random bytes never throw anything but WireFormatError', () => {
    for (let seed = 1; seed <= 2000; seed++) {
      const r = prng(seed)
      const bytes = r.bytes(r.int(40))
      if (bytes.length) bytes[0] = r.int(4) === 0 ? bytes[0] : 1
      try {
        decodeMessage(bytes)
      } catch (e) {
        expect(e, `seed ${seed}`).toBeInstanceOf(WireFormatError)
      }
    }
  })
})
