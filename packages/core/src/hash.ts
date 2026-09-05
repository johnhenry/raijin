/**
 * Cryptographic hashing utilities using globalThis.crypto.subtle.
 * Zero dependencies. Works in browser and Node.js.
 */

const encoder = new TextEncoder()

/** SHA-256 hash of arbitrary data. */
export async function hash(data: Uint8Array): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data as BufferSource)
  return new Uint8Array(digest)
}

/** SHA-256 hash of a UTF-8 string. */
export async function hashString(str: string): Promise<Uint8Array> {
  return hash(encoder.encode(str))
}

/** Domain tag for a leaf position in the Merkle tree. */
const MERKLE_LEAF = 0x00
/** Domain tag for an internal node. */
const MERKLE_NODE = 0x01

/** `H(0x00 || leaf)` — a leaf hash can never be mistaken for a node hash. */
async function merkleLeaf(leaf: Uint8Array): Promise<Uint8Array> {
  const buf = new Uint8Array(1 + leaf.length)
  buf[0] = MERKLE_LEAF
  buf.set(leaf, 1)
  return hash(buf)
}

/** `H(0x01 || left || right)`. */
async function merkleNode(left: Uint8Array, right: Uint8Array): Promise<Uint8Array> {
  const buf = new Uint8Array(1 + left.length + right.length)
  buf[0] = MERKLE_NODE
  buf.set(left, 1)
  buf.set(right, 1 + left.length)
  return hash(buf)
}

/**
 * Compute a Merkle root from an array of leaf hashes.
 *
 * Leaves and internal nodes are domain-separated (`0x00` / `0x01`), and an odd
 * level promotes its last node instead of duplicating it. Without both, the
 * tree has the CVE-2012-2459 shape: `[A, B, C]` pads to `[A, B, C, C]` and the
 * two lists produce an identical root, so a block's `txRoot` does not uniquely
 * commit to its transaction list. A lone leaf was also returned unhashed, so
 * "root" and "leaf" were the same value at n = 1.
 */
export async function merkleRoot(leaves: Uint8Array[]): Promise<Uint8Array> {
  if (leaves.length === 0) {
    return hash(new Uint8Array([MERKLE_LEAF]))
  }

  let level: Uint8Array[] = await Promise.all(leaves.map(merkleLeaf))

  while (level.length > 1) {
    const next: Uint8Array[] = []
    for (let i = 0; i + 1 < level.length; i += 2) {
      next.push(await merkleNode(level[i], level[i + 1]))
    }
    // Odd level: promote the last node unchanged rather than pairing it with
    // itself, which is what makes a duplicated final leaf indistinguishable.
    if (level.length % 2 !== 0) {
      next.push(level[level.length - 1])
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
