/**
 * Mempool types for Raijin.
 */

import type { Transaction } from '@johnhenry/raijin-core'

/** Transport for gossiping transactions to peers. */
export interface GossipTransport {
  /** Broadcast a transaction to all connected peers. */
  broadcast(tx: Transaction): void
}

/** Function that extracts fee from a transaction. */
export type FeeExtractor = (tx: Transaction) => bigint

/** Function that verifies a transaction signature. */
export type TransactionVerifier = (tx: Transaction) => Promise<boolean>

/** Events emitted by the mempool. */
export interface MempoolEvents {
  onAccepted: (tx: Transaction) => void
  onDropped: (tx: Transaction, reason: string) => void
}

/** Configuration for the mempool. */
export interface MempoolConfig {
  /** Maximum number of transactions in the pool. Default: 4096. */
  maxSize?: number
  /** Verify transaction signatures. */
  verifier: TransactionVerifier
  /** Extract fee from a transaction. Default: reads an 8-byte big-endian
   *  uint64 from `tx.data[1..9]` (byte 0 is reserved for the tx type byte —
   *  see `defaultFeeExtractor` in ordering.ts). Falls back to 0n if `data`
   *  is too short. */
  feeExtractor?: FeeExtractor
  /** Optional gossip transport for propagating transactions. */
  gossip?: GossipTransport
}
