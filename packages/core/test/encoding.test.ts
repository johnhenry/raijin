import { describe, it, expect } from 'vitest'
import {
  encodeBigInt,
  decodeBigInt,
  encodeBytes,
  decodeBytes,
  encodeAccount,
  decodeAccount,
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
