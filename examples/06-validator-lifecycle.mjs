/**
 * 06 — ValidatorNode lifecycle (@johnhenry/raijin-validator)
 *
 * The composition root: state machine + PBFT consensus + FIFO mempool +
 * block producer wired together. Single validator, real timers, one
 * block: submit a transaction, let the block timer fire, watch it
 * finalize, then stop cleanly.
 *
 * Run: npm run example:06
 */
import assert from 'node:assert/strict'
import {
  InMemoryStateStore,
  TransactionType,
  encodeAccount,
  toHex,
} from '@johnhenry/raijin-core'
import { ValidatorNode } from '@johnhenry/raijin-validator'

const alice = new Uint8Array(32).fill(1)
const bob = new Uint8Array(32).fill(2)

// Fund alice at genesis
const store = new InMemoryStateStore()
const prefix = new TextEncoder().encode('account:')
await store.put(
  new Uint8Array([...prefix, ...alice]),
  encodeAccount({ balance: 10_000n, nonce: 0n, reputation: 0n }),
)

const node = new ValidatorNode({
  identity: {
    publicKey: alice,
    sign: async () => new Uint8Array(64), // consensus-message signer
    verify: { verify: async () => true }, // transaction-signature verifier
  },
  // Single node: no peers to talk to. With >1 validator this must be a
  // real transport (WebRTC, WebSocket, …).
  transport: { broadcast() {}, send() {}, onMessage() {} },
  // Real timers drive block production
  timer: {
    set: (ms, cb) => setTimeout(cb, ms),
    clear: (h) => clearTimeout(h),
  },
  store,
  validators: [alice], // must include self, or this node can never lead
  blockTime: 50,
  maxTxPerBlock: 100,
})

const finalized = new Promise((resolve) => {
  node.onBlockFinalized((block, receipts) => resolve({ block, receipts }))
})

node.start()
assert.equal(node.running, true)
assert.equal(node.latestBlock, null)

// submitTransaction does NOT verify signatures — invalid transactions are
// only caught at execution, where they produce revert receipts.
const txHash = await node.submitTransaction({
  from: alice,
  to: bob,
  value: 500n,
  nonce: 0n,
  data: new Uint8Array([TransactionType.Transfer]),
  signature: new Uint8Array(64),
  chainId: 1n,
})
console.log('submitted tx', txHash.slice(0, 16) + '…', '— mempool size:', node.mempool.size)

// The block timer fires after ~50ms, the producer pulls the mempool,
// proposes, and the single-validator quorum finalizes immediately.
const { block, receipts } = await finalized
console.log('finalized block', block.header.number,
  '| txs:', block.transactions.length,
  '| receipt:', receipts[0].status)
assert.equal(receipts[0].status, 'success')
assert.equal(node.mempool.size, 0) // included txs are removed
assert.equal(node.latestBlock, block)

const bobAccount = await node.stateMachine.getAccount(bob)
assert.equal(bobAccount.balance, 500n)
console.log('bob balance:', bobAccount.balance, '| state root:',
  toHex(await node.stateMachine.stateRoot()).slice(0, 16) + '…')

node.stop()
assert.equal(node.running, false)
console.log('06-validator-lifecycle: OK')
