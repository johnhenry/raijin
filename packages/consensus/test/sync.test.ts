/**
 * PBFTConsensus sync/catch-up (issue #45).
 *
 * A validator that crashes or is partitioned away had, until now, no way to
 * come back: it didn't know the current view, had missed finalized blocks,
 * and held none of the signed votes that justify whatever view it should be
 * in. `exportSyncState`/`importSyncState` close that gap. These tests cover
 * the two things a rejoining node actually needs and must not just take on
 * faith:
 *
 *  - The round already in flight (its PRE-PREPARE and whatever PREPARE/
 *    COMMIT votes a peer has collected so far), so it can finish
 *    participating in that exact round instead of only being able to join
 *    at the next one.
 *  - The current view, backed by its real VIEW-CHANGE quorum — not a bare
 *    assertion from whichever peer it asks.
 *
 * `ValidatorNode.importSyncState`/`ValidatorNode.syncFrom` (which also
 * transfer application state via the store's `exportData`/`importData`) are
 * exercised end-to-end with the real test-harness transport/orchestrator in
 * packages/test-harness/test/validator-catch-up.test.ts; this file isolates
 * the consensus-level mechanics with full control over message delivery.
 */

import { describe, it, expect, beforeEach } from 'vitest'

import { StateMachine, InMemoryStateStore, type Block } from '@johnhenry/raijin-core'
import { PBFTConsensus, ValidatorSet, PBFTPhase } from '../src/index.js'
import { voteDigest, NO_BLOCK_DIGEST } from '../src/vote.js'
import type { ViewChangeMessage } from '../src/types.js'
import { DeterministicNetwork, MockTimer, mockVerifier, mockSign, makeTestKey } from './helpers.js'

function makeBlock(number: bigint, proposer: Uint8Array): Block {
  return {
    header: {
      number,
      parentHash: new Uint8Array(32),
      stateRoot: new Uint8Array(32),
      txRoot: new Uint8Array(32),
      receiptRoot: new Uint8Array(32),
      timestamp: Date.now(),
      proposer,
    },
    transactions: [],
    signatures: [],
  }
}

const TEST_CHAIN_ID = 1n

describe('PBFTConsensus sync/catch-up (issue #45)', () => {
  const key1 = makeTestKey(1)
  const key2 = makeTestKey(2)
  const key3 = makeTestKey(3)
  const key4 = makeTestKey(4)

  let network: DeterministicNetwork
  let validators: ValidatorSet

  beforeEach(() => {
    network = new DeterministicNetwork()
    validators = new ValidatorSet([key1, key2, key3, key4])
  })

  function createPeer(key: Uint8Array) {
    const store = new InMemoryStateStore()
    const sm = new StateMachine(store, mockVerifier)
    const timer = new MockTimer()
    const transport = network.createTransport(key)
    const consensus = new PBFTConsensus({
      identity: key,
      chainId: TEST_CHAIN_ID,
      validators,
      transport,
      timer,
      stateMachine: sm,
      sign: mockSign(key),
      verify: mockVerifier,
      blockTime: 100,
      viewTimeout: 500,
    })
    return { consensus, store, timer }
  }

  /** A validly-signed VIEW-CHANGE from `key`, built the same way `PBFTConsensus` itself does. */
  async function makeViewChange(key: Uint8Array, newView: bigint, sequence: bigint): Promise<ViewChangeMessage> {
    return {
      type: 'view-change',
      newView,
      sequence,
      from: key,
      signature: await mockSign(key)(await voteDigest({
        phase: 'view-change',
        chainId: TEST_CHAIN_ID,
        epoch: await validators.epoch(),
        view: newView,
        sequence,
        digest: NO_BLOCK_DIGEST,
      })),
    }
  }

  it('adopts an in-flight round from a peer and finishes participating in it', async () => {
    // key4 ("d") is registered on the network from the start (so it
    // receives a copy of everything broadcast, the way a real transport
    // would) but never started -- modelling a validator that is down for
    // the entire round and must catch up afterward, not one that simply
    // joined late.
    const a = createPeer(key1) // leader for view 0
    const b = createPeer(key2)
    const c = createPeer(key3)
    const d = createPeer(key4)

    a.consensus.start()
    b.consensus.start()
    c.consensus.start()

    // Before any sync: d has nothing. This is the exact gap issue #45
    // describes -- no way to know the round in flight, or even that one
    // exists.
    expect(d.consensus.phase).toBe(PBFTPhase.Idle)
    expect(d.consensus.currentSequence).toBe(0n)

    const block = makeBlock(1n, key1)
    await a.consensus.propose(block)

    // Deliver messages one at a time (not drainAll) so we can capture a
    // peer's state PARTWAY through the round -- with its PRE-PREPARE
    // accepted and some, but not all, PREPARE/COMMIT votes collected. n=4,
    // f=1, quorum=3: a, b, c are exactly quorum among themselves, so the
    // round can complete without d either way; the point here is what d can
    // do with a snapshot taken before it does.
    let guard = 0
    while (c.consensus.phase !== PBFTPhase.Prepared) {
      const delivered = await network.deliver()
      if (!delivered) throw new Error('network drained before c reached Prepared -- test assumption broken')
      if (++guard > 100) throw new Error('runaway delivery loop')
    }

    const midRoundState = c.consensus.exportSyncState()
    // The snapshot is genuinely mid-round: c has already accepted the
    // PRE-PREPARE and reached a full PREPARE quorum (which is what moved it
    // to `Prepared`), but has only ITS OWN commit so far -- a and b's
    // commits are still in flight.
    expect(midRoundState.view).toBe(0n)
    expect(midRoundState.sequence).toBe(1n)
    expect(midRoundState.prePrepare).not.toBeNull()
    expect(midRoundState.prepares).toHaveLength(3)
    expect(midRoundState.commits.length).toBeGreaterThanOrEqual(1)
    expect(midRoundState.commits.length).toBeLessThan(3)

    d.consensus.start()
    await d.consensus.importSyncState(midRoundState)

    // d adopted the round immediately: right away it's at the same
    // (view, sequence) and already holds a PREPARE quorum of its own,
    // without waiting for anything more to arrive.
    expect(d.consensus.currentView).toBe(0n)
    expect(d.consensus.currentSequence).toBe(1n)
    expect(d.consensus.phase).toBe(PBFTPhase.Prepared)

    // Let the rest of the round's live messages (a's and b's own commits,
    // still in the network) play out. d is now running and registered, so
    // it receives and correctly processes them.
    while (await network.deliver()) { /* drain */ }

    // Every node -- including the one that started with nothing --
    // finalized the SAME block.
    for (const p of [a, b, c, d]) {
      expect(p.consensus.currentSequence).toBe(1n)
      expect(p.consensus.phase).toBe(PBFTPhase.Idle) // reset after finalizing
    }
    expect(await d.store.root()).toEqual(await a.store.root())
  })

  it('adopts a newer view only when backed by a real VIEW-CHANGE quorum, and verifies it rather than trusting the peer', async () => {
    const p2 = createPeer(key2)
    p2.consensus.start()

    const newView = 1n
    const sequence = 0n

    // A genuine quorum (3 of 4) moves p2 to view 1 -- exactly the live path
    // `#handleViewChange` already covers; this just sets up a peer with a
    // *real* `#viewJustification` to export.
    for (const key of [key1, key3, key4]) {
      network.createTransport(key).send(key2, await makeViewChange(key, newView, sequence))
    }
    await network.drainAll()
    expect(p2.consensus.currentView).toBe(1n)

    const exported = p2.consensus.exportSyncState()
    expect(exported.view).toBe(1n)
    expect(exported.viewChangeJustification).toHaveLength(3)

    // A rejoining peer that never saw any of this adopts the view, but only
    // after independently re-verifying the justification -- not because p2
    // said so.
    const rejoiner = createPeer(key3)
    rejoiner.consensus.start()
    await rejoiner.consensus.importSyncState(exported)
    expect(rejoiner.consensus.currentView).toBe(1n)

    // A claim of a newer view with an insufficient (or forged) quorum must
    // be rejected, not accepted on the exporting peer's word.
    const underQuorum = createPeer(key4)
    underQuorum.consensus.start()
    await expect(
      underQuorum.consensus.importSyncState({
        ...exported,
        view: 2n,
        viewChangeJustification: exported.viewChangeJustification.slice(0, 1), // only 1 of the 3 -- below quorum
      }),
    ).rejects.toThrow(/quorum/)
    expect(underQuorum.consensus.currentView).toBe(0n) // unchanged

    p2.consensus.stop()
    rejoiner.consensus.stop()
    underQuorum.consensus.stop()
  })

  /**
   * `whenIdle` (issue #47's smaller gap): `ValidatorNode.exportSyncState`
   * awaits this before snapshotting the state store, so a peer asking for a
   * sync while this node is mid-`applyBlock` doesn't get a half-applied
   * state that no block's digest actually commits to. This isolates the
   * primitive itself: `applyBlock` is held open on purpose (via a stub that
   * defers the real call rather than faking its result), and `whenIdle`
   * must not resolve until it's released.
   */
  it('whenIdle does not resolve until an in-progress applyBlock finishes', async () => {
    // A single-validator cluster: its own vote alone reaches quorum, so
    // `propose()` drives the round all the way through `applyBlock` with no
    // other peer needed, and there's a StateMachine this test can patch
    // directly (unlike `createPeer`'s, which is private to that helper).
    const soloValidators = new ValidatorSet([key1])
    const soloStore = new InMemoryStateStore()
    const soloSm = new StateMachine(soloStore, mockVerifier)

    // Hold `applyBlock` open until released, rather than faking its
    // result -- the real transaction loop still runs, just on a delay this
    // test controls.
    const originalApplyBlock = soloSm.applyBlock.bind(soloSm)
    let releaseApply: (() => void) | null = null
    const held = new Promise<void>((resolve) => { releaseApply = resolve })
    soloSm.applyBlock = (block) => held.then(() => originalApplyBlock(block))

    const soloConsensus = new PBFTConsensus({
      identity: key1,
      chainId: TEST_CHAIN_ID,
      validators: soloValidators,
      transport: network.createTransport(key1),
      timer: new MockTimer(),
      stateMachine: soloSm,
      sign: mockSign(key1),
      verify: mockVerifier,
      blockTime: 100,
      viewTimeout: 500,
    })
    soloConsensus.start()

    const block: Block = {
      header: {
        number: 1n,
        parentHash: new Uint8Array(32),
        stateRoot: new Uint8Array(32),
        txRoot: new Uint8Array(32),
        receiptRoot: new Uint8Array(32),
        timestamp: Date.now(),
        proposer: key1,
      },
      transactions: [],
      signatures: [],
    }

    const proposePromise = soloConsensus.propose(block)

    // Let the round actually reach `applyBlock` (and get stuck on `held`)
    // before checking `whenIdle`. `hash`/`sign` are real async I/O
    // (crypto.subtle), not microtasks, so this needs real macrotask turns,
    // not just `Promise.resolve()` — see `TestOrchestrator.drainFully`'s
    // own docs for the same reasoning.
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))

    let idleResolved = false
    const idlePromise = soloConsensus.whenIdle().then(() => { idleResolved = true })
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
    expect(idleResolved, 'whenIdle resolved while applyBlock was still held open').toBe(false)

    releaseApply!()
    await proposePromise
    await idlePromise
    expect(idleResolved).toBe(true)

    soloConsensus.stop()
  })

  /**
   * The actual gap raijin#51 found: `whenIdle` used to track only the
   * `StateMachine.applyBlock` call itself. `applyBlock` finishing means the
   * store is fully mutated -- but `#onCommitted`'s remaining work
   * (computing stateRoot/receiptRoot, advancing this node's own finalized
   * tip, and notifying `onBlockFinalized` listeners -- which is what
   * `ValidatorNode` uses to advance `latestBlock`) still runs AFTER that,
   * with further `await`s in between. A `whenIdle` racing against exactly
   * that window could -- and in the issue's repro, did, 25 of 25 times --
   * resume once `applyBlock` settles and read a store that already reflects
   * the new block paired with a `latestBlock` that still names the old one.
   *
   * This holds `stateRoot()` open instead of `applyBlock` itself, to prove
   * `whenIdle` now waits for the WHOLE sequence, not just the part that
   * mutates the store.
   */
  it('whenIdle does not resolve until the full apply-and-finalize sequence -- not just applyBlock -- has settled (issue #51)', async () => {
    const soloValidators = new ValidatorSet([key1])
    const soloStore = new InMemoryStateStore()
    const soloSm = new StateMachine(soloStore, mockVerifier)

    const originalStateRoot = soloSm.stateRoot.bind(soloSm)
    let releaseStateRoot: (() => void) | null = null
    const held = new Promise<void>((resolve) => { releaseStateRoot = resolve })
    soloSm.stateRoot = () => held.then(() => originalStateRoot())

    const soloConsensus = new PBFTConsensus({
      identity: key1,
      chainId: TEST_CHAIN_ID,
      validators: soloValidators,
      transport: network.createTransport(key1),
      timer: new MockTimer(),
      stateMachine: soloSm,
      sign: mockSign(key1),
      verify: mockVerifier,
      blockTime: 100,
      viewTimeout: 500,
    })
    soloConsensus.start()

    let finalizedHandlerRan = false
    soloConsensus.onBlockFinalized(() => { finalizedHandlerRan = true })

    const block: Block = {
      header: {
        number: 1n,
        parentHash: new Uint8Array(32),
        stateRoot: new Uint8Array(32),
        txRoot: new Uint8Array(32),
        receiptRoot: new Uint8Array(32),
        timestamp: Date.now(),
        proposer: key1,
      },
      transactions: [],
      signatures: [],
    }

    const proposePromise = soloConsensus.propose(block)

    // Let the round get all the way past `applyBlock` (unpatched, so it
    // completes normally) and get stuck on the patched `stateRoot()`.
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))

    let idleResolved = false
    const idlePromise = soloConsensus.whenIdle().then(() => { idleResolved = true })
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
    expect(idleResolved, 'whenIdle resolved before stateRoot/finalize-notify ran, even though applyBlock had already mutated the store').toBe(false)
    expect(finalizedHandlerRan).toBe(false)

    releaseStateRoot!()
    await proposePromise
    await idlePromise
    expect(idleResolved).toBe(true)
    expect(finalizedHandlerRan, 'whenIdle resolved before the finalize notification (which ValidatorNode uses to advance latestBlock) actually ran').toBe(true)

    soloConsensus.stop()
  })
})
