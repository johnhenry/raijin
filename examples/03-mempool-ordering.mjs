/**
 * 03 — Mempool fee ordering and eviction (@johnhenry/raijin-mempool)
 *
 * The default fee convention: the FIRST 8 BYTES of tx.data are the fee,
 * big-endian. This collides with the state machine's convention (first
 * data byte = transaction type) — real deployments supply their own
 * FeeExtractor. Here we use the default to show the mechanics.
 *
 * Run: npm run example:03
 */
import assert from 'node:assert/strict'
import { Mempool, orderByFee, defaultFeeExtractor } from '@johnhenry/raijin-mempool'

function encodeFee(fee) {
  const bytes = new Uint8Array(8)
  let v = fee
  for (let i = 7; i >= 0; i--) {
    bytes[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return bytes
}

function tx(senderId, nonce, fee) {
  const from = new Uint8Array(32)
  from[0] = senderId
  return {
    from,
    nonce,
    to: new Uint8Array(32),
    value: 0n,
    data: encodeFee(fee),
    signature: new Uint8Array(64),
    chainId: 1n,
  }
}

const pool = new Mempool({
  verifier: async () => true, // inject your real signature check here
  maxSize: 3,
})

const dropped = []
pool.onDropped((t, reason) => dropped.push(reason))

await pool.submit(tx(1, 0n, 10n))
await pool.submit(tx(2, 0n, 50n))
await pool.submit(tx(3, 0n, 30n))

// pending() is fee-descending
console.log('pending fees:', pool.pending().map(defaultFeeExtractor)) // [50n, 30n, 10n]
assert.deepEqual(pool.pending().map(defaultFeeExtractor), [50n, 30n, 10n])

// Pool is full (maxSize 3). A higher-fee tx evicts the lowest…
await pool.submit(tx(4, 0n, 99n))
assert.deepEqual(pool.pending().map(defaultFeeExtractor), [99n, 50n, 30n])
console.log('after 99n submit:', pool.pending().map(defaultFeeExtractor), '— dropped:', dropped)

// …but an EQUAL-fee tx does not (eviction requires strictly higher fee)
const accepted = await pool.submit(tx(5, 0n, 30n))
assert.equal(accepted, false)
console.log('equal-fee submit accepted?', accepted, '— reason:', dropped.at(-1))

// Duplicate sender+nonce is rejected regardless of fee
const dup = await pool.submit(tx(4, 0n, 500n))
assert.equal(dup, false)
assert.equal(dropped.at(-1), 'duplicate')

// Proposers take the top-N by fee
console.log('top-2 for block:', pool.pendingForProposer(2).map(defaultFeeExtractor))
assert.equal(pool.pendingForProposer(2).length, 2)

// orderByFee is usable standalone, with any fee extractor
const byValue = orderByFee(pool.pending(), (t) => t.value)
assert.equal(byValue.length, pool.size)

console.log('03-mempool-ordering: OK')
