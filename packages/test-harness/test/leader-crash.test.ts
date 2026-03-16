/**
 * Leader crash test: crash the leader, trigger view change, verify new
 * leader can produce blocks. All surviving nodes must finalize.
 */

import { describe, it, expect } from 'vitest'
import { TestOrchestrator } from '../src/orchestrator.js'
import { NoForkChecker } from '../src/checkers/no-fork.js'
import { GossipConvergenceChecker } from '../src/checkers/gossip-convergence.js'

describe('Leader crash: 4-node cluster', () => {
  it('recovers via view change when the leader crashes', async () => {
    const orch = new TestOrchestrator()
    orch.addNode('a')
    orch.addNode('b')
    orch.addNode('c')
    orch.addNode('d')
    orch.startAll()

    const keys = ['a', 'b', 'c', 'd'].map(id => orch.getKey(id))
    for (const k of keys) await orch.fundAccount(k, 5000n)

    // Block 1 normally
    expect(await orch.produceBlock(keys[0], keys[1], 100n)).toBe(true)
    for (const [, node] of orch.nodes) {
      expect(node.latestBlock!.header.number).toBe(1n)
    }

    // Crash the leader
    const leaderId = orch.findLeader()!
    orch.crashNode(leaderId)

    // Verify no leader now
    expect(orch.findLeader()).toBeNull()

    // Advance timer past viewTimeout → triggers view change on surviving nodes
    await orch.advanceTime(11000)

    // New leader should exist
    const newLeaderId = orch.findLeader()
    expect(newLeaderId).not.toBeNull()
    expect(newLeaderId).not.toBe(leaderId)

    // New leader produces block 2
    const ok = await orch.produceBlock(keys[1], keys[2], 50n)
    expect(ok).toBe(true)

    // ALL surviving nodes must have finalized block 2
    for (const [id, node] of orch.runningNodes()) {
      expect(node.latestBlock, `${id} should have block 2`).not.toBeNull()
      expect(node.latestBlock!.header.number).toBe(2n)
    }

    // No fork among surviving nodes
    const noFork = await orch.check(new NoForkChecker())
    expect(noFork.passed).toBe(true)

    // Surviving nodes converge
    const convergence = await new GossipConvergenceChecker().check(orch.runningNodes())
    expect(convergence.passed).toBe(true)

    // Timeline should show the view change events
    const timeline = orch.buildTimeline()
    const crashEvents = timeline.filter(e => e.type === 'node-crashed')
    expect(crashEvents.length).toBe(1)
  })
})
