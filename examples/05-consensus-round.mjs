/**
 * 05 — PBFT quorum math and a single-validator consensus round
 *      (@johnhenry/raijin-consensus)
 *
 * First: the quorum table. quorum = 2f+1 with f = floor((n-1)/3), so with
 * 1, 2, or 3 validators f = 0 and quorum = 1 — a single node finalizes
 * alone. Byzantine fault tolerance only starts at n = 4.
 *
 * Then: a full propose → pre-prepare → prepare → commit → finalize round
 * with one validator (quorum 1), driven entirely in-process. Multi-node
 * rounds live in the repo's test-harness package.
 *
 * Run: npm run example:05
 */
import assert from 'node:assert/strict'
import { StateMachine, InMemoryStateStore } from '@johnhenry/raijin-core'
import { PBFTConsensus, ValidatorSet, PBFTPhase } from '@johnhenry/raijin-consensus'

// ── Quorum table ──────────────────────────────────────────────────────
console.log(' n | maxFaults | quorum')
for (let n = 1; n <= 7; n++) {
  const set = new ValidatorSet(
    Array.from({ length: n }, (_, i) => new Uint8Array(32).fill(i + 1)),
  )
  console.log(String(n).padStart(2), '|', String(set.maxFaults).padStart(9), '|', set.quorumSize())
}

// ── Single-validator round ────────────────────────────────────────────
const me = new Uint8Array(32).fill(7)
const validators = new ValidatorSet([me])

const store = new InMemoryStateStore()
const stateMachine = new StateMachine(store, { verify: async () => true })

// Transport and timer are injected. Single node: broadcast goes nowhere,
// and a manual timer means nothing fires unless we drive it.
const transport = { broadcast() {}, send() {}, onMessage() {} }
const manualTimer = { set: () => ({}), clear: () => {} }

const consensus = new PBFTConsensus({
  identity: me,
  validators,
  transport,
  timer: manualTimer,
  stateMachine,
  sign: async () => new Uint8Array(64), // inject a real signer in production
  verify: { verify: async () => true }, // inject a real verifier in production (e.g. Ed25519)
})

const finalized = new Promise((resolve) => {
  consensus.onBlockFinalized((block, receipts) => resolve({ block, receipts }))
})

consensus.start()
assert.equal(consensus.isLeader, true) // sole validator = leader for view 0
assert.equal(consensus.phase, PBFTPhase.Idle)

await consensus.propose({
  header: {
    number: 1n,
    parentHash: new Uint8Array(32),
    stateRoot: new Uint8Array(32),
    txRoot: new Uint8Array(32),
    receiptRoot: new Uint8Array(32),
    timestamp: Date.now(),
    proposer: me,
  },
  transactions: [],
  signatures: [],
})

// Quorum is 1, so our own PREPARE and COMMIT complete the round.
const { block, receipts } = await finalized
console.log('finalized block', block.header.number, 'with', receipts.length, 'receipts')
assert.equal(block.header.number, 1n)
assert.equal(consensus.phase, PBFTPhase.Idle) // reset for the next round
assert.equal(consensus.currentSequence, 1n)

consensus.stop()
console.log('05-consensus-round: OK')
