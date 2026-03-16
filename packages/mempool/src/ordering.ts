/**
 * Fee-based priority ordering for the mempool.
 *
 * Sorts transactions by fee (highest first), breaking ties by nonce (lowest first).
 */

import type { Transaction } from 'raijin-core'
import type { FeeExtractor } from './types.js'

/** Default fee extractor: uses the `data` field's first 8 bytes as a big-endian bigint fee.
 *  Falls back to 0n if data is too short. */
export function defaultFeeExtractor(tx: Transaction): bigint {
  // Convention: first 8 bytes of tx.data encode the fee as big-endian uint64
  if (tx.data.length >= 8) {
    let fee = 0n
    for (let i = 0; i < 8; i++) {
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
