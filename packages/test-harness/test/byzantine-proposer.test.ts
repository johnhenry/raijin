/**
 * An equivocating leader inside a cluster of real validator nodes.
 *
 * Every other fault this harness models makes a node stop — crash the leader,
 * crash a follower, partition two against two, heal. None of that is a
 * Byzantine fault, and Byzantine fault tolerance is the entire reason this
 * codebase exists. Here the faulty node keeps running and keeps talking: it
 * is a full member of the validator set, it signs everything correctly, and
 * it tells two halves of the cluster two different things.
 *
 * The nodes it lies to are real `ValidatorNode`s with real state machines, so
 * a successful attack shows up the way it would in production — as two honest
 * nodes holding different state at the same height, which is exactly what
 * `NoForkChecker` looks for.
 */

import { describe, it, expect } from 'vitest'

import {
  TransactionType,
  encodeTx,
  toHex,
  type Block,
  type Transaction,
} from '@johnhenry/raijin-core'
import { TestOrchestrator } from '../src/orchestrator.js'
import { NoForkChecker } from '../src/checkers/no-fork.js'
import { mockSign } from '../../consensus/test/helpers.js'

/** A transfer signed the way the harness's nodes actually verify (see mockSign). */
async function signedTransfer(
  from: Uint8Array,
  to: Uint8Array,
  value: bigint,
  nonce: bigint,
): Promise<Transaction> {
  const tx: Transaction = {
    from,
    to,
    value,
    nonce,
    data: new Uint8Array([TransactionType.Transfer]),
    signature: new Uint8Array(0),
    chainId: 1n,
  }
  tx.signature = await mockSign(from)(encodeTx(tx))
  return tx
}

/**
 * A block a Byzantine leader hands out.
 *
 * `tag` fills `txRoot`, which makes two blocks distinguishable after the fact:
 * it is part of the header (so it changes the consensus digest) and, unlike
 * `stateRoot`/`receiptRoot`, execution never overwrites it.
 */
function byzantineBlock(
  number: bigint,
  proposer: Uint8Array,
  transactions: Transaction[],
  tag: number,
): Block {
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
    transactions,
    signatures: [],
  }
}

/**
 * A 4-node cluster whose view-0 leader is Byzantine.
 *
 * Leader rotation is round-robin over registration order, so the liar is
 * registered first. The three honest nodes are real validator nodes.
 */
async function equivocatingCluster(opts: { seed?: number } = {}) {
  const orch = new TestOrchestrator(opts.seed !== undefined ? { seed: opts.seed } : undefined)
  orch.addByzantineNode('liar') // leader for view 0
  orch.addNode('b')
  orch.addNode('c')
  orch.addNode('d')
  orch.startAll()

  const liar = orch.byzantine.get('liar')!
  const funder = orch.getKey('b')
  const recipient = orch.getKey('d')
  await orch.fundAccount(funder, 10_000n)

  // Two blocks that cannot both be true: same height, same sequence,
  // different transfers, therefore different post-state.
  const blockA = byzantineBlock(1n, liar.publicKey, [await signedTransfer(funder, recipient, 10n, 0n)], 0xaa)
  const blockB = byzantineBlock(1n, liar.publicKey, [await signedTransfer(funder, recipient, 500n, 0n)], 0xbb)

  return { orch, liar, blockA, blockB }
}

describe('Byzantine proposer: 4-node cluster', () => {
  /**
   * n = 4, f = 1, quorum = 3. The liar is the leader, so the three honest
   * nodes split 1 / 2. The lone node can gather at most two PREPAREs for its
   * block — its own and the liar's — and never prepares. Only the pair can
   * reach quorum, and only on one block.
   *
   * What is asserted is the safety property, not that anything threw: a
   * Byzantine leader is entitled to be ignored in silence.
   */
  it('cannot make two honest nodes finalize different blocks at the same height', async () => {
    const { orch, liar, blockA, blockB } = await equivocatingCluster()

    await liar.equivocate({
      view: 0n,
      sequence: 1n,
      groups: [
        { targets: [orch.getKey('b')], block: blockA },
        { targets: [orch.getKey('c'), orch.getKey('d')], block: blockB },
      ],
    })
    await orch.drainFully()

    // No two honest nodes hold different state at the same height. This is
    // the property; everything below is detail that keeps the test honest.
    const noFork = await orch.check(new NoForkChecker())
    expect(noFork.passed, noFork.details).toBe(true)

    // Whatever was finalized, it was one block — not one per group.
    const tags = new Set(
      [...orch.nodes.values()].flatMap((n) => n.finalizedBlocks.map((b) => b.header.txRoot[0])),
    )
    expect(tags.size).toBeLessThanOrEqual(1)

    // Concretely: the isolated node finalized nothing, the pair finalized
    // block B and agree on the resulting state. Stated so this test cannot
    // pass by nothing happening at all.
    expect(orch.nodes.get('b')!.finalizedBlocks).toHaveLength(0)
    expect(orch.nodes.get('c')!.finalizedBlocks).toHaveLength(1)
    expect(orch.nodes.get('d')!.finalizedBlocks).toHaveLength(1)
    expect(orch.nodes.get('c')!.finalizedBlocks[0].header.txRoot[0]).toBe(0xbb)
    expect(
      toHex(orch.nodes.get('c')!.finalizedBlocks[0].header.stateRoot),
    ).toBe(toHex(orch.nodes.get('d')!.finalizedBlocks[0].header.stateRoot))
  })

  /**
   * The same attack under many message interleavings.
   *
   * FIFO delivery is one ordering out of enormously many, and a safety
   * property that only holds under one ordering is not a safety property. The
   * seeded delivery order (see `PartitionableNetwork.setDeliveryOrder`) picks
   * a different interleaving per seed, and a failing seed is named in the
   * assertion message so it can be replayed.
   *
   * SAFETY is asserted per seed. LIVENESS is not, and deliberately so: under
   * some interleavings this round finalizes nothing at all, because
   * `PBFTConsensus` discards a PREPARE or COMMIT whose sequence does not
   * match the one it is currently on (`#handlePrepare`, `#handleCommit`) and
   * never asks for it again. A vote that overtakes the proposal it refers to
   * is simply lost, and the round waits for a view-change timeout. That is an
   * ordinary reordering, not a fault, so it is worth being explicit that the
   * sweep tolerates a stall and does not tolerate a fork.
   */
  it('cannot fork the cluster under any of a range of seeded message interleavings', async () => {
    let seedsThatFinalized = 0
    for (const seed of [1, 2, 3, 7, 42, 1337]) {
      const { orch, liar, blockA, blockB } = await equivocatingCluster({ seed })
      orch.network.setDeliveryOrder('random')

      await liar.equivocate({
        view: 0n,
        sequence: 1n,
        groups: [
          { targets: [orch.getKey('b')], block: blockA },
          { targets: [orch.getKey('c'), orch.getKey('d')], block: blockB },
        ],
      })
      await orch.drainFully()

      const noFork = await orch.check(new NoForkChecker())
      expect(noFork.passed, `seed ${seed}: ${noFork.details ?? ''}`).toBe(true)

      const finalized = [...orch.nodes.values()].flatMap((n) => n.finalizedBlocks)
      const tags = new Set(finalized.map((b) => b.header.txRoot[0]))
      expect(tags.size, `seed ${seed}: honest nodes finalized ${tags.size} distinct blocks`)
        .toBeLessThanOrEqual(1)

      // Whatever this interleaving produced, the isolated node is never part
      // of it — that is the shape a successful equivocation would have.
      expect(orch.nodes.get('b')!.finalizedBlocks, `seed ${seed}`).toHaveLength(0)
      if (finalized.length > 0) {
        seedsThatFinalized++
        expect([...tags], `seed ${seed}`).toEqual([0xbb])
        expect(finalized.length, `seed ${seed}`).toBe(2)
      }
    }

    // Safety is trivial when nothing happens anywhere, so the sweep is only
    // evidence if some of it actually reached a decision. As measured, 3 of
    // these 6 seeds finalize and 3 stall on the dropped-out-of-order-vote
    // behaviour described above; the assertion is left loose rather than
    // pinned to 3, because that number is a property of the current message
    // handling and not something a Byzantine test should freeze.
    expect(seedsThatFinalized).toBeGreaterThan(0)
  })

  /**
   * A seed has to *mean* something.
   *
   * `setDeliveryOrder('random')` is only worth having if a seed names one
   * reproducible interleaving — otherwise "it failed under seed 42" is not a
   * bug report, and sweeping seeds is not coverage. This measures both halves
   * of that claim against the network's own delivery log: the same seed
   * replays exactly, and two different seeds do not produce the same run.
   */
  it('replays exactly under one seed and diverges under another', async () => {
    async function run(seed: number): Promise<string> {
      const { orch, liar, blockA, blockB } = await equivocatingCluster({ seed })
      orch.network.setDeliveryOrder('random')
      await liar.equivocate({
        view: 0n,
        sequence: 1n,
        groups: [
          { targets: [orch.getKey('b')], block: blockA },
          { targets: [orch.getKey('c'), orch.getKey('d')], block: blockB },
        ],
      })
      await orch.drainFully()
      return orch.network.deliveryLog.map((d) => `${d.type} ${d.from}->${d.to}`).join('|')
    }

    const a1 = await run(42)
    const a2 = await run(42)
    const b1 = await run(43)

    expect(a1.length).toBeGreaterThan(0)
    expect(a2).toBe(a1)          // same seed, same interleaving
    expect(b1).not.toBe(a1)      // a different seed is a different run
  })
})
