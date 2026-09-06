/**
 * Partition tests: verify quorum loss and recovery with reversible partitions.
 */

import { describe, it, expect } from 'vitest'
import { TestOrchestrator } from '../src/orchestrator.js'
import { NoForkChecker } from '../src/checkers/no-fork.js'
import { GossipConvergenceChecker } from '../src/checkers/gossip-convergence.js'

describe('Partition: 4-node cluster', () => {
  it('loses quorum when 2 of 4 nodes are partitioned', async () => {
    const orch = new TestOrchestrator()
    orch.addNode('a')
    orch.addNode('b')
    orch.addNode('c')
    orch.addNode('d')
    orch.startAll()

    const keys = ['a', 'b', 'c', 'd'].map(id => orch.getKey(id))
    for (const k of keys) await orch.fundAccount(k, 1000n)

    // Produce one block normally
    const ok = await orch.produceBlock(keys[0], keys[1], 50n)
    expect(ok).toBe(true)
    for (const [, node] of orch.nodes) {
      expect(node.latestBlock!.header.number).toBe(1n)
    }

    // Partition: {a, b} isolated from {c, d}
    orch.partition(['a', 'b'], ['c', 'd'])

    // Try to produce a block — should fail (quorum = 3, only 2 per side)
    const leaderId = orch.findLeader()!
    const leader = orch.nodes.get(leaderId)!
    await leader.submitTx(keys[0], keys[1], 10n, orch.nextNonce(keys[0]))
    const block = await leader.proposeBlock()
    if (block) await orch.drainFully()

    // Still at block 1 — no new block finalized
    expect(leader.latestBlock!.header.number).toBe(1n)
    expect((await orch.check(new NoForkChecker())).passed).toBe(true)
  })

  it('heals partition and resumes consensus', async () => {
    const orch = new TestOrchestrator()
    orch.addNode('a')
    orch.addNode('b')
    orch.addNode('c')
    orch.addNode('d')
    orch.startAll()

    const keys = ['a', 'b', 'c', 'd'].map(id => orch.getKey(id))
    for (const k of keys) await orch.fundAccount(k, 1000n)

    // Produce block 1
    expect(await orch.produceBlock(keys[0], keys[1], 50n)).toBe(true)

    // Partition
    orch.partition(['a', 'b'], ['c', 'd'])

    // Try block during partition — fails
    const leaderId = orch.findLeader()!
    const leader = orch.nodes.get(leaderId)!
    await leader.submitTx(keys[0], keys[1], 10n, orch.nextNonce(keys[0]))
    const failedBlock = await leader.proposeBlock()
    if (failedBlock) await orch.drainFully()
    expect(leader.latestBlock!.header.number).toBe(1n)

    // Heal partition — messages flow again
    orch.healPartition()

    // View change needed because the leader's consensus is in non-Idle phase
    await orch.advanceTime(11000)

    // Now produce block 2 with full network
    const ok = await orch.produceBlock(keys[0], keys[1], 25n)
    expect(ok).toBe(true)

    /*
     * Progress first, THEN agreement. Both checkers below pass vacuously when
     * nothing was committed: GossipConvergenceChecker compares each node's
     * LAST finalized block, so four nodes all still stuck at the pre-partition
     * height 1 look perfectly converged, and NoForkChecker groups finalized
     * blocks by height, so a height nobody reached is simply absent from the
     * map.
     *
     * `ok` does not cover it either -- produceBlock returns true as soon as
     * the leader yields a block and the network drains, without checking that
     * a quorum committed. Injecting `if (this.#view > 0n) return` into PBFT's
     * #onPrepared, so no round after any view change ever commits, left this
     * test green while leader-crash.test.ts failed on exactly this assertion.
     *
     * The partition healed and a view change happened, so the whole point is
     * that the network got PAST height 1.
     */
    for (const [id, node] of orch.nodes) {
      expect(node.latestBlock!.header.number, `node ${id} advanced past the partition`).toBe(2n)
    }

    // All nodes should converge
    const convergence = await orch.check(new GossipConvergenceChecker())
    expect(convergence.passed).toBe(true)

    const noFork = await orch.check(new NoForkChecker())
    expect(noFork.passed).toBe(true)
    // And it compared something: "no forks" across zero heights is not a
    // safety result. See raijin#37.
    expect(noFork.heightsCompared ?? 0, 'the fork check verified nothing').toBeGreaterThan(0)
  })
})
