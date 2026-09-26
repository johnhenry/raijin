/**
 * Fee-based priority ordering for the mempool.
 *
 * Orders transactions by fee among transaction *heads* — the lowest-pending-
 * nonce transaction per sender — rather than by fee across every pending
 * transaction regardless of sender/nonce. See `orderByFee`'s docs for why a
 * flat fee sort is wrong here.
 */

import type { Transaction } from '@johnhenry/raijin-core'
import { toHex } from '@johnhenry/raijin-core'
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

/**
 * Order transactions for block building: by fee among transaction *heads*
 * (the lowest-pending-nonce transaction per sender), not by fee across all
 * pending transactions regardless of sender/nonce.
 *
 * The state machine applies transactions in the order a block lists them
 * and requires each sender's nonce to arrive in sequence (see
 * `StateMachine#applyTransaction`'s "nonce mismatch" revert) — a sender's
 * own transactions must therefore never be reordered relative to each
 * other, no matter what they bid. A flat fee sort doesn't know that: if a
 * sender has nonce 0 pending at a low fee and then submits nonce 1 at a
 * much higher fee (e.g. because they want THAT transfer prioritized, or
 * they're simply not blocked on the first one landing first), a flat sort
 * would place nonce 1 ahead of nonce 0. If a block-size limit then cuts the
 * list after nonce 1, or the state machine simply applies the list in that
 * order, nonce 1 executes before nonce 0 ever does and reverts with a
 * nonce-mismatch — the transaction with the higher fee never actually gets
 * to "outbid" and replace anything; it just breaks.
 *
 * The fix: group by sender, keep each sender's transactions in nonce order,
 * and let only the *head* of each sender's queue (its lowest pending nonce)
 * compete on fee against other senders' heads. Whichever head currently has
 * the highest fee is picked next; picking it advances that sender's queue,
 * exposing its next transaction as the new head. This is the standard
 * "merge of per-sender nonce-ordered queues, ranked by head fee" mempool
 * ordering — every sender's own transactions still come out in nonce order,
 * but senders compete against each other purely on fee.
 */
export function orderByFee(txs: Transaction[], feeExtractor: FeeExtractor): Transaction[] {
  const bySender = new Map<string, Transaction[]>()
  for (const tx of txs) {
    const key = toHex(tx.from)
    const group = bySender.get(key)
    if (group) {
      group.push(tx)
    } else {
      bySender.set(key, [tx])
    }
  }

  const queues: Transaction[][] = []
  for (const group of bySender.values()) {
    group.sort((a, b) => (a.nonce < b.nonce ? -1 : a.nonce > b.nonce ? 1 : 0))
    queues.push(group)
  }
  const cursors = new Array(queues.length).fill(0)

  const result: Transaction[] = []
  for (let picked = 0; picked < txs.length; picked++) {
    let bestQueue = -1
    let bestFee = 0n
    let bestNonce = 0n

    for (let i = 0; i < queues.length; i++) {
      if (cursors[i] >= queues[i].length) continue
      const head = queues[i][cursors[i]]
      const fee = feeExtractor(head)
      // Tie-break: lower nonce first, matching the old flat sort's
      // tie-break (now compared across senders' heads instead of globally).
      if (bestQueue === -1 || fee > bestFee || (fee === bestFee && head.nonce < bestNonce)) {
        bestQueue = i
        bestFee = fee
        bestNonce = head.nonce
      }
    }

    // Unreachable while `picked < txs.length`, since the total transactions
    // left across all queues always equals `txs.length - picked`.
    if (bestQueue === -1) break

    result.push(queues[bestQueue][cursors[bestQueue]])
    cursors[bestQueue]++
  }

  return result
}
