/**
 * Canonical wire codec ("raijin-wire" v1).
 *
 * Consensus messages, transactions, blocks and genesis configs carry `bigint`
 * and `Uint8Array`, which `JSON.stringify` cannot represent (it throws on the
 * former and mangles the latter). This is a small, self-describing, tagged
 * binary format that round-trips exactly those values plus `null`, booleans,
 * numbers, strings, arrays and plain objects -- and does so *canonically*:
 * one value has exactly one encoding, so encoded bytes can be hashed, signed,
 * deduplicated or compared byte-for-byte, and a decoder rejects anything that
 * is not the canonical encoding of the value it decodes to.
 *
 * Zero dependencies. The byte-level spec is in this package's README.
 *
 *   message = 0x01 (format version) || value
 *   value   = tag || body
 *
 *   0x00 null
 *   0x01 false
 *   0x02 true
 *   0x03 bigint >= 0   u32 n || n bytes: big-endian magnitude, no leading 0x00 (0n: n = 0)
 *   0x04 bigint <  0   same body, holding the magnitude |v|
 *   0x05 number        8 bytes IEEE-754 binary64, big-endian (NaN is 7ff8000000000000)
 *   0x06 string        u32 n || n bytes UTF-8 (well-formed)
 *   0x07 bytes         u32 n || n raw bytes (a Uint8Array)
 *   0x08 array         u32 n || n values
 *   0x09 object        u32 n || n * (u32 klen || key UTF-8 || value),
 *                      entries strictly ascending by key bytes (no duplicates)
 *
 *   u32 = unsigned 32-bit big-endian.
 */

/** Format version byte that prefixes every encoded message. */
export const WIRE_VERSION = 0x01

/** Anything the wire codec can carry. */
export type WireValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | readonly WireValue[]
  | { readonly [key: string]: WireValue | undefined }

/** Thrown by `decodeMessage` on malformed or non-canonical input. */
export class WireFormatError extends Error {
  constructor(message: string) {
    super(`wire: ${message}`)
    this.name = 'WireFormatError'
  }
}

const T_NULL = 0x00
const T_FALSE = 0x01
const T_TRUE = 0x02
const T_BIGINT_POS = 0x03
const T_BIGINT_NEG = 0x04
const T_NUMBER = 0x05
const T_STRING = 0x06
const T_BYTES = 0x07
const T_ARRAY = 0x08
const T_OBJECT = 0x09

/** Maximum nesting depth accepted on encode and decode. */
const MAX_DEPTH = 64

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: true })

class Writer {
  #buf = new Uint8Array(256)
  #len = 0

  #ensure(extra: number): void {
    if (this.#len + extra <= this.#buf.length) return
    let size = this.#buf.length * 2
    while (size < this.#len + extra) size *= 2
    const next = new Uint8Array(size)
    next.set(this.#buf.subarray(0, this.#len))
    this.#buf = next
  }

  byte(b: number): void {
    this.#ensure(1)
    this.#buf[this.#len++] = b
  }

  u32(n: number): void {
    if (n > 0xffffffff) throw new RangeError('wire: length exceeds 2^32-1')
    this.#ensure(4)
    this.#buf[this.#len++] = (n >>> 24) & 0xff
    this.#buf[this.#len++] = (n >>> 16) & 0xff
    this.#buf[this.#len++] = (n >>> 8) & 0xff
    this.#buf[this.#len++] = n & 0xff
  }

  bytes(b: Uint8Array): void {
    this.#ensure(b.length)
    this.#buf.set(b, this.#len)
    this.#len += b.length
  }

  f64(n: number): void {
    this.#ensure(8)
    const view = new DataView(this.#buf.buffer, this.#buf.byteOffset + this.#len, 8)
    // Canonical NaN: every NaN payload encodes as the quiet NaN.
    if (Number.isNaN(n)) {
      view.setUint32(0, 0x7ff80000)
      view.setUint32(4, 0)
    } else {
      view.setFloat64(0, n, false)
    }
    this.#len += 8
  }

  finish(): Uint8Array {
    return this.#buf.slice(0, this.#len)
  }
}

function magnitudeBytes(v: bigint): Uint8Array {
  if (v === 0n) return new Uint8Array(0)
  let hex = v.toString(16)
  if (hex.length % 2) hex = '0' + hex
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return a.length - b.length
}

function writeValue(w: Writer, v: unknown, depth: number, path: string): void {
  if (depth > MAX_DEPTH) throw new TypeError(`wire: nesting deeper than ${MAX_DEPTH} at ${path}`)
  switch (typeof v) {
    case 'boolean':
      w.byte(v ? T_TRUE : T_FALSE)
      return
    case 'number':
      w.byte(T_NUMBER)
      w.f64(v)
      return
    case 'bigint': {
      const mag = magnitudeBytes(v < 0n ? -v : v)
      w.byte(v < 0n ? T_BIGINT_NEG : T_BIGINT_POS)
      w.u32(mag.length)
      w.bytes(mag)
      return
    }
    case 'string': {
      const b = textEncoder.encode(v)
      // TextEncoder replaces lone surrogates with U+FFFD, which would not
      // round-trip: refuse rather than silently change the value.
      if (!isWellFormed(v)) throw new TypeError(`wire: string at ${path} is not well-formed UTF-16`)
      w.byte(T_STRING)
      w.u32(b.length)
      w.bytes(b)
      return
    }
    case 'object': {
      if (v === null) {
        w.byte(T_NULL)
        return
      }
      if (v instanceof Uint8Array) {
        w.byte(T_BYTES)
        w.u32(v.length)
        w.bytes(v)
        return
      }
      if (Array.isArray(v)) {
        w.byte(T_ARRAY)
        w.u32(v.length)
        for (let i = 0; i < v.length; i++) writeValue(w, v[i], depth + 1, `${path}[${i}]`)
        return
      }
      const proto = Object.getPrototypeOf(v)
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError(`wire: cannot encode ${proto?.constructor?.name ?? 'object'} at ${path}`)
      }
      const entries: Array<[Uint8Array, unknown]> = []
      for (const key of Object.keys(v)) {
        const val = (v as Record<string, unknown>)[key]
        if (val === undefined) continue // like JSON: absent
        entries.push([textEncoder.encode(key), val])
      }
      entries.sort((a, b) => compareBytes(a[0], b[0]))
      w.byte(T_OBJECT)
      w.u32(entries.length)
      for (const [kb, val] of entries) {
        w.u32(kb.length)
        w.bytes(kb)
        writeValue(w, val, depth + 1, `${path}.${textDecoder.decode(kb)}`)
      }
      return
    }
    default:
      throw new TypeError(`wire: cannot encode ${typeof v} at ${path}`)
  }
}

function isWellFormed(s: string): boolean {
  const fn = (s as unknown as { isWellFormed?: () => boolean }).isWellFormed
  if (typeof fn === 'function') return fn.call(s)
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) i++
      else return false
    } else if (c >= 0xdc00 && c <= 0xdfff) return false
  }
  return true
}

/**
 * Encode a value (typically a `ConsensusMessage`, `Transaction`, `Block` or
 * `GenesisConfig`) to its canonical wire bytes. Throws `TypeError` on a value
 * the format cannot carry (`undefined` outside an object property, functions,
 * symbols, `Map`/`Set`/class instances, lone surrogates, nesting > 64).
 */
export function encodeMessage<T>(msg: T): Uint8Array {
  const w = new Writer()
  w.byte(WIRE_VERSION)
  writeValue(w, msg, 0, '$')
  return w.finish()
}

class Reader {
  #pos = 0
  constructor(readonly buf: Uint8Array) {}

  get remaining(): number {
    return this.buf.length - this.#pos
  }

  byte(): number {
    if (this.remaining < 1) throw new WireFormatError('unexpected end of input')
    return this.buf[this.#pos++]
  }

  take(n: number): Uint8Array {
    if (n > this.remaining) throw new WireFormatError('length exceeds remaining input')
    const out = this.buf.slice(this.#pos, this.#pos + n) // copy: never alias the input
    this.#pos += n
    return out
  }

  u32(): number {
    if (this.remaining < 4) throw new WireFormatError('unexpected end of input')
    const b = this.buf
    const p = this.#pos
    this.#pos += 4
    return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0
  }

  f64(): number {
    if (this.remaining < 8) throw new WireFormatError('unexpected end of input')
    const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.#pos, 8)
    this.#pos += 8
    const n = view.getFloat64(0, false)
    if (Number.isNaN(n) && (view.getUint32(0) !== 0x7ff80000 || view.getUint32(4) !== 0)) {
      throw new WireFormatError('non-canonical NaN')
    }
    return n
  }
}

function readMagnitude(r: Reader): bigint {
  const n = r.u32()
  const mag = r.take(n)
  if (n > 0 && mag[0] === 0) throw new WireFormatError('non-minimal bigint (leading zero byte)')
  if (n === 0) return 0n
  let hex = ''
  for (const b of mag) hex += b.toString(16).padStart(2, '0')
  return BigInt('0x' + hex)
}

function readValue(r: Reader, depth: number): WireValue {
  if (depth > MAX_DEPTH) throw new WireFormatError(`nesting deeper than ${MAX_DEPTH}`)
  const tag = r.byte()
  switch (tag) {
    case T_NULL:
      return null
    case T_FALSE:
      return false
    case T_TRUE:
      return true
    case T_BIGINT_POS:
      return readMagnitude(r)
    case T_BIGINT_NEG: {
      const m = readMagnitude(r)
      if (m === 0n) throw new WireFormatError('negative zero bigint')
      return -m
    }
    case T_NUMBER:
      return r.f64()
    case T_STRING: {
      const n = r.u32()
      const b = r.take(n)
      try {
        return textDecoder.decode(b)
      } catch {
        throw new WireFormatError('invalid UTF-8 in string')
      }
    }
    case T_BYTES:
      return r.take(r.u32())
    case T_ARRAY: {
      const n = r.u32()
      // Each element is at least 1 byte: reject absurd counts before allocating.
      if (n > r.remaining) throw new WireFormatError('array length exceeds remaining input')
      const out: WireValue[] = []
      for (let i = 0; i < n; i++) out.push(readValue(r, depth + 1))
      return out
    }
    case T_OBJECT: {
      const n = r.u32()
      if (n > r.remaining) throw new WireFormatError('object length exceeds remaining input')
      const out: Record<string, WireValue> = {}
      let prev: Uint8Array | null = null
      for (let i = 0; i < n; i++) {
        const kb = r.take(r.u32())
        if (prev && compareBytes(prev, kb) >= 0) {
          throw new WireFormatError('object keys not strictly ascending (non-canonical or duplicate)')
        }
        prev = kb
        let key: string
        try {
          key = textDecoder.decode(kb)
        } catch {
          throw new WireFormatError('invalid UTF-8 in object key')
        }
        // defineProperty so a "__proto__" key is an own data property, never the prototype setter.
        Object.defineProperty(out, key, {
          value: readValue(r, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        })
      }
      return out
    }
    default:
      throw new WireFormatError(`unknown tag 0x${tag.toString(16).padStart(2, '0')}`)
  }
}

/**
 * Decode bytes produced by `encodeMessage`. Throws `WireFormatError` on
 * truncated input, trailing bytes, an unknown version or tag, non-minimal
 * integers, unsorted/duplicate object keys, invalid UTF-8 or excess nesting --
 * i.e. on anything that is not the canonical encoding of some value. Decoded
 * `Uint8Array`s are fresh copies, never views into `bytes`.
 *
 * The result is untyped (`WireValue`): decoding does not validate that it is
 * a well-formed `ConsensusMessage`; see `decodeConsensusMessage` in
 * `@johnhenry/raijin-consensus` for that.
 */
export function decodeMessage<T = WireValue>(bytes: Uint8Array): T {
  const r = new Reader(bytes)
  const version = r.byte()
  if (version !== WIRE_VERSION) throw new WireFormatError(`unsupported version ${version}`)
  const v = readValue(r, 0)
  if (r.remaining !== 0) throw new WireFormatError('trailing bytes after value')
  return v as T
}
