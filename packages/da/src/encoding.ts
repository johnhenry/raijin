/**
 * Block data serialization and compression for DA submission.
 *
 * Uses fflate for compression when available, falls back to raw bytes.
 * Zero hard dependencies — fflate is optional.
 *
 * ## Decompression is a trust boundary
 *
 * Everything `decode()` is handed came off a data availability layer, which
 * is to say: off the network, from whoever chose to post it. DEFLATE reaches
 * roughly 1000:1 on repetitive input, so a few kilobytes of attacker-chosen
 * bytes can ask for gigabytes of output — a zip bomb, on exactly the data
 * path that by definition carries untrusted bytes.
 *
 * Two things keep that bounded here, and the order matters:
 *
 * 1. **A compressed frame declares its decompressed length**, and `decode()`
 *    checks that declaration against `maxDecompressedSize` *before* it
 *    inflates anything. A bomb that asks for a gigabyte is refused without a
 *    gigabyte ever being allocated.
 * 2. **The inflater is given that length as a hard bound**, so a frame that
 *    declares a small size and then streams more than it promised is stopped
 *    inside the inflater rather than after the memory is already committed.
 *
 * The length check after inflation is a third, weaker net: by the time it can
 * run, the allocation has happened. It is there to fail closed against an
 * inflater that ignores its bound, not to provide the bound.
 */

import { RaijinError } from '@johnhenry/raijin-core'
import { encodeBigInt, decodeBigInt } from '@johnhenry/raijin-core'

// ── Errors ────────────────────────────────────────────────────────────

/**
 * `decode()` refused a payload. Every rejection from `decode()` is one of
 * these, including failures that originate inside the compression library —
 * callers should not have to catch whatever the zlib layer happens to throw,
 * or tell it apart from a bug in their own code.
 */
export class DADecodeError extends RaijinError {
  constructor(reason: string, options?: { cause?: unknown }) {
    super(`DA decode failed: ${reason}`)
    this.name = 'DADecodeError'
    if (options && 'cause' in options) {
      // `cause` is not part of RaijinError's constructor; attach it directly
      // so the underlying compression error is not lost.
      Object.defineProperty(this, 'cause', {
        value: options.cause,
        configurable: true,
        writable: true,
      })
    }
  }
}

/**
 * A payload asked to produce more than `maxDecompressedSize` bytes.
 *
 * Thrown for the zip-bomb case, and for a raw payload longer than the cap,
 * so that `decode()` has a single postcondition: it never returns more than
 * `maxDecompressedSize` bytes.
 */
export class DASizeLimitError extends DADecodeError {
  /** The cap that was exceeded, in bytes. */
  readonly limit: number
  /** How many bytes the payload asked for, when that is known. */
  readonly requested: number

  constructor(requested: number, limit: number, what: string) {
    super(
      `${what} is ${requested} bytes, over the ${limit}-byte limit. ` +
      'Raise maxDecompressedSize if this payload is genuinely expected.',
    )
    this.name = 'DASizeLimitError'
    this.limit = limit
    this.requested = requested
  }
}

// ── Compression backend ───────────────────────────────────────────────

/** Compress `data`. Must produce a raw DEFLATE stream. */
export type Deflate = (data: Uint8Array) => Uint8Array

/**
 * Decompress `data`, producing at most `limit` bytes.
 *
 * `limit` is a memory bound, not a post-hoc assertion: an implementation
 * must stop and throw once the output would exceed it. An implementation
 * that inflates to completion and then truncates satisfies the signature
 * and provides no protection at all.
 */
export type Inflate = (data: Uint8Array, limit: number) => Uint8Array

/** Shape of the fflate subset we use. */
interface FflateCompat {
  deflateSync: (data: Uint8Array) => Uint8Array
  /**
   * fflate will not grow an output buffer the caller supplies — it throws as
   * soon as the stream needs more room than `out` has, which is what makes
   * `out` a real bound rather than a hint.
   */
  inflateSync: (data: Uint8Array, opts?: { out?: Uint8Array }) => Uint8Array
}

/** Attempt to load fflate at module level. */
let _fflate: FflateCompat | null = null
let _fflateChecked = false

async function getFflate(): Promise<FflateCompat | null> {
  if (_fflateChecked) return _fflate
  _fflateChecked = true
  try {
    // Dynamic import — fflate is optional
    _fflate = await (Function('return import("fflate")')() as Promise<FflateCompat>)
  } catch {
    _fflate = null
  }
  return _fflate
}

// ── Limits ────────────────────────────────────────────────────────────

/**
 * Default ceiling on what one `decode()` will produce: 16 MiB.
 *
 * A DA blob holds one rollup block's data. Celestia's practical per-blob
 * ceiling is a couple of megabytes and an EIP-4844 blob is 128 KiB, so this
 * leaves generous headroom while still bounding a single decode to something
 * a browser tab can survive. Override it per call with
 * `DecodeOptions.maxDecompressedSize`.
 */
export const MAX_DECOMPRESSED_SIZE = 16 * 1024 * 1024

// ── Options ───────────────────────────────────────────────────────────

export interface EncodeOptions {
  /**
   * Compressor to use. Defaults to fflate's `deflateSync` when fflate can be
   * imported, and to no compression at all when it cannot.
   */
  deflate?: Deflate
}

export interface DecodeOptions {
  /**
   * Maximum number of bytes `decode()` may return. Default:
   * `MAX_DECOMPRESSED_SIZE` (16 MiB). A payload that asks for more is
   * refused with `DASizeLimitError`.
   */
  maxDecompressedSize?: number
  /**
   * Decompressor to use. Defaults to fflate's `inflateSync`, bounded with a
   * caller-supplied output buffer. Supply your own to decode in an
   * environment where the optional fflate import does not resolve — it must
   * honour the `limit` argument (see `Inflate`).
   */
  inflate?: Inflate
}

// ── Frame format ──────────────────────────────────────────────────────

/** Magic bytes to identify compressed payloads. */
const COMPRESSED_MAGIC = new Uint8Array([0x52, 0x4a, 0x43]) // "RJC"
const RAW_MAGIC = new Uint8Array([0x52, 0x4a, 0x52])        // "RJR"

/**
 * Encode and optionally compress data for DA submission.
 *
 * Frame layout:
 * - raw:        `"RJR" ‖ data`
 * - compressed: `"RJC" ‖ LEB128(data.length) ‖ deflate(data)`
 *
 * The compressed frame carries the *decompressed* length so that `decode()`
 * can refuse an oversized payload before allocating for it, and so that the
 * inflated result has an expected size to be checked against rather than
 * being whatever the stream chose to produce.
 */
export async function encode(data: Uint8Array, opts: EncodeOptions = {}): Promise<Uint8Array> {
  const deflate = opts.deflate ?? (await getFflate())?.deflateSync

  if (deflate) {
    const compressed = deflate(data)
    const declaredLength = encodeBigInt(BigInt(data.length))
    const framed = COMPRESSED_MAGIC.length + declaredLength.length + compressed.length

    // Only use compression if the whole frame actually saves space — the
    // length header counts, otherwise a barely-compressible payload gets
    // bigger.
    if (framed < RAW_MAGIC.length + data.length) {
      const result = new Uint8Array(framed)
      result.set(COMPRESSED_MAGIC, 0)
      result.set(declaredLength, COMPRESSED_MAGIC.length)
      result.set(compressed, COMPRESSED_MAGIC.length + declaredLength.length)
      return result
    }
  }

  // Raw fallback
  const result = new Uint8Array(RAW_MAGIC.length + data.length)
  result.set(RAW_MAGIC, 0)
  result.set(data, RAW_MAGIC.length)
  return result
}

/**
 * Decode data that was encoded with encode().
 * Detects the magic header and decompresses if needed.
 *
 * Never returns more than `maxDecompressedSize` bytes; anything larger is
 * refused with `DASizeLimitError`. Every other rejection — a truncated
 * frame, an unknown magic, a failure inside the decompressor — arrives as a
 * `DADecodeError`.
 */
export async function decode(data: Uint8Array, opts: DecodeOptions = {}): Promise<Uint8Array> {
  const limit = opts.maxDecompressedSize ?? MAX_DECOMPRESSED_SIZE
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new DADecodeError(`maxDecompressedSize must be a non-negative safe integer, got ${limit}`)
  }

  if (data.length < 3) {
    throw new DADecodeError('DA encoded data too short: missing magic header')
  }

  const magic = data.subarray(0, 3)

  if (bytesEqual(magic, COMPRESSED_MAGIC)) {
    return decodeCompressed(data.subarray(3), limit, opts.inflate)
  }

  if (bytesEqual(magic, RAW_MAGIC)) {
    const body = data.subarray(3)
    // Capped as well, so `decode` has one postcondition regardless of which
    // branch it took. A caller that sized a buffer from the limit should not
    // have to ask which frame it got.
    if (body.length > limit) {
      throw new DASizeLimitError(body.length, limit, 'raw payload')
    }
    return body.slice()
  }

  throw new DADecodeError(
    `DA encoded data has unknown magic: ${Array.from(magic).map(b => b.toString(16)).join(' ')}`,
  )
}

async function decodeCompressed(
  frame: Uint8Array,
  limit: number,
  injected: Inflate | undefined,
): Promise<Uint8Array> {
  // ── 1. Read the declared decompressed length ──
  const [declaredBig, lenSize] = decodeBigInt(frame, 0)
  if (lenSize === 0 || lenSize >= frame.length) {
    throw new DADecodeError('compressed frame is truncated: no length header or no body')
  }
  // ── 2. Refuse an oversized payload before inflating it ──
  //
  // This is the check that actually stops a zip bomb. It runs against the
  // frame's own claim, costs one varint read, and allocates nothing: a blob
  // that asks for a gigabyte is rejected while it is still a few kilobytes.
  //
  // Compared in bigint, so a declaration too large for a JS number is caught
  // here rather than losing precision on the way to the comparison.
  if (declaredBig > BigInt(limit)) {
    throw new DASizeLimitError(Number(declaredBig), limit, 'declared decompressed size')
  }
  // Safe to narrow: `declaredBig` is at or below `limit`, a safe integer.
  const declared = Number(declaredBig)

  const body = frame.subarray(lenSize)

  // ── 3. Inflate under a hard bound ──
  //
  // The bound is the declared size, which step 2 has already established is
  // at or below the cap. A frame that declares 1 KiB and then streams 1 GiB
  // is stopped by the inflater at 1 KiB — the declaration is not trusted, it
  // is merely the tightest bound we can enforce cheaply.
  const inflate = injected ?? (await defaultInflate())

  let out: Uint8Array
  try {
    out = inflate(body, declared)
  } catch (cause) {
    throw new DADecodeError(
      `decompression failed (declared ${declared} bytes, limit ${limit})`,
      { cause },
    )
  }

  // ── 4. Fail closed if the inflater ignored its bound ──
  //
  // Only reachable with an inflater that does not honour `limit`. By this
  // point the memory has already been committed, so this cannot be the
  // defence — it exists so that a bad inflater produces an error instead of
  // silently oversized output.
  if (out.length > limit) {
    throw new DASizeLimitError(out.length, limit, 'decompressed payload')
  }
  if (out.length !== declared) {
    throw new DADecodeError(
      `decompressed payload is ${out.length} bytes, but the frame declared ${declared}`,
    )
  }

  return out
}

/** fflate's `inflateSync`, bounded by a caller-supplied output buffer. */
async function defaultInflate(): Promise<Inflate> {
  const fflate = await getFflate()
  if (!fflate) {
    throw new DADecodeError(
      'data is compressed but fflate is not available. ' +
      'Install fflate, or pass DecodeOptions.inflate.',
    )
  }
  return (body, expected) => {
    /*
     * `out` is sized at expected + 1, and the extra byte is the whole point.
     *
     * The bound is what stops a zip bomb: fflate will not grow a buffer the
     * caller supplied, so an over-long stream cannot force an allocation.
     * This comment used to say such a stream "throws here". IT DOES NOT.
     * fflate SILENTLY TRUNCATES to the buffer it was given and returns
     * normally, so sizing `out` at exactly `expected` made a lying frame
     * indistinguishable from an honest one: the output was `expected` bytes,
     * the post-inflation length check compared equal, and decode() handed the
     * caller silently truncated data as genuine DA content.
     *
     * Measured: a frame declaring 1024 bytes and carrying a compressed 8 MiB
     * payload decoded without error and returned 1024 bytes.
     *
     * With one spare byte, the two cases separate. fflate trims when the
     * stream ends inside the buffer and fills it when the stream does not, so
     * a result of exactly expected + 1 means more data was coming — which is
     * the lie, caught before anything downstream sees it. The memory bound is
     * unchanged in substance: one byte.
     */
    const out = fflate.inflateSync(body, { out: new Uint8Array(expected + 1) })
    if (out.length > expected) {
      throw new DADecodeError(
        `compressed payload produced more than the declared ${expected} bytes`,
      )
    }
    return out
  }
}

/** Check whether two byte arrays are identical. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}
