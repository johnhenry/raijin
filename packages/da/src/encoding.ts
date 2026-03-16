/**
 * Block data serialization and compression for DA submission.
 *
 * Uses fflate for compression when available, falls back to raw bytes.
 * Zero hard dependencies — fflate is optional.
 */

/** Shape of the fflate subset we use. */
interface FflateCompat {
  deflateSync: (data: Uint8Array) => Uint8Array
  inflateSync: (data: Uint8Array) => Uint8Array
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

/** Magic bytes to identify compressed payloads. */
const COMPRESSED_MAGIC = new Uint8Array([0x52, 0x4a, 0x43]) // "RJC"
const RAW_MAGIC = new Uint8Array([0x52, 0x4a, 0x52])        // "RJR"

/**
 * Encode and optionally compress data for DA submission.
 * Prepends a 3-byte magic header so decode() knows whether to decompress.
 */
export async function encode(data: Uint8Array): Promise<Uint8Array> {
  const fflate = await getFflate()

  if (fflate) {
    const compressed = fflate.deflateSync(data)
    // Only use compression if it actually saves space
    if (compressed.length < data.length) {
      const result = new Uint8Array(COMPRESSED_MAGIC.length + compressed.length)
      result.set(COMPRESSED_MAGIC, 0)
      result.set(compressed, COMPRESSED_MAGIC.length)
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
 */
export async function decode(data: Uint8Array): Promise<Uint8Array> {
  if (data.length < 3) {
    throw new Error('DA encoded data too short: missing magic header')
  }

  const magic = data.slice(0, 3)

  if (bytesEqual(magic, COMPRESSED_MAGIC)) {
    const fflate = await getFflate()
    if (!fflate) {
      throw new Error('Data is compressed but fflate is not available')
    }
    return fflate.inflateSync(data.slice(3))
  }

  if (bytesEqual(magic, RAW_MAGIC)) {
    return data.slice(3)
  }

  throw new Error(`DA encoded data has unknown magic: ${Array.from(magic).map(b => b.toString(16)).join(' ')}`)
}

/** Check whether two byte arrays are identical. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}
