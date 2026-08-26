/**
 * Fee-based priority ordering for the mempool.
 *
 * Sorts transactions by fee (highest first), breaking ties by nonce (lowest first).
 */

import type { Transaction } from '@johnhenry/raijin-core'
import type { FeeExtractor } from './types.js'

/** `tx.data` byte offset where the default fee convention starts.
 *  Byte 0 is reserved for the transaction type discriminant
 *  (see `TransactionType` / `StateMachine#applyTransaction`'s `tx.data[0]`
 *  read) — the fee bytes must NOT overlap it, or a transaction following
 *  both conventions would corrupt its own type byte. */
const FEE_OFFSET = 1
const FEE_LENGTH = 8

/** Default fee extractor: uses 8 bytes of the `data` field (starting after
 *  the reserved type byte, see `FEE_OFFSET`) as a big-endian bigint fee.
 *  Falls back to 0n if data is too short. */
export function defaultFeeExtractor(tx: Transaction): bigint {
  // Convention: tx.data[FEE_OFFSET .. FEE_OFFSET+8) encodes the fee as a
  // big-endian uint64. tx.data[0] is left untouched for the tx type byte.
  if (tx.data.length >= FEE_OFFSET + FEE_LENGTH) {
    let fee = 0n
    for (let i = FEE_OFFSET; i < FEE_OFFSET + FEE_LENGTH; i++) {
      fee = (fee << 8n) | BigInt(tx.data[i])
    }
    return fee
  }
  return 0n
}

/** Sort transactions by fee descending, then by nonce ascending. */
export function orderByFee(txs: Transaction[], feeExtractor: FeeExtractor): Transaction[] {
  return [...txs].sort((a, b) => {
    const feeA = feeExtractor(a)
    const feeB = feeExtractor(b)
    if (feeB !== feeA) return feeB > feeA ? 1 : -1
    // Tie-break: lower nonce first
    if (a.nonce !== b.nonce) return a.nonce < b.nonce ? -1 : 1
    return 0
  })
}
