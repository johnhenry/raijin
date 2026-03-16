/**
 * Cryptographic hashing utilities using globalThis.crypto.subtle.
 * Zero dependencies. Works in browser and Node.js.
 */

const encoder = new TextEncoder()

/** SHA-256 hash of arbitrary data. */
export async function hash(data: Uint8Array): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data)
  return new Uint8Array(digest)
}

/** SHA-256 hash of a UTF-8 string. */
export async function hashString(str: string): Promise<Uint8Array> {
  return hash(encoder.encode(str))
}

/** Compute a Merkle root from an array of leaf hashes. */
export async function merkleRoot(leaves: Uint8Array[]): Promise<Uint8Array> {
  if (leaves.length === 0) {
    return hash(new Uint8Array(0))
  }
  if (leaves.length === 1) {
    return leaves[0]
  }

  // Pad to even length by duplicating the last leaf
  const padded = [...leaves]
  if (padded.length % 2 !== 0) {
    padded.push(padded[padded.length - 1])
  }

  // Build tree bottom-up
  let level = padded
  while (level.length > 1) {
    // Pad intermediate levels to even length too
    if (level.length % 2 !== 0) {
      level.push(level[level.length - 1])
    }
    const next: Uint8Array[] = []
    for (let i = 0; i < level.length; i += 2) {
      const combined = new Uint8Array(level[i].length + level[i + 1].length)
      combined.set(level[i], 0)
      combined.set(level[i + 1], level[i].length)
      next.push(await hash(combined))
    }
    level = next
  }

  return level[0]
}

/** Compare two Uint8Arrays for equality. */
export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** Convert Uint8Array to hex string. */
export function toHex(data: Uint8Array): string {
  return Array.from(data)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Convert hex string to Uint8Array. */
export function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}
