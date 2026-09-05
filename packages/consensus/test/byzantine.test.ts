/**
 * Byzantine faults — a validator that lies, not one that stops.
 *
 * Every other fault test in this repo (and in the test harness) models a
 * crash: the node goes away and says nothing more. That is the easy half of
 * the fault model, and it is not the half raijin exists for. A Byzantine
 * validator keeps talking. It holds a real key, so every message it emits is
 * correctly signed and correctly formed — authentication is not what stops
 * it. Quorum intersection and the three-phase commit are what stop it, and
 * those are what these tests actually exercise.
 *
 * The peers here are real `PBFTConsensus` instances. Only the attacker is
 * synthetic (`ByzantinePeer` — a transport plus a key, see helpers.ts), which
 * is exactly the shape of the real threat: an honest implementation cannot be
 * made to equivocate, so the attacker must not be one.
 */

import { describe, it, expect, beforeEach } from 'vitest'

import { StateMachine, InMemoryStateStore, toHex, type Block } from '@johnhenry/raijin-core'
import { PBFTConsensus, ValidatorSet, PBFTPhase } from '../src/index.js'
import {
  DeterministicNetwork,
  MockTimer,
  ByzantinePeer,
  mockVerifier,
  mockSign,
  makeTestKey,
} from './helpers.js'

/**
 * A minimal valid block, made distinguishable by `tag`.
 *
 * `tag` lands in `txRoot`, which (a) is part of the header and so changes the
 * consensus digest, and (b) is never rewritten by execution — unlike
 * `stateRoot`/`receiptRoot`, which `#onCommitted` overwrites after applying
 * the block. So `txRoot` is what a test can use to ask "*which* block did
 * this peer finalize?" after the fact.
 */
function makeBlock(number: bigint, proposer: Uint8Array, tag: number): Block {
  const txRoot = new Uint8Array(32)
  txRoot.fill(tag)
  return {
    header: {
      number,
      parentHash: new Uint8Array(32),
      stateRoot: new Uint8Array(32),
      txRoot,
      receiptRoot: new Uint8Array(32),
      timestamp: 1_700_000_000_000,
      proposer,
    },
    transactions: [],
    signatures: [],
  }
}

/**
 * The chain these tests vote in. Vote signatures cover it (see `voteDigest`),
 * so a liar has to name the same chain as the peers it is lying to — being on
 * the wrong chain is not an attack, it is just an invalid signature.
 */
const CHAIN_ID = 1n

/** The scope every `ByzantinePeer` here signs under: same chain, same set. */
function byzOpts(validators: ValidatorSet) {
  return { chainId: CHAIN_ID, validators }
}

/** Which block a finalized header came from — see `makeBlock`. */
function blockTag(block: Block): number {
  return block.header.txRoot[0]
}

describe('Byzantine validators', () => {
  let network: DeterministicNetwork

  beforeEach(() => {
    network = new DeterministicNetwork()
  })

  /**
   * Drain the network to a standstill.
   *
   * PBFT's reactions are fire-and-forget async chains hanging off real
   * `crypto.subtle` calls (hashing, signing), and some of them — the view
   * timer's `#requestViewChange` in particular — are started by a timer
   * firing rather than by a message arriving, so the queue can be empty at
   * the instant a broadcast is imminent. Draining once is not evidence that
   * nothing is coming; alternate drains with macrotask yields.
   */
  async function settle(passes = 8): Promise<void> {
    for (let i = 0; i < passes; i++) {
      await network.drainAll()
      await new Promise((r) => setTimeout(r, 0))
    }
    await network.drainAll()
  }

  /** A real, honest PBFT peer wired to the shared deterministic network. */
  function honestPeer(key: Uint8Array, validators: ValidatorSet) {
    const store = new InMemoryStateStore()
    const sm = new StateMachine(store, mockVerifier)
    const timer = new MockTimer()
    const consensus = new PBFTConsensus({
      identity: key,
      chainId: CHAIN_ID,
      validators,
      transport: network.createTransport(key),
      timer,
      stateMachine: sm,
      sign: mockSign(key),
      verify: mockVerifier,
      blockTime: 100,
      viewTimeout: 500,
    })
    const finalized: Block[] = []
    consensus.onBlockFinalized((block) => finalized.push(block))
    consensus.start()
    return { key, consensus, timer, finalized }
  }

  describe('an equivocating proposer', () => {
    /**
     * The canonical Byzantine leader, and the reason PBFT has three phases
     * instead of two: it proposes block A to one group of replicas and block
     * B to another, at the same view and the same sequence, with every
     * message correctly signed.
     *
     * n = 4, f = 1, quorum = 3. The leader is the Byzantine one, so the three
     * honest replicas are split 1 / 2. Whichever way they split, the group of
     * one can reach at most 2 PREPAREs (itself plus the liar) and never
     * prepares at all. Only the group of two can reach quorum, and it does so
     * on a single block.
     *
     * The property under test is NOT "something threw" — nothing throws, and
     * a Byzantine leader is entitled to be ignored silently. It is that the
     * honest replicas do not commit two different blocks at one sequence.
     */
    it('cannot get two honest replicas to commit different blocks at the same sequence', async () => {
      const byz = makeTestKey(1) // leader for view 0
      const k2 = makeTestKey(2)
      const k3 = makeTestKey(3)
      const k4 = makeTestKey(4)
      // n = 4, f = 1, quorum = 3 (asserted in validator-set.test.ts; not
      // re-asserted here, so that breaking the quorum rule shows up as the
      // safety failure below rather than as a failed precondition).
      const validators = new ValidatorSet([byz, k2, k3, k4])

      const p2 = honestPeer(k2, validators)
      const p3 = honestPeer(k3, validators)
      const p4 = honestPeer(k4, validators)

      const liar = new ByzantinePeer(byz, network.createTransport(byz), byzOpts(validators))

      // Block A to {k2}; block B to {k3, k4}. Same view, same sequence.
      const blockA = makeBlock(1n, byz, 0xaa)
      const blockB = makeBlock(1n, byz, 0xbb)
      const [digestA, digestB] = await liar.equivocate({
        view: 0n,
        sequence: 1n,
        groups: [
          { targets: [k2], block: blockA },
          { targets: [k3, k4], block: blockB },
        ],
      })
      expect(toHex(digestA)).not.toBe(toHex(digestB))

      await network.drainAll()

      // Every honest replica that finalized anything at this sequence
      // finalized the SAME block. This is the safety property; the count is
      // secondary.
      const finalizedTags = new Set(
        [...p2.finalized, ...p3.finalized, ...p4.finalized].map(blockTag),
      )
      expect(finalizedTags.size).toBeLessThanOrEqual(1)

      // And concretely: the isolated replica never even prepared, because it
      // could only ever see 2 of the 3 PREPAREs block A needs.
      expect(p2.finalized).toHaveLength(0)
      expect(p2.consensus.phase).toBe(PBFTPhase.PrePrepared)

      // The two-replica group did reach quorum, on block B and only block B —
      // stated so this test cannot pass by nothing happening at all.
      expect(p3.finalized).toHaveLength(1)
      expect(p4.finalized).toHaveLength(1)
      expect(blockTag(p3.finalized[0])).toBe(0xbb)
      expect(blockTag(p4.finalized[0])).toBe(0xbb)

      for (const p of [p2, p3, p4]) p.consensus.stop()
    })

    /**
     * The same attack at n = 3, where the old quorum rule was fatal.
     *
     * n = 3 gives f = floor((3-1)/3) = 0, so the old `2f + 1` rule made the
     * quorum ONE: a replica reached its own PREPARE quorum on its own vote
     * and finalized alone. An equivocating leader then hands each of the two
     * honest replicas a different block and both commit it — a fork, from a
     * single faulty node, with no forged signatures anywhere.
     *
     * `n - f` makes the quorum 3 at n = 3: the two honest replicas each see
     * 2 PREPAREs and neither commits. Liveness is lost (correctly — n = 3
     * tolerates zero faults) but safety holds.
     */
    it('cannot fork a 3-validator set, where the old 2f+1 quorum let one liar split it', async () => {
      const byz = makeTestKey(1) // leader for view 0
      const k2 = makeTestKey(2)
      const k3 = makeTestKey(3)
      // n = 3 gives f = 0, so 2f+1 would be a quorum of ONE — a replica
      // finalizing on its own vote. n-f gives 3. (Quorum arithmetic is
      // asserted in validator-set.test.ts; deliberately not re-asserted here,
      // so that reverting the rule fails this test on the fork below.)
      const validators = new ValidatorSet([byz, k2, k3])

      const p2 = honestPeer(k2, validators)
      const p3 = honestPeer(k3, validators)

      const liar = new ByzantinePeer(byz, network.createTransport(byz), byzOpts(validators))
      await liar.equivocate({
        view: 0n,
        sequence: 1n,
        groups: [
          { targets: [k2], block: makeBlock(1n, byz, 0xaa) },
          { targets: [k3], block: makeBlock(1n, byz, 0xbb) },
        ],
      })
      await network.drainAll()

      // The assertion that matters: the two honest replicas did not commit
      // conflicting blocks.
      const tags = new Set([...p2.finalized, ...p3.finalized].map(blockTag))
      expect(tags.size).toBeLessThanOrEqual(1)

      // Concretely, at n = 3 nothing commits at all — one Byzantine node out
      // of three is over the tolerance, so stalling is the correct outcome.
      expect(p2.finalized).toHaveLength(0)
      expect(p3.finalized).toHaveLength(0)

      for (const p of [p2, p3]) p.consensus.stop()
    })
  })

  describe('a conflicting re-proposal after a view change', () => {
    /**
     * The scenario an incomplete prepared-certificate carry-over leaves open,
     * and the one `PBFTConsensus#preparedCert` exists to close.
     *
     * A block reaches a PREPARE quorum in view 0 among the replicas that can
     * still hear each other, but never reaches a COMMIT quorum. The replica
     * on the far side of the split never learns it happened. That replica is
     * the leader of view 1, and it proposes a DIFFERENT block at the same
     * sequence — not maliciously, just ignorantly, which is why this cannot
     * be dismissed as "don't run a Byzantine leader".
     *
     * A replica that already prepared X at sequence 1 must refuse Y at
     * sequence 1, whatever view Y arrives in. And it must still accept X
     * again, or the guard is just an outage.
     */
    it('cannot replace a block already prepared at a sequence, but still accepts that same block', async () => {
      const byz = makeTestKey(1) // leader for view 0
      const k2 = makeTestKey(2) // leader for view 1
      const k3 = makeTestKey(3)
      const k4 = makeTestKey(4)
      const validators = new ValidatorSet([byz, k2, k3, k4])

      const p2 = honestPeer(k2, validators)
      const p3 = honestPeer(k3, validators)
      const p4 = honestPeer(k4, validators)

      // ── View 0: block X prepares on the {k3, k4} side only ──
      //
      // The view-0 leader tells k3 and k4 about block X and says nothing to
      // k2 — from k2's side that is indistinguishable from a partition. The
      // leader sends its PREPARE but deliberately NO COMMIT, so X reaches a
      // PREPARE quorum ({k3, k4, leader} = 3) and stops one vote short of a
      // COMMIT quorum. That is the dangerous state: prepared, not committed.
      const blockX = makeBlock(1n, byz, 0x11)
      const liar = new ByzantinePeer(byz, network.createTransport(byz), byzOpts(validators))
      await liar.equivocate({
        view: 0n,
        sequence: 1n,
        groups: [{ targets: [k3, k4], block: blockX }],
        commit: false,
      })
      await settle()

      expect(p3.consensus.phase).toBe(PBFTPhase.Prepared)
      expect(p4.consensus.phase).toBe(PBFTPhase.Prepared)
      expect(p3.finalized).toHaveLength(0)
      expect(p4.finalized).toHaveLength(0)
      // k2 saw votes for a sequence it has never heard a proposal for, and
      // correctly ignored them — it is about to lead view 1 knowing nothing.
      expect(p2.consensus.phase).toBe(PBFTPhase.Idle)

      // ── View change to view 1 ──
      for (const p of [p2, p3, p4]) p.timer.advance(600)
      await settle()

      for (const p of [p2, p3, p4]) expect(p.consensus.currentView).toBe(1n)
      expect(p2.consensus.isLeader).toBe(true)

      // ── View 1: the new leader proposes a conflicting block at sequence 1 ──
      const blockY = makeBlock(1n, k2, 0x22)
      await p2.consensus.propose(blockY)
      await settle()

      // k3 and k4 hold a prepared certificate for X at sequence 1 and must
      // refuse Y. Nothing anywhere finalizes Y.
      expect(p3.consensus.phase).toBe(PBFTPhase.Idle)
      expect(p4.consensus.phase).toBe(PBFTPhase.Idle)
      const allFinalized = [...p2.finalized, ...p3.finalized, ...p4.finalized]
      expect(allFinalized.map(blockTag)).not.toContain(0x22)
      expect(allFinalized).toHaveLength(0)

      // ── And the guard is not simply "refuse everything" ──
      // A new leader that HAD learned about X (what full prepared-certificate
      // carry-over would give it) re-proposes X itself, and that is accepted.
      const asNewLeader = new ByzantinePeer(k2, network.createTransport(k2), { ...byzOpts(validators), listen: false })
      await asNewLeader.prePrepare([k3, k4], 1n, 1n, blockX)
      await settle()

      expect(p3.consensus.phase).toBe(PBFTPhase.PrePrepared)
      expect(p4.consensus.phase).toBe(PBFTPhase.PrePrepared)

      for (const p of [p2, p3, p4]) p.consensus.stop()
    })
  })

  describe('an equivocating voter', () => {
    /**
     * A validator that votes for a block nobody proposed, at the same view
     * and sequence as the one that was.
     *
     * Vote sets are keyed by digest, so a vote for a phantom block lands in
     * its own bucket and cannot carry the real block over the line. That
     * sounds obvious; it is the difference between counting "who has voted"
     * and counting "who has voted *for this block*", and only the second one
     * is a quorum.
     *
     * The round here is deliberately balanced on exactly this: the real block
     * has two of the three votes it needs, and the liar holds the third.
     */
    it('cannot advance a block by spending its vote on a different one', async () => {
      const k1 = makeTestKey(1) // honest leader
      const k2 = makeTestKey(2) // honest
      const k3 = makeTestKey(3) // honest, silent for now
      const byz = makeTestKey(4)
      const validators = new ValidatorSet([k1, k2, k3, byz])

      const p1 = honestPeer(k1, validators)

      const real = makeBlock(1n, k1, 0x33)
      await p1.consensus.propose(real)
      await settle()

      const realDigest = await ByzantinePeer.digestOf(real)
      const phantomDigest = await ByzantinePeer.digestOf(makeBlock(1n, k1, 0x44))

      // One honest vote for the real block: {leader, k2} = 2 of 3.
      const honest2 = new ByzantinePeer(k2, network.createTransport(k2), { ...byzOpts(validators), listen: false })
      await honest2.prepare([k1], 0n, 1n, realDigest)

      // The liar holds the third vote and spends it on a block nobody
      // proposed — correctly signed, right view, right sequence, wrong block.
      // It commits to the phantom too, for good measure.
      const liar = new ByzantinePeer(byz, network.createTransport(byz), { ...byzOpts(validators), listen: false })
      await liar.prepare([k1], 0n, 1n, phantomDigest)
      await liar.commit([k1], 0n, 1n, phantomDigest)
      await settle()

      // The real block is still one vote short, and nothing finalized.
      expect(p1.finalized).toHaveLength(0)
      expect(p1.consensus.phase).toBe(PBFTPhase.PrePrepared)

      // One genuine vote for the real block is all that was missing — so the
      // round was healthy and the liar's vote was the only thing withheld.
      const honest3 = new ByzantinePeer(k3, network.createTransport(k3), { ...byzOpts(validators), listen: false })
      await honest3.prepare([k1], 0n, 1n, realDigest)
      await settle()
      expect(p1.consensus.phase).toBe(PBFTPhase.Prepared)

      p1.consensus.stop()
    })

    /**
     * The same validator sending the same valid vote over and over.
     *
     * Quorum counts distinct validators, not messages. A repeated vote is
     * indistinguishable from a re-broadcast on a lossy link, so this must be
     * handled by counting, not by rejecting — and it is the cheapest possible
     * attack: no forgery, no timing, just say it again.
     */
    it('cannot reach quorum by repeating one valid vote', async () => {
      const k1 = makeTestKey(1) // honest leader
      const k2 = makeTestKey(2)
      const k3 = makeTestKey(3)
      const byz = makeTestKey(4)
      const validators = new ValidatorSet([k1, k2, k3, byz])

      const p1 = honestPeer(k1, validators)

      const block = makeBlock(1n, k1, 0x55)
      await p1.consensus.propose(block)
      await settle()
      const digest = await ByzantinePeer.digestOf(block)

      // k2 and k3 are silent. The liar repeats its one vote five times —
      // enough to clear a quorum of 3 if messages were counted.
      const liar = new ByzantinePeer(byz, network.createTransport(byz), { ...byzOpts(validators), listen: false })
      for (let i = 0; i < 5; i++) {
        await liar.prepare([k1], 0n, 1n, digest)
        await liar.commit([k1], 0n, 1n, digest)
      }
      await settle()

      // Two distinct validators have voted (leader + liar); quorum is 3.
      expect(p1.finalized).toHaveLength(0)
      expect(p1.consensus.phase).toBe(PBFTPhase.PrePrepared)

      p1.consensus.stop()
    })
  })

  describe('a vote replayed into another phase', () => {
    /**
     * A PREPARE is broadcast to every peer, so every peer holds one. If a
     * PREPARE and a COMMIT sign the same bytes, then holding a validator's
     * PREPARE *is* holding its COMMIT, and the commit phase proves nothing —
     * one silent eavesdropper can finalize a block that no quorum ever
     * committed.
     *
     * Unlike the message-level test in pbft.test.ts, the signatures replayed
     * here are not hand-built: the Byzantine node harvested them off the wire
     * from votes real peers actually broadcast. That is how the attack would
     * happen, and it is why `voteDigest` puts the phase inside the signed
     * bytes.
     */
    it('cannot turn PREPAREs it overheard into the COMMITs a block still needs', async () => {
      const k1 = makeTestKey(1) // honest leader under test
      const k2 = makeTestKey(2)
      const k3 = makeTestKey(3)
      const byz = makeTestKey(4)
      const validators = new ValidatorSet([k1, k2, k3, byz])

      const p1 = honestPeer(k1, validators)

      // The eavesdropper: registered on the network, sends nothing of its own,
      // and relays through a transport that lets it choose the `from` it
      // announces. That last part is not cheating — the in-memory networks
      // here bind `from` to the sending transport, which authenticates every
      // peer for free and is precisely what a real relay, gossip hub or
      // signalling server does NOT do. `PBFTConsensus` is written for that
      // world: it treats `from` as a claim and puts the phase, view and
      // sequence inside the signed bytes so the claim can be settled.
      const liar = new ByzantinePeer(byz, network.createTransport(byz), {
        ...byzOpts(validators),
        spoof: (identity) => network.createTransport(identity),
      })

      const block = makeBlock(1n, k1, 0x66)
      await p1.consensus.propose(block)
      await settle()
      const digest = await ByzantinePeer.digestOf(block)

      // k2 and k3 prepare and then go quiet before committing (a crash
      // between phases — the ordinary case, not an attack). Their PREPAREs go
      // to the leader and, being broadcasts, to the eavesdropper as well.
      for (const key of [k2, k3]) {
        const peer = new ByzantinePeer(key, network.createTransport(key), { ...byzOpts(validators), listen: false })
        await peer.prepare([k1, byz], 0n, 1n, digest)
      }
      await settle()

      // The leader now has a PREPARE quorum and has sent its own COMMIT, so
      // the block sits one short of finalizing: commits = {k1}, needs 3.
      expect(p1.consensus.phase).toBe(PBFTPhase.Prepared)
      expect(p1.finalized).toHaveLength(0)

      // The eavesdropper really did capture two PREPAREs off the wire.
      const captured = liar.overheardPrepares().filter((m) => toHex(m.from) !== toHex(k1))
      expect(captured).toHaveLength(2)

      // Replay them at the leader as COMMITs from their original signers,
      // signatures untouched. Under a bare-digest signing scheme these are
      // valid COMMITs from k2 and k3 and the block finalizes.
      for (const prepare of captured) {
        liar.replayAs([k1], prepare, { type: 'commit' })
      }
      await settle()

      expect(p1.finalized).toHaveLength(0)
      expect(p1.consensus.phase).toBe(PBFTPhase.Prepared)

      p1.consensus.stop()
    })
  })
})
