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

  it('handles single leaf', async () => {
    const leaf = await hash(new Uint8Array([1]))
    const root = await merkleRoot([leaf])
    expect(root).toEqual(leaf)
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
