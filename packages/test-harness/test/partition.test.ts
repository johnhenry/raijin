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

    // All nodes should converge
    const convergence = await orch.check(new GossipConvergenceChecker())
    expect(convergence.passed).toBe(true)
    expect((await orch.check(new NoForkChecker())).passed).toBe(true)
  })
})
