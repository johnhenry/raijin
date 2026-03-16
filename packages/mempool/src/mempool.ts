/**
 * Transaction mempool for Raijin.
 *
 * Accepts transactions, validates signatures, deduplicates by sender+nonce,
 * orders by fee for block building, and evicts lowest-fee transactions when full.
 */

import type { Transaction } from 'raijin-core'
import { toHex } from 'raijin-core'
import type { MempoolConfig, MempoolEvents, FeeExtractor, GossipTransport, TransactionVerifier } from './types.js'
import { defaultFeeExtractor, orderByFee } from './ordering.js'

/** Unique key for a transaction: sender hex + nonce. */
function txKey(tx: Transaction): string {
  return `${toHex(tx.from)}:${tx.nonce}`
}

export class Mempool {
  #txs = new Map<string, Transaction>()
  #maxSize: number
  #verifier: TransactionVerifier
  #feeExtractor: FeeExtractor
  #gossip: GossipTransport | null
  #senderNonces = new Map<string, Set<bigint>>() // sender hex → set of nonces seen

  // ── Event handlers ──
  #onAccepted: ((tx: Transaction) => void)[] = []
  #onDropped: ((tx: Transaction, reason: string) => void)[] = []

  constructor(config: MempoolConfig) {
    this.#maxSize = config.maxSize ?? 4096
    this.#verifier = config.verifier
    this.#feeExtractor = config.feeExtractor ?? defaultFeeExtractor
    this.#gossip = config.gossip ?? null
  }

  /** Submit a transaction to the mempool. Returns true if accepted. */
  async submit(tx: Transaction): Promise<boolean> {
    const key = txKey(tx)

    // Duplicate check (same sender + same nonce)
    if (this.#txs.has(key)) {
      this.#emitDropped(tx, 'duplicate')
      return false
    }

    // Signature verification
    const valid = await this.#verifier(tx)
    if (!valid) {
      this.#emitDropped(tx, 'invalid-signature')
      return false
    }

    // If at capacity, check if this tx has higher fee than the lowest
    if (this.#txs.size >= this.#maxSize) {
      const evicted = this.#evictLowest(tx)
      if (!evicted) {
        this.#emitDropped(tx, 'pool-full')
        return false
      }
    }

    // Accept
    this.#txs.set(key, tx)
    this.#trackNonce(tx)
    this.#emitAccepted(tx)

    // Gossip to peers
    if (this.#gossip) {
      this.#gossip.broadcast(tx)
    }

    return true
  }

  /** Remove a transaction (e.g., after inclusion in a block). */
  remove(tx: Transaction): boolean {
    const key = txKey(tx)
    const existed = this.#txs.delete(key)
    if (existed) {
      this.#untrackNonce(tx)
    }
    return existed
  }

  /** Remove multiple transactions by sender+nonce pairs. */
  removeBatch(txs: Transaction[]): number {
    let count = 0
    for (const tx of txs) {
      if (this.remove(tx)) count++
    }
    return count
  }

  /** Get all pending transactions, ordered by fee (highest first). */
  pending(): Transaction[] {
    return orderByFee([...this.#txs.values()], this.#feeExtractor)
  }

  /** Get pending transactions filtered for a specific proposer's block.
   *  Returns fee-ordered transactions, respecting per-sender nonce ordering. */
  pendingForProposer(limit?: number): Transaction[] {
    const ordered = this.pending()
    if (limit !== undefined && limit < ordered.length) {
      return ordered.slice(0, limit)
    }
    return ordered
  }

  /** Current number of transactions in the pool. */
  get size(): number {
    return this.#txs.size
  }

  /** Whether a transaction with the given sender+nonce exists. */
  has(tx: Transaction): boolean {
    return this.#txs.has(txKey(tx))
  }

  /** Check if a nonce has been seen for a sender. */
  hasNonce(sender: Uint8Array, nonce: bigint): boolean {
    const senderHex = toHex(sender)
    return this.#senderNonces.get(senderHex)?.has(nonce) ?? false
  }

  /** Register a callback for accepted transactions. */
  onAccepted(handler: (tx: Transaction) => void): void {
    this.#onAccepted.push(handler)
  }

  /** Register a callback for dropped transactions. */
  onDropped(handler: (tx: Transaction, reason: string) => void): void {
    this.#onDropped.push(handler)
  }

  // ── Private ──

  #trackNonce(tx: Transaction): void {
    const senderHex = toHex(tx.from)
    if (!this.#senderNonces.has(senderHex)) {
      this.#senderNonces.set(senderHex, new Set())
    }
    this.#senderNonces.get(senderHex)!.add(tx.nonce)
  }

  #untrackNonce(tx: Transaction): void {
    const senderHex = toHex(tx.from)
    const nonces = this.#senderNonces.get(senderHex)
    if (nonces) {
      nonces.delete(tx.nonce)
      if (nonces.size === 0) this.#senderNonces.delete(senderHex)
    }
  }

  /** Try to evict the lowest-fee transaction to make room.
   *  Returns true if eviction succeeded (new tx has higher fee). */
  #evictLowest(incoming: Transaction): boolean {
    const all = [...this.#txs.values()]
    // Find the lowest-fee tx
    let lowestFee = this.#feeExtractor(all[0])
    let lowestKey = txKey(all[0])
    let lowestTx = all[0]

    for (let i = 1; i < all.length; i++) {
      const fee = this.#feeExtractor(all[i])
      if (fee < lowestFee) {
        lowestFee = fee
        lowestKey = txKey(all[i])
        lowestTx = all[i]
      }
    }

    const incomingFee = this.#feeExtractor(incoming)
    if (incomingFee <= lowestFee) {
      return false // Incoming tx doesn't beat the lowest
    }

    // Evict
    this.#txs.delete(lowestKey)
    this.#untrackNonce(lowestTx)
    this.#emitDropped(lowestTx, 'evicted')
    return true
  }

  #emitAccepted(tx: Transaction): void {
    for (const h of this.#onAccepted) h(tx)
  }

  #emitDropped(tx: Transaction, reason: string): void {
    for (const h of this.#onDropped) h(tx, reason)
  }
}
