/**
 * Membership churn: crash and restart nodes during block production.
 */

import { describe, it, expect } from 'vitest'
import { TestOrchestrator } from '../src/orchestrator.js'
import { MembershipChurnWorkload } from '../src/workloads/membership-churn.js'
import { NoForkChecker } from '../src/checkers/no-fork.js'
import { EventLogIntegrityChecker } from '../src/checkers/event-log-integrity.js'

describe('Membership churn', () => {
  it('survives a non-leader crash during block production', async () => {
    const orch = new TestOrchestrator()
    orch.addNode('a')
    orch.addNode('b')
    orch.addNode('c')
    orch.addNode('d')
    orch.startAll()

    for (const id of ['a', 'b', 'c', 'd']) {
      await orch.fundNode(id, 50000n)
    }

    // Find a non-leader to crash
    const leaderId = orch.findLeader()!
    const nonLeader = ['a', 'b', 'c', 'd'].find(id => id !== leaderId)!

    const workload = new MembershipChurnWorkload({
      blocks: 4,
      events: [
        { afterBlock: 1, action: 'crash', nodeId: nonLeader },
        // Don't restart — just verify the cluster survives with 3/4
      ],
    })

    const result = await workload.run(orch)
    expect(result.blocksProduced).toBeGreaterThanOrEqual(3)

    // No fork among surviving nodes
    const noFork = await new NoForkChecker().check(orch.runningNodes())
    expect(noFork.passed).toBe(true)
  })

  it('survives leader crash with view change via churn workload', async () => {
    const orch = new TestOrchestrator()
    orch.addNode('a')
    orch.addNode('b')
    orch.addNode('c')
    orch.addNode('d')
    orch.startAll()

    for (const id of ['a', 'b', 'c', 'd']) {
      await orch.fundNode(id, 50000n)
    }

    const leaderId = orch.findLeader()!

    const workload = new MembershipChurnWorkload({
      blocks: 4,
      events: [
        { afterBlock: 1, action: 'crash', nodeId: leaderId },
      ],
    })

    const result = await workload.run(orch)
    // Should produce at least 3 blocks (1 pre-crash + 2 post-view-change + maybe 1 more)
    expect(result.blocksProduced).toBeGreaterThanOrEqual(3)

    const noFork = await new NoForkChecker().check(orch.runningNodes())
    expect(noFork.passed).toBe(true)
  })

  it('crash and restart a node mid-run', async () => {
    const orch = new TestOrchestrator()
    orch.addNode('a')
    orch.addNode('b')
    orch.addNode('c')
    orch.addNode('d')
    orch.startAll()

    for (const id of ['a', 'b', 'c', 'd']) {
      await orch.fundNode(id, 50000n)
    }

    const leaderId = orch.findLeader()!
    const nonLeader = ['a', 'b', 'c', 'd'].find(id => id !== leaderId)!

    const workload = new MembershipChurnWorkload({
      blocks: 5,
      events: [
        { afterBlock: 1, action: 'crash', nodeId: nonLeader },
        { afterBlock: 3, action: 'restart', nodeId: nonLeader },
      ],
    })

    const result = await workload.run(orch)
    expect(result.blocksProduced).toBeGreaterThanOrEqual(4)

    // The restarted node should be running
    expect(orch.nodes.get(nonLeader)!.running).toBe(true)

    // No fork
    const noFork = await new NoForkChecker().check(orch.runningNodes())
    expect(noFork.passed).toBe(true)
  })
})
