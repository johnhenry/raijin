/**
 * Simple in-memory transaction mempool.
 * Holds unconfirmed transactions until they are included in a block.
 */

import type { Transaction } from 'raijin-core'
import { hash, encodeTxSigned, toHex } from 'raijin-core'

export class Mempool {
  #pending = new Map<string, Transaction>()
  #maxSize: number

  constructor(maxSize = 4096) {
    this.#maxSize = maxSize
  }

  /** Add a transaction to the mempool. Returns the tx hash hex. */
  async add(tx: Transaction): Promise<string> {
    const txHash = await hash(encodeTxSigned(tx))
    const hex = toHex(txHash)

    if (this.#pending.size >= this.#maxSize) {
      throw new Error('Mempool full')
    }

    this.#pending.set(hex, tx)
    return hex
  }

  /** Get up to `limit` pending transactions (FIFO order). */
  pending(limit?: number): Transaction[] {
    const all = [...this.#pending.values()]
    return limit !== undefined ? all.slice(0, limit) : all
  }

  /** Remove transactions by their signed-encoding hashes. */
  async removeBatch(txs: Transaction[]): Promise<void> {
    for (const tx of txs) {
      const txHash = await hash(encodeTxSigned(tx))
      const hex = toHex(txHash)
      this.#pending.delete(hex)
    }
  }

  /** Remove a single transaction by hash hex. */
  remove(hashHex: string): boolean {
    return this.#pending.delete(hashHex)
  }

  /** Number of pending transactions. */
  get size(): number {
    return this.#pending.size
  }

  /** Clear all pending transactions. */
  clear(): void {
    this.#pending.clear()
  }
}
