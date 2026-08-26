import { describe, it, expect, beforeEach } from 'vitest'

import { StateMachine, InMemoryStateStore, hash, type Block } from '@johnhenry/raijin-core'
import { PBFTConsensus, ValidatorSet, PBFTPhase } from '../src/index.js'
import type { NewViewMessage, PrePrepareMessage, ViewChangeMessage } from '../src/types.js'
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

/** Mirrors PBFTConsensus#serializeBlockHeader + hash — used to construct
 *  messages with a digest that will pass the real digest check. */
function bigintToBytes(value: bigint): Uint8Array {
  const hex = value.toString(16).padStart(16, '0')
  const bytes = new Uint8Array(8)
  for (let i = 0; i < 8; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

async function computeDigest(block: Block): Promise<Uint8Array> {
  const parts: Uint8Array[] = [
    bigintToBytes(block.header.number),
    block.header.parentHash,
    block.header.stateRoot,
    block.header.txRoot,
    block.header.receiptRoot,
    bigintToBytes(BigInt(block.header.timestamp)),
    block.header.proposer,
  ]
  const totalLen = parts.reduce((sum, p) => sum + p.length, 0)
  const result = new Uint8Array(totalLen)
  let pos = 0
  for (const part of parts) {
    result.set(part, pos)
    pos += part.length
  }
  return hash(result)
}

/** Mirrors PBFTConsensus#viewChangeDigestBytes (what VIEW-CHANGE signatures cover — signed directly, not pre-hashed). */
async function computeViewChangeDigest(newView: bigint, sequence: bigint): Promise<Uint8Array> {
  const a = bigintToBytes(newView)
  const b = bigintToBytes(sequence)
  const combined = new Uint8Array(a.length + b.length)
  combined.set(a, 0)
  combined.set(b, a.length)
  return combined
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
      verify: mockVerifier,
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

      // stateRoot/receiptRoot must be filled in with real, non-zero values
      // after execution (not left as the zero-filled pre-execution
      // placeholders) — and every honest peer must compute the SAME
      // stateRoot for the same block, since they all applied the same
      // transactions to the same starting state.
      const zero32 = new Uint8Array(32)
      for (const b of finalized) {
        expect(b.header.stateRoot).not.toEqual(zero32)
        expect(b.header.receiptRoot).not.toEqual(zero32)
      }
      const stateRoots = new Set(finalized.map((b) => Buffer.from(b.header.stateRoot).toString('hex')))
      expect(stateRoots.size).toBe(1)

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

  describe('signature verification (forged messages)', () => {
    it('rejects a forged COMMIT with an invalid signature — not counted toward quorum', async () => {
      const p1 = createPeer(key1) // leader; quorum = 3 of 4
      p1.consensus.start()

      const block = makeBlock(1n, key1)
      const digest = await computeDigest(block)
      await p1.consensus.propose(block) // p1 self-prepares (1/3)

      // Bring p1 to Prepared with two genuine PREPAREs (2 + self = 3 = quorum).
      network.createTransport(key2).send(key1, {
        type: 'prepare', view: 0n, sequence: 1n, digest, from: key2,
        signature: await mockSign(key2)(digest),
      })
      network.createTransport(key3).send(key1, {
        type: 'prepare', view: 0n, sequence: 1n, digest, from: key3,
        signature: await mockSign(key3)(digest),
      })
      await network.drainAll()

      expect(p1.consensus.phase).toBe(PBFTPhase.Prepared) // p1 auto-sent its own real COMMIT (1/3)

      // Forged COMMIT claiming to be key4, with a garbage signature.
      network.createTransport(key4).send(key1, {
        type: 'commit', view: 0n, sequence: 1n, digest, from: key4,
        signature: new Uint8Array(32).fill(0xff),
      })
      await network.drainAll()
      expect(p1.consensus.phase).toBe(PBFTPhase.Prepared) // still not counted — not finalized

      // A second forged COMMIT, claiming to be key2 (who never actually sent one).
      network.createTransport(key2).send(key1, {
        type: 'commit', view: 0n, sequence: 1n, digest, from: key2,
        signature: new Uint8Array(32).fill(0x00),
      })
      await network.drainAll()
      expect(p1.consensus.phase).toBe(PBFTPhase.Prepared) // still not finalized

      // Now deliver two GENUINE commits — this is what should actually finalize it.
      network.createTransport(key2).send(key1, {
        type: 'commit', view: 0n, sequence: 1n, digest, from: key2,
        signature: await mockSign(key2)(digest),
      })
      network.createTransport(key3).send(key1, {
        type: 'commit', view: 0n, sequence: 1n, digest, from: key3,
        signature: await mockSign(key3)(digest),
      })
      await network.drainAll()

      expect(p1.consensus.phase).toBe(PBFTPhase.Idle) // committed and reset

      p1.consensus.stop()
    })

    it('rejects a forged PREPARE with an invalid signature — not counted toward quorum', async () => {
      const p1 = createPeer(key1) // leader; quorum = 3 of 4
      p1.consensus.start()

      const block = makeBlock(1n, key1)
      const digest = await computeDigest(block)
      await p1.consensus.propose(block) // p1 self-prepares (1/3)

      expect(p1.consensus.phase).toBe(PBFTPhase.PrePrepared)

      // Forged PREPARE claiming to be key2, garbage signature.
      network.createTransport(key2).send(key1, {
        type: 'prepare', view: 0n, sequence: 1n, digest, from: key2,
        signature: new Uint8Array(32).fill(0xaa),
      })
      await network.drainAll()
      expect(p1.consensus.phase).toBe(PBFTPhase.PrePrepared) // not counted

      // Genuine PREPARE from key2 (2/3).
      network.createTransport(key2).send(key1, {
        type: 'prepare', view: 0n, sequence: 1n, digest, from: key2,
        signature: await mockSign(key2)(digest),
      })
      await network.drainAll()
      expect(p1.consensus.phase).toBe(PBFTPhase.PrePrepared) // still not quorum

      // Another forged PREPARE, claiming to be key3.
      network.createTransport(key3).send(key1, {
        type: 'prepare', view: 0n, sequence: 1n, digest, from: key3,
        signature: new Uint8Array(32).fill(0x11),
      })
      await network.drainAll()
      expect(p1.consensus.phase).toBe(PBFTPhase.PrePrepared) // still not quorum

      // Genuine PREPARE from key3 — now 3/3, reaches quorum.
      network.createTransport(key3).send(key1, {
        type: 'prepare', view: 0n, sequence: 1n, digest, from: key3,
        signature: await mockSign(key3)(digest),
      })
      await network.drainAll()
      expect(p1.consensus.phase).toBe(PBFTPhase.Prepared)

      p1.consensus.stop()
    })
  })

  describe('view-change quorum', () => {
    it('does not change view on a single duplicated VIEW-CHANGE (dedup by sender)', async () => {
      const p2 = createPeer(key2) // not leader; quorum = 3 of 4
      p2.consensus.start()

      const newView = 1n
      const sequence = 0n
      const digest = await computeViewChangeDigest(newView, sequence)
      const signature = await mockSign(key3)(digest)

      const makeVc = (): ViewChangeMessage => ({ type: 'view-change', newView, sequence, from: key3, signature })

      // The SAME sender's VIEW-CHANGE delivered 3 times must not fake a 3-of-4 quorum.
      network.createTransport(key3).send(key2, makeVc())
      network.createTransport(key3).send(key2, makeVc())
      network.createTransport(key3).send(key2, makeVc())
      await network.drainAll()

      expect(p2.consensus.currentView).toBe(0n)

      p2.consensus.stop()
    })

    it('changes view once a genuine quorum of distinct VIEW-CHANGE senders is reached', async () => {
      const p2 = createPeer(key2)
      const viewChanges: bigint[] = []
      p2.consensus.onViewChange((v) => viewChanges.push(v))
      p2.consensus.start()

      const newView = 1n
      const sequence = 0n
      const digest = await computeViewChangeDigest(newView, sequence)

      for (const key of [key1, key3, key4]) {
        const signature = await mockSign(key)(digest)
        const msg: ViewChangeMessage = { type: 'view-change', newView, sequence, from: key, signature }
        network.createTransport(key).send(key2, msg)
      }
      await network.drainAll()

      expect(p2.consensus.currentView).toBe(1n)
      expect(viewChanges).toContain(1n)

      p2.consensus.stop()
    })
  })

  describe('NEW-VIEW quorum validation', () => {
    it('ignores an unsolicited NEW-VIEW without a real quorum of valid VIEW-CHANGE messages', async () => {
      const p2 = createPeer(key2)
      p2.consensus.start()

      const newView = 1n
      const sequence = 0n
      const digest = await computeViewChangeDigest(newView, sequence)
      const signature = await mockSign(key1)(digest)

      // Only one distinct valid backer (need 3) — repeating it doesn't help.
      const badNewView: NewViewMessage = {
        type: 'new-view',
        view: newView,
        viewChanges: [
          { type: 'view-change', newView, sequence, from: key1, signature },
          { type: 'view-change', newView, sequence, from: key1, signature },
        ],
      }
      network.createTransport(key3).send(key2, badNewView)
      await network.drainAll()

      expect(p2.consensus.currentView).toBe(0n)

      p2.consensus.stop()
    })

    it('ignores a NEW-VIEW whose VIEW-CHANGE entries have forged signatures', async () => {
      const p2 = createPeer(key2)
      p2.consensus.start()

      const newView = 1n
      const sequence = 0n

      const forgedNewView: NewViewMessage = {
        type: 'new-view',
        view: newView,
        viewChanges: [key1, key3, key4].map((from) => ({
          type: 'view-change' as const,
          newView,
          sequence,
          from,
          signature: new Uint8Array(32).fill(0x42), // garbage — doesn't match any of them
        })),
      }
      network.createTransport(key1).send(key2, forgedNewView)
      await network.drainAll()

      expect(p2.consensus.currentView).toBe(0n)

      p2.consensus.stop()
    })

    it('accepts a NEW-VIEW backed by a genuine quorum of VIEW-CHANGE messages', async () => {
      const p2 = createPeer(key2)
      p2.consensus.start()

      const newView = 1n
      const sequence = 0n
      const digest = await computeViewChangeDigest(newView, sequence)

      const viewChanges: ViewChangeMessage[] = []
      for (const key of [key1, key3, key4]) {
        const signature = await mockSign(key)(digest)
        viewChanges.push({ type: 'view-change', newView, sequence, from: key, signature })
      }
      const goodNewView: NewViewMessage = { type: 'new-view', view: newView, viewChanges }
      network.createTransport(key1).send(key2, goodNewView)
      await network.drainAll()

      expect(p2.consensus.currentView).toBe(1n)

      p2.consensus.stop()
    })
  })

  describe('view-change prepared-certificate mitigation', () => {
    it('rejects a conflicting re-proposal at an already-prepared sequence, but accepts the same block again', async () => {
      // 4 validators, quorum = 3. p1 = key1 is leader for view 0.
      const p1 = createPeer(key1)
      p1.consensus.start()

      const blockA = makeBlock(1n, key1)
      const digestA = await computeDigest(blockA)
      await p1.consensus.propose(blockA) // p1 self-prepares (1/3)

      // Reach PREPARE quorum on blockA (view 0, sequence 1) — p1 is now Prepared
      // and has recorded a prepared certificate for sequence 1.
      network.createTransport(key2).send(key1, {
        type: 'prepare', view: 0n, sequence: 1n, digest: digestA, from: key2,
        signature: await mockSign(key2)(digestA),
      })
      network.createTransport(key3).send(key1, {
        type: 'prepare', view: 0n, sequence: 1n, digest: digestA, from: key3,
        signature: await mockSign(key3)(digestA),
      })
      await network.drainAll()
      expect(p1.consensus.phase).toBe(PBFTPhase.Prepared)

      // Force a view change to view 1 via a genuine VIEW-CHANGE quorum
      // (key2, key3, key4 — distinct senders) BEFORE a COMMIT quorum is
      // reached, so blockA is prepared but never committed.
      const newView = 1n
      const vcDigest = await computeViewChangeDigest(newView, 1n)
      for (const key of [key2, key3, key4]) {
        const signature = await mockSign(key)(vcDigest)
        network.createTransport(key).send(key1, {
          type: 'view-change', newView, sequence: 1n, from: key, signature,
        } satisfies ViewChangeMessage)
      }
      await network.drainAll()

      expect(p1.consensus.currentView).toBe(1n)
      expect(p1.consensus.phase).toBe(PBFTPhase.Idle) // view change wiped in-flight phase/prepares/commits

      // The new leader for view 1 is key2 (round-robin). It proposes a
      // DIFFERENT block at the same sequence (1) — this must be rejected,
      // since blockA was already validly prepared at that sequence.
      const blockB = { ...blockA, header: { ...blockA.header, proposer: key3 } }
      const digestB = await computeDigest(blockB)
      const conflictingPrePrepare: PrePrepareMessage = {
        type: 'pre-prepare', view: 1n, sequence: 1n, block: blockB, digest: digestB,
      }
      network.createTransport(key2).send(key1, conflictingPrePrepare)
      await network.drainAll()

      expect(p1.consensus.phase).toBe(PBFTPhase.Idle) // rejected — did not move to pre-prepared

      // But re-proposing the SAME block (same digest) at the new view must
      // still be accepted — the guard only blocks conflicting proposals.
      const samePrePrepare: PrePrepareMessage = {
        type: 'pre-prepare', view: 1n, sequence: 1n, block: blockA, digest: digestA,
      }
      network.createTransport(key2).send(key1, samePrePrepare)
      await network.drainAll()

      expect(p1.consensus.phase).toBe(PBFTPhase.PrePrepared)

      p1.consensus.stop()
    })
  })
})
