import { describe, it, expect } from 'vitest'
import {
  encodeBigInt,
  decodeBigInt,
  encodeBytes,
  decodeBytes,
  encodeAccount,
  decodeAccount,
  encodeTx,
  encodeTxSigned,
  encodeReceipt,
  encodeStateEntry,
  encodeBlockHeader,
  toHex,
  Domain,
  type Transaction,
  type BlockHeader,
} from '../src/index.js'

describe('encoding', () => {
  describe('bigint', () => {
    it('encodes and decodes 0', () => {
      const encoded = encodeBigInt(0n)
      const [value, consumed] = decodeBigInt(encoded)
      expect(value).toBe(0n)
      expect(consumed).toBe(1)
    })

    it('encodes and decodes small values', () => {
      for (const n of [1n, 42n, 127n]) {
        const [value] = decodeBigInt(encodeBigInt(n))
        expect(value).toBe(n)
      }
    })

    it('encodes and decodes large values', () => {
      const large = 1_000_000_000n
      const [value] = decodeBigInt(encodeBigInt(large))
      expect(value).toBe(large)
    })

    it('encodes and decodes very large values', () => {
      const huge = 2n ** 128n - 1n
      const [value] = decodeBigInt(encodeBigInt(huge))
      expect(value).toBe(huge)
    })
  })

  describe('bytes', () => {
    it('encodes and decodes empty array', () => {
      const data = new Uint8Array(0)
      const encoded = encodeBytes(data)
      const [decoded, consumed] = decodeBytes(encoded)
      expect(decoded).toEqual(data)
    })

    it('encodes and decodes non-empty array', () => {
      const data = new Uint8Array([1, 2, 3, 4, 5])
      const encoded = encodeBytes(data)
      const [decoded] = decodeBytes(encoded)
      expect(decoded).toEqual(data)
    })

    it('encodes and decodes 256-byte array', () => {
      const data = new Uint8Array(256).fill(0xab)
      const [decoded] = decodeBytes(encodeBytes(data))
      expect(decoded).toEqual(data)
    })
  })

  describe('account', () => {
    it('round-trips account data', () => {
      const account = { balance: 1000n, nonce: 42n, reputation: 7n }
      const encoded = encodeAccount(account)
      const decoded = decodeAccount(encoded)
      expect(decoded.balance).toBe(1000n)
      expect(decoded.nonce).toBe(42n)
      expect(decoded.reputation).toBe(7n)
    })

    it('round-trips zero account', () => {
      const account = { balance: 0n, nonce: 0n, reputation: 0n }
      const decoded = decodeAccount(encodeAccount(account))
      expect(decoded.balance).toBe(0n)
      expect(decoded.nonce).toBe(0n)
      expect(decoded.reputation).toBe(0n)
    })

    it('round-trips large values', () => {
      const account = { balance: 2n ** 64n, nonce: 999999n, reputation: 2n ** 32n }
      const decoded = decodeAccount(encodeAccount(account))
      expect(decoded.balance).toBe(2n ** 64n)
      expect(decoded.nonce).toBe(999999n)
      expect(decoded.reputation).toBe(2n ** 32n)
    })
  })
})

// ── Collision resistance of the canonical encodings ───────────────────
//
// Every encoding here is hashed, signed, or both. The property under test is
// injectivity: two different structures must never produce the same bytes,
// and one kind of structure must never produce bytes readable as another.

describe('canonical encoding — injectivity', () => {
  function makeTx(overrides: Partial<Transaction> = {}): Transaction {
    return {
      from: new Uint8Array(32).fill(1),
      nonce: 0n,
      to: new Uint8Array(32).fill(2),
      value: 100n,
      data: new Uint8Array([1]),
      signature: new Uint8Array(64),
      chainId: 1n,
      ...overrides,
    }
  }

  function makeHeader(overrides: Partial<BlockHeader> = {}): BlockHeader {
    return {
      number: 1n,
      parentHash: new Uint8Array(32).fill(0xaa),
      stateRoot: new Uint8Array(32).fill(0xbb),
      txRoot: new Uint8Array(32).fill(0xcc),
      receiptRoot: new Uint8Array(32).fill(0xdd),
      timestamp: 1_700_000_000_000,
      proposer: new Uint8Array(32).fill(0xee),
      ...overrides,
    }
  }

  it('distinguishes a transaction with no recipient from one sent to the empty address', () => {
    // `to: null` means a system operation; `to: new Uint8Array(0)` is a
    // transfer to a zero-length address. Both used to encode as an empty
    // length-prefixed field, so one signature covered both readings.
    const system = encodeTx(makeTx({ to: null }))
    const empty = encodeTx(makeTx({ to: new Uint8Array(0) }))
    expect(toHex(system)).not.toBe(toHex(empty))
  })

  it('keeps a signed transaction from being read as an unsigned one', () => {
    const tx = makeTx()
    expect(encodeTx(tx)[0]).toBe(Domain.Transaction)
    expect(encodeTxSigned(tx)[0]).toBe(Domain.SignedTransaction)
    expect(toHex(encodeTxSigned(tx))).not.toBe(toHex(encodeTx(tx)))
  })

  it('refuses to decode a non-account encoding as an account', () => {
    const receiptBytes = encodeReceipt({
      txHash: new Uint8Array(32),
      status: 'success',
      index: 0,
    })
    expect(() => decodeAccount(receiptBytes)).toThrow(/domain tag/)
    expect(() => decodeAccount(new Uint8Array(0))).toThrow(/domain tag/)
    // The real thing still round-trips.
    expect(decodeAccount(encodeAccount({ balance: 5n, nonce: 1n, reputation: 2n })).balance).toBe(5n)
  })

  it('distinguishes a revert with no reason from a revert with an empty reason', () => {
    const base = { txHash: new Uint8Array(32), status: 'revert' as const, index: 0 }
    const noReason = encodeReceipt(base)
    const emptyReason = encodeReceipt({ ...base, revertReason: '' })
    expect(toHex(noReason)).not.toBe(toHex(emptyReason))
  })

  it('distinguishes two headers that differ only in where one root ends', () => {
    // Nothing constrains these fields to 32 bytes at the type level. Without
    // length prefixes, a 31-byte parentHash followed by a 33-byte stateRoot
    // concatenated to exactly the same bytes as 32 and 32 — two different
    // headers, one digest, one block hash.
    const shifted = makeHeader({
      parentHash: new Uint8Array(31).fill(0xaa),
      stateRoot: new Uint8Array([0xaa, ...new Uint8Array(32).fill(0xbb)]),
    })
    const normal = makeHeader()

    expect(toHex(encodeBlockHeader(shifted))).not.toBe(toHex(encodeBlockHeader(normal)))
  })

  it('rejects a block number or timestamp that does not fit its fixed-width field', () => {
    // Out of range used to be silently truncated to the high 8 bytes, so two
    // different block numbers encoded identically.
    expect(() => encodeBlockHeader(makeHeader({ number: 2n ** 64n }))).toThrow(/out of range/)
    expect(() => encodeBlockHeader(makeHeader({ number: 2n ** 64n - 1n }))).not.toThrow()
  })

  it('gives two state entries that split the same bytes differently different encodings', () => {
    const a = encodeStateEntry(new Uint8Array([0xab]), new Uint8Array([0xcd]))
    const b = encodeStateEntry(new Uint8Array([0xab, 0xcd]), new Uint8Array(0))
    expect(toHex(a)).not.toBe(toHex(b))
  })

  it('tags each structure with a distinct domain byte', () => {
    const tags = Object.values(Domain)
    expect(new Set(tags).size).toBe(tags.length)
  })
})
