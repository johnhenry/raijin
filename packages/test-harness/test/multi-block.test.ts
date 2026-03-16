/**
 * Multi-block test: drive 5+ blocks through consensus and verify chain integrity.
 */

import { describe, it, expect } from 'vitest'
import { TestOrchestrator } from '../src/orchestrator.js'
import { ConsensusBlockWorkload } from '../src/workloads/consensus-block.js'
import { NoForkChecker } from '../src/checkers/no-fork.js'
import { EventLogIntegrityChecker } from '../src/checkers/event-log-integrity.js'
import { GossipConvergenceChecker } from '../src/checkers/gossip-convergence.js'

describe('Multi-block: 3-node cluster', () => {
  it('produces 5 blocks sequentially via workload', async () => {
    const orch = new TestOrchestrator()
    orch.addNode('a')
    orch.addNode('b')
    orch.addNode('c')
    orch.startAll()

    const keys = ['a', 'b', 'c'].map(id => orch.getKey(id))
    for (const k of keys) await orch.fundAccount(k, 10000n)

    const workload = new ConsensusBlockWorkload({ blocks: 5 })
    const result = await workload.run(orch)

    expect(result.blocksProduced).toBe(5)
    expect(result.errors).toHaveLength(0)

    // All nodes should have 5 blocks
    for (const [id, node] of orch.nodes) {
      expect(node.finalizedBlocks.length, `${id} should have 5 blocks`).toBe(5)
    }

    // Invariant checks
    expect((await orch.check(new NoForkChecker())).passed).toBe(true)
    expect((await orch.check(new EventLogIntegrityChecker())).passed).toBe(true)
    expect((await orch.check(new GossipConvergenceChecker())).passed).toBe(true)
  })

  it('produces 10 blocks with 4 validators', async () => {
    const orch = new TestOrchestrator()
    orch.addNode('v1')
    orch.addNode('v2')
    orch.addNode('v3')
    orch.addNode('v4')
    orch.startAll()

    for (const id of ['v1', 'v2', 'v3', 'v4']) {
      await orch.fundNode(id, 50000n)
    }

    const workload = new ConsensusBlockWorkload({ blocks: 10 })
    const result = await workload.run(orch)

    expect(result.blocksProduced).toBe(10)
    for (const [, node] of orch.nodes) {
      expect(node.finalizedBlocks.length).toBe(10)
    }

    expect((await orch.check(new NoForkChecker())).passed).toBe(true)
    expect((await orch.check(new EventLogIntegrityChecker())).passed).toBe(true)
  })
})
