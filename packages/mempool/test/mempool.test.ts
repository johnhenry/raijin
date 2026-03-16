import { describe, it, expect, beforeEach } from 'vitest'
import type { Transaction } from 'raijin-core'
import { Mempool } from '../src/mempool.js'
import { orderByFee, defaultFeeExtractor } from '../src/ordering.js'
import type { GossipTransport, TransactionVerifier } from '../src/types.js'

// ── Helpers ──

/** Always-valid verifier. */
const validVerifier: TransactionVerifier = async () => true

/** Always-invalid verifier. */
const invalidVerifier: TransactionVerifier = async () => false

/** Encode a fee as 8-byte big-endian in tx.data. */
function encodeFee(fee: bigint): Uint8Array {
  const bytes = new Uint8Array(8)
  let val = fee
  for (let i = 7; i >= 0; i--) {
    bytes[i] = Number(val & 0xffn)
    val >>= 8n
  }
  return bytes
}

/** Create a test transaction with configurable fields. */
function makeTx(opts: {
  sender?: number
  nonce?: bigint
  fee?: bigint
  value?: bigint
}): Transaction {
  const sender = new Uint8Array(32)
  sender[0] = opts.sender ?? 1
  return {
    from: sender,
    nonce: opts.nonce ?? 0n,
    to: new Uint8Array(32),
    value: opts.value ?? 0n,
    data: encodeFee(opts.fee ?? 100n),
    signature: new Uint8Array(64),
    chainId: 1n,
  }
}

describe('Mempool', () => {
  let pool: Mempool

  beforeEach(() => {
    pool = new Mempool({ verifier: validVerifier })
  })

  describe('submit', () => {
    it('accepts a valid transaction', async () => {
      const tx = makeTx({ sender: 1, nonce: 0n })
      const accepted = await pool.submit(tx)
      expect(accepted).toBe(true)
      expect(pool.size).toBe(1)
    })

    it('rejects a transaction with invalid signature', async () => {
      const pool = new Mempool({ verifier: invalidVerifier })
      const tx = makeTx({ sender: 1, nonce: 0n })
      const accepted = await pool.submit(tx)
      expect(accepted).toBe(false)
      expect(pool.size).toBe(0)
    })

    it('rejects duplicate sender+nonce', async () => {
      const tx1 = makeTx({ sender: 1, nonce: 0n, fee: 100n })
      const tx2 = makeTx({ sender: 1, nonce: 0n, fee: 200n })
      await pool.submit(tx1)
      const accepted = await pool.submit(tx2)
      expect(accepted).toBe(false)
      expect(pool.size).toBe(1)
    })

    it('accepts different nonces from same sender', async () => {
      const tx1 = makeTx({ sender: 1, nonce: 0n })
      const tx2 = makeTx({ sender: 1, nonce: 1n })
      await pool.submit(tx1)
      await pool.submit(tx2)
      expect(pool.size).toBe(2)
    })

    it('accepts same nonce from different senders', async () => {
      const tx1 = makeTx({ sender: 1, nonce: 0n })
      const tx2 = makeTx({ sender: 2, nonce: 0n })
      await pool.submit(tx1)
      await pool.submit(tx2)
      expect(pool.size).toBe(2)
    })
  })

  describe('remove', () => {
    it('removes an existing transaction', async () => {
      const tx = makeTx({ sender: 1, nonce: 0n })
      await pool.submit(tx)
      expect(pool.remove(tx)).toBe(true)
      expect(pool.size).toBe(0)
    })

    it('returns false for non-existent transaction', () => {
      const tx = makeTx({ sender: 1, nonce: 0n })
      expect(pool.remove(tx)).toBe(false)
    })

    it('removeBatch removes multiple transactions', async () => {
      const tx1 = makeTx({ sender: 1, nonce: 0n })
      const tx2 = makeTx({ sender: 2, nonce: 0n })
      const tx3 = makeTx({ sender: 3, nonce: 0n })
      await pool.submit(tx1)
      await pool.submit(tx2)
      await pool.submit(tx3)
      const removed = pool.removeBatch([tx1, tx3])
      expect(removed).toBe(2)
      expect(pool.size).toBe(1)
    })
  })

  describe('ordering', () => {
    it('pending() returns transactions ordered by fee descending', async () => {
      const txLow = makeTx({ sender: 1, nonce: 0n, fee: 10n })
      const txMid = makeTx({ sender: 2, nonce: 0n, fee: 50n })
      const txHigh = makeTx({ sender: 3, nonce: 0n, fee: 100n })
      await pool.submit(txLow)
      await pool.submit(txMid)
      await pool.submit(txHigh)

      const pending = pool.pending()
      expect(pending.length).toBe(3)
      expect(defaultFeeExtractor(pending[0])).toBe(100n)
      expect(defaultFeeExtractor(pending[1])).toBe(50n)
      expect(defaultFeeExtractor(pending[2])).toBe(10n)
    })

    it('tie-breaks by nonce ascending', () => {
      const tx1 = makeTx({ sender: 1, nonce: 5n, fee: 100n })
      const tx2 = makeTx({ sender: 2, nonce: 1n, fee: 100n })
      const sorted = orderByFee([tx1, tx2], defaultFeeExtractor)
      expect(sorted[0].nonce).toBe(1n)
      expect(sorted[1].nonce).toBe(5n)
    })
  })

  describe('pendingForProposer', () => {
    it('returns limited number of transactions', async () => {
      for (let i = 0; i < 5; i++) {
        await pool.submit(makeTx({ sender: i + 1, nonce: 0n, fee: BigInt(i * 10) }))
      }
      const batch = pool.pendingForProposer(3)
      expect(batch.length).toBe(3)
      // Should be the top-3 by fee
      expect(defaultFeeExtractor(batch[0])).toBe(40n)
      expect(defaultFeeExtractor(batch[1])).toBe(30n)
      expect(defaultFeeExtractor(batch[2])).toBe(20n)
    })
  })

  describe('eviction', () => {
    it('evicts lowest-fee tx when pool is full', async () => {
      const smallPool = new Mempool({ verifier: validVerifier, maxSize: 2 })
      await smallPool.submit(makeTx({ sender: 1, nonce: 0n, fee: 10n }))
      await smallPool.submit(makeTx({ sender: 2, nonce: 0n, fee: 20n }))
      // Pool is full. Submit higher-fee tx.
      const accepted = await smallPool.submit(makeTx({ sender: 3, nonce: 0n, fee: 30n }))
      expect(accepted).toBe(true)
      expect(smallPool.size).toBe(2)
      // The 10n-fee tx should have been evicted
      const pending = smallPool.pending()
      const fees = pending.map(defaultFeeExtractor)
      expect(fees).toEqual([30n, 20n])
    })

    it('rejects tx when pool is full and fee is too low', async () => {
      const smallPool = new Mempool({ verifier: validVerifier, maxSize: 2 })
      await smallPool.submit(makeTx({ sender: 1, nonce: 0n, fee: 20n }))
      await smallPool.submit(makeTx({ sender: 2, nonce: 0n, fee: 30n }))
      const accepted = await smallPool.submit(makeTx({ sender: 3, nonce: 0n, fee: 10n }))
      expect(accepted).toBe(false)
      expect(smallPool.size).toBe(2)
    })
  })

  describe('events', () => {
    it('emits onAccepted when a transaction is accepted', async () => {
      const accepted: Transaction[] = []
      pool.onAccepted((tx) => accepted.push(tx))

      await pool.submit(makeTx({ sender: 1, nonce: 0n }))
      expect(accepted.length).toBe(1)
    })

    it('emits onDropped with reason for rejected transactions', async () => {
      const dropped: Array<{ tx: Transaction; reason: string }> = []
      pool.onDropped((tx, reason) => dropped.push({ tx, reason }))

      const tx1 = makeTx({ sender: 1, nonce: 0n })
      const tx2 = makeTx({ sender: 1, nonce: 0n }) // duplicate
      await pool.submit(tx1)
      await pool.submit(tx2)

      expect(dropped.length).toBe(1)
      expect(dropped[0].reason).toBe('duplicate')
    })

    it('emits onDropped with invalid-signature reason', async () => {
      const pool = new Mempool({ verifier: invalidVerifier })
      const dropped: string[] = []
      pool.onDropped((_, reason) => dropped.push(reason))

      await pool.submit(makeTx({ sender: 1, nonce: 0n }))
      expect(dropped).toEqual(['invalid-signature'])
    })
  })

  describe('gossip', () => {
    it('broadcasts accepted transactions via gossip transport', async () => {
      const broadcasted: Transaction[] = []
      const gossip: GossipTransport = {
        broadcast: (tx) => broadcasted.push(tx),
      }
      const pool = new Mempool({ verifier: validVerifier, gossip })

      await pool.submit(makeTx({ sender: 1, nonce: 0n }))
      expect(broadcasted.length).toBe(1)
    })

    it('does not broadcast rejected transactions', async () => {
      const broadcasted: Transaction[] = []
      const gossip: GossipTransport = {
        broadcast: (tx) => broadcasted.push(tx),
      }
      const pool = new Mempool({ verifier: invalidVerifier, gossip })

      await pool.submit(makeTx({ sender: 1, nonce: 0n }))
      expect(broadcasted.length).toBe(0)
    })
  })

  describe('nonce tracking', () => {
    it('tracks nonces per sender', async () => {
      const tx = makeTx({ sender: 1, nonce: 42n })
      await pool.submit(tx)
      expect(pool.hasNonce(tx.from, 42n)).toBe(true)
      expect(pool.hasNonce(tx.from, 0n)).toBe(false)
    })

    it('untracks nonce on remove', async () => {
      const tx = makeTx({ sender: 1, nonce: 42n })
      await pool.submit(tx)
      pool.remove(tx)
      expect(pool.hasNonce(tx.from, 42n)).toBe(false)
    })
  })
})
