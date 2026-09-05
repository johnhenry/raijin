/**
 * 02 — State machine transfers and revert receipts (@johnhenry/raijin-core)
 *
 * Applies transactions to an InMemoryStateStore through the StateMachine.
 * Shows a successful transfer, an insufficient-balance revert, and a
 * nonce-mismatch revert. Failed transactions produce revert receipts —
 * they do not throw.
 *
 * Run: npm run example:02
 */
import assert from 'node:assert/strict'
import {
  accountKey,
  StateMachine,
  InMemoryStateStore,
  TransactionType,
  encodeAccount,
  toHex,
} from '@johnhenry/raijin-core'

// A signature verifier is injected — this example trusts everything.
// Example 07 shows a real Ed25519 verifier.
const trustEverything = { verify: async () => true }

const store = new InMemoryStateStore()
const sm = new StateMachine(store, trustEverything)

const alice = new Uint8Array(32).fill(1)
const bob = new Uint8Array(32).fill(2)

// Fund alice directly in the store (genesis-style). Account state lives
// under the 'account:' namespace; `accountKey` builds the canonical key
// bytes, which are hashed into the state root — don't hand-roll them.
await store.put(accountKey(alice), encodeAccount({ balance: 1000n, nonce: 0n, reputation: 0n }))

function transfer(from, to, value, nonce) {
  return {
    from,
    to,
    value,
    nonce,
    data: new Uint8Array([TransactionType.Transfer]), // first data byte = tx type
    signature: new Uint8Array(64),
    chainId: 1n,
  }
}

// 1. Successful transfer
const r1 = await sm.applyTransaction(transfer(alice, bob, 250n, 0n), 0)
assert.equal(r1.status, 'success')
console.log('transfer 250:', r1.status, toHex(r1.txHash).slice(0, 16) + '…')

// 2. Overspend — reverts, state untouched
const r2 = await sm.applyTransaction(transfer(alice, bob, 10_000n, 1n), 1)
assert.equal(r2.status, 'revert')
console.log('overspend:   ', r2.status, '—', r2.revertReason)

// 3. Wrong nonce — reverts (the failed tx above did NOT consume nonce 1)
const r3 = await sm.applyTransaction(transfer(alice, bob, 1n, 5n), 2)
assert.equal(r3.status, 'revert')
console.log('bad nonce:   ', r3.status, '—', r3.revertReason)

// Final balances
const a = await sm.getAccount(alice)
const b = await sm.getAccount(bob)
assert.equal(a.balance, 750n)
assert.equal(b.balance, 250n)
console.log('alice:', a, '\nbob:  ', b)
console.log('state root =', toHex(await sm.stateRoot()).slice(0, 16) + '…')

console.log('02-state-machine: OK')
