import { describe, it, expect } from 'vitest'
import { hash, merkleRoot, equal, toHex, fromHex } from '../src/index.js'

describe('hash', () => {
  it('produces 32-byte SHA-256 digest', async () => {
    const result = await hash(new Uint8Array([1, 2, 3]))
    expect(result).toBeInstanceOf(Uint8Array)
    expect(result.length).toBe(32)
  })

  it('is deterministic', async () => {
    const a = await hash(new Uint8Array([1, 2, 3]))
    const b = await hash(new Uint8Array([1, 2, 3]))
    expect(a).toEqual(b)
  })

  it('different inputs produce different hashes', async () => {
    const a = await hash(new Uint8Array([1]))
    const b = await hash(new Uint8Array([2]))
    expect(a).not.toEqual(b)
  })
})

describe('merkleRoot', () => {
  it('handles empty leaves', async () => {
    const root = await merkleRoot([])
    expect(root.length).toBe(32)
  })

  it('does not return a single leaf unhashed', async () => {
    const leaf = await hash(new Uint8Array([1]))
    const root = await merkleRoot([leaf])
    expect(root.length).toBe(32)
    // A leaf and a root must not be the same value — otherwise a value an
    // attacker supplies as a leaf is directly a root.
    expect(root).not.toEqual(leaf)
  })

  it('handles two leaves', async () => {
    const a = await hash(new Uint8Array([1]))
    const b = await hash(new Uint8Array([2]))
    const root = await merkleRoot([a, b])
    expect(root.length).toBe(32)
    expect(root).not.toEqual(a)
    expect(root).not.toEqual(b)
  })

  it('is deterministic', async () => {
    const leaves = [
      await hash(new Uint8Array([1])),
      await hash(new Uint8Array([2])),
      await hash(new Uint8Array([3])),
    ]
    const r1 = await merkleRoot(leaves)
    const r2 = await merkleRoot(leaves)
    expect(r1).toEqual(r2)
  })

  it('order matters', async () => {
    const a = await hash(new Uint8Array([1]))
    const b = await hash(new Uint8Array([2]))
    const r1 = await merkleRoot([a, b])
    const r2 = await merkleRoot([b, a])
    expect(r1).not.toEqual(r2)
  })

  // Duplicating the last leaf to pad an odd level made [A,B,C] and [A,B,C,C]
  // hash to the same root, so a block's txRoot did not uniquely commit to its
  // transaction list. See issue #21.
  it('does not collide when the last leaf is duplicated', async () => {
    const leaves = await Promise.all(
      [1, 2, 3, 4, 5, 6, 7].map((n) => hash(new Uint8Array([n]))),
    )
    for (let n = 1; n <= leaves.length; n++) {
      const list = leaves.slice(0, n)
      const dup = [...list, list[list.length - 1]]
      expect(await merkleRoot(list)).not.toEqual(await merkleRoot(dup))
    }
  })

  it('gives every distinct leaf list a distinct root, up to 9 leaves', async () => {
    const leaves = await Promise.all(
      [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => hash(new Uint8Array([n]))),
    )
    const roots = new Set<string>()
    // Every prefix, and every prefix with its last leaf repeated 1-3 times.
    for (let n = 1; n <= leaves.length; n++) {
      for (let extra = 0; extra <= 3; extra++) {
        const list = leaves.slice(0, n)
        for (let e = 0; e < extra; e++) list.push(list[n - 1])
        roots.add(toHex(await merkleRoot(list)))
      }
    }
    expect(roots.size).toBe(leaves.length * 4)
  })

  // Leaves and internal nodes must live in different domains. Without that,
  // one fabricated leaf equal to the concatenation of two leaf hashes has the
  // same root as the genuine two-leaf tree — a second preimage anyone can
  // construct with two hash calls, using only the public API. See issue #21.
  it('separates leaf hashes from internal-node hashes', async () => {
    const a = new Uint8Array([1, 2, 3])
    const b = new Uint8Array([4, 5, 6])

    // A one-leaf root is that leaf's leaf-hash, so this reads the two leaf
    // hashes back out of the implementation without assuming its encoding.
    const leafA = await merkleRoot([a])
    const leafB = await merkleRoot([b])

    const forged = new Uint8Array(leafA.length + leafB.length)
    forged.set(leafA, 0)
    forged.set(leafB, leafA.length)

    expect(await merkleRoot([forged])).not.toEqual(await merkleRoot([a, b]))
  })
})

describe('equal', () => {
  it('returns true for identical arrays', () => {
    expect(equal(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true)
  })

  it('returns false for different arrays', () => {
    expect(equal(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false)
  })

  it('returns false for different lengths', () => {
    expect(equal(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false)
  })
})

describe('hex', () => {
  it('round-trips', () => {
    const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
    expect(fromHex(toHex(data))).toEqual(data)
  })

  it('produces lowercase hex', () => {
    expect(toHex(new Uint8Array([0xab, 0xcd]))).toBe('abcd')
  })
})
