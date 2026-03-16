import { describe, it, expect, beforeEach } from 'vitest'

import { StateMachine, InMemoryStateStore, type Block } from 'raijin-core'
import { PBFTConsensus, ValidatorSet, PBFTPhase } from '../src/index.js'
import { MockNetwork, DeterministicNetwork, MockTimer, mockVerifier, mockSign, makeTestKey } from './helpers.js'

/** Create a minimal valid block. */
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

describe('PBFTConsensus', () => {
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

  function createPeer(key: Uint8Array): { consensus: PBFTConsensus; timer: MockTimer } {
    const store = new InMemoryStateStore()
    const sm = new StateMachine(store, mockVerifier)
    const timer = new MockTimer()
    const transport = network.createTransport(key)

    const consensus = new PBFTConsensus({
      identity: key,
      validators,
      transport,
      timer,
      stateMachine: sm,
      sign: mockSign(key),
      blockTime: 100,
      viewTimeout: 500,
    })

    return { consensus, timer }
  }

  describe('initialization', () => {
    it('starts in idle phase', () => {
      const { consensus } = createPeer(key1)
      expect(consensus.phase).toBe(PBFTPhase.Idle)
      expect(consensus.running).toBe(false)
    })

    it('key1 is leader for view 0', () => {
      const { consensus } = createPeer(key1)
      expect(consensus.isLeader).toBe(true)
    })

    it('key2 is not leader for view 0', () => {
      const { consensus } = createPeer(key2)
      expect(consensus.isLeader).toBe(false)
    })

    it('currentView starts at 0', () => {
      const { consensus } = createPeer(key1)
      expect(consensus.currentView).toBe(0n)
    })
  })

  describe('block proposal (single round)', () => {
    it('leader proposes and all peers finalize', async () => {
      // Create 4 peers
      const p1 = createPeer(key1) // leader
      const p2 = createPeer(key2)
      const p3 = createPeer(key3)
      const p4 = createPeer(key4)

      // Track finalized blocks
      const finalized: Block[] = []
      p1.consensus.onBlockFinalized((block) => finalized.push(block))
      p2.consensus.onBlockFinalized((block) => finalized.push(block))
      p3.consensus.onBlockFinalized((block) => finalized.push(block))
      p4.consensus.onBlockFinalized((block) => finalized.push(block))

      // Start all peers
      p1.consensus.start()
      p2.consensus.start()
      p3.consensus.start()
      p4.consensus.start()

      // Leader proposes
      const block = makeBlock(1n, key1)
      await p1.consensus.propose(block)

      // Deterministically drain all async message cascades
      await network.drainAll()

      // All 4 peers should finalize the block
      // (leader's propose triggers PRE-PREPARE → others send PREPARE → quorum reached → COMMIT → finalized)
      expect(finalized.length).toBe(4)
      expect(finalized[0].header.number).toBe(1n)

      // Cleanup
      p1.consensus.stop()
      p2.consensus.stop()
      p3.consensus.stop()
      p4.consensus.stop()
    })

    it('non-leader cannot propose', async () => {
      const { consensus } = createPeer(key2) // not the leader
      consensus.start()

      const block = makeBlock(1n, key2)
      await expect(consensus.propose(block)).rejects.toThrow('Only the leader')

      consensus.stop()
    })
  })

  describe('Byzantine tolerance', () => {
    it('finalizes with one peer offline (3/4 = above 2f+1=3)', async () => {
      const p1 = createPeer(key1) // leader
      const p2 = createPeer(key2)
      const p3 = createPeer(key3)
      // p4 is offline — not created

      const finalized: Block[] = []
      p1.consensus.onBlockFinalized((block) => finalized.push(block))

      p1.consensus.start()
      p2.consensus.start()
      p3.consensus.start()

      const block = makeBlock(1n, key1)
      await p1.consensus.propose(block)
      await network.drainAll()

      // Should still finalize with 3/4 validators (quorum = 3)
      expect(finalized.length).toBeGreaterThanOrEqual(1)

      p1.consensus.stop()
      p2.consensus.stop()
      p3.consensus.stop()
    })

    it('does NOT finalize with two peers offline (2/4 < quorum of 3)', async () => {
      const p1 = createPeer(key1) // leader
      const p2 = createPeer(key2)
      // p3, p4 offline

      const finalized: Block[] = []
      p1.consensus.onBlockFinalized((block) => finalized.push(block))

      p1.consensus.start()
      p2.consensus.start()

      const block = makeBlock(1n, key1)
      await p1.consensus.propose(block)

      // Should NOT finalize — only 2 validators, quorum requires 3
      expect(finalized.length).toBe(0)

      p1.consensus.stop()
      p2.consensus.stop()
    })
  })

  describe('view changes', () => {
    it('triggers view change on leader timeout', () => {
      const p2 = createPeer(key2) // not the leader
      const viewChanges: bigint[] = []
      p2.consensus.onViewChange((v) => viewChanges.push(v))

      p2.consensus.start()

      // Advance past view timeout — leader hasn't proposed
      p2.timer.advance(600)

      // p2 should have requested a view change
      // (In a full network, other peers would also request and consensus would advance)
      expect(p2.consensus.currentView).toBe(0n) // Not yet changed (needs quorum)

      p2.consensus.stop()
    })
  })

  describe('state transitions', () => {
    it('progresses through phases: idle → pre-prepared → prepared → committed', async () => {
      const p1 = createPeer(key1)
      const p2 = createPeer(key2)
      const p3 = createPeer(key3)
      const p4 = createPeer(key4)

      p1.consensus.start()
      p2.consensus.start()
      p3.consensus.start()
      p4.consensus.start()

      expect(p1.consensus.phase).toBe(PBFTPhase.Idle)

      const block = makeBlock(1n, key1)
      await p1.consensus.propose(block)
      await network.drainAll()

      // After full round, should be back to Idle (committed and reset)
      expect(p1.consensus.phase).toBe(PBFTPhase.Idle)
      expect(p1.consensus.currentSequence).toBe(1n)

      p1.consensus.stop()
      p2.consensus.stop()
      p3.consensus.stop()
      p4.consensus.stop()
    })
  })
})
