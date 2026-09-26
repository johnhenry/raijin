/**
 * View-change timeout is now configurable (see issue #45's smaller items).
 *
 * `ValidatorNode` (and, in this harness, `RaijinTestNode`/`TestOrchestrator`)
 * used to hardcode PBFTConsensus's ~10s default with no way to override it,
 * which made any test/demo that wants to exercise a view change pay a real
 * 10s wait on the mock clock. This proves a configured, short timeout
 * actually governs when a view change fires -- both that it fires sooner
 * than the 10s default would allow, and that it does not fire before the
 * configured value elapses.
 */

import { describe, it, expect } from 'vitest'
import { TestOrchestrator } from '../src/orchestrator.js'

describe('Configurable view-change timeout', () => {
  it('triggers a view change at the configured timeout, well before the 10s default', async () => {
    const orch = new TestOrchestrator()
    // A short timeout on every node -- crashing the leader should force a
    // view change once THIS elapses, not once the ~10s default would.
    orch.addNode('a', { viewTimeout: 500 })
    orch.addNode('b', { viewTimeout: 500 })
    orch.addNode('c', { viewTimeout: 500 })
    orch.addNode('d', { viewTimeout: 500 })
    orch.startAll()

    const keys = ['a', 'b', 'c', 'd'].map((id) => orch.getKey(id))
    for (const k of keys) await orch.fundAccount(k, 5000n)

    const leaderId = orch.findLeader()!
    orch.crashNode(leaderId)
    expect(orch.findLeader()).toBeNull()

    // Well under the 10s default, but past the configured 500ms -- if the
    // timeout weren't actually configurable, no view change would have
    // happened yet at this point.
    await orch.advanceTime(1000)

    const newLeaderId = orch.findLeader()
    expect(newLeaderId, 'a view change should already have happened by 1s at a 500ms timeout').not.toBeNull()
    expect(newLeaderId).not.toBe(leaderId)

    for (const [id, node] of orch.runningNodes()) {
      expect(node.node.consensus.currentView, `${id}'s view`).toBeGreaterThan(0n)
    }
  })

  it('does not trigger a view change before the configured timeout elapses', async () => {
    const orch = new TestOrchestrator()
    orch.addNode('a', { viewTimeout: 5000 })
    orch.addNode('b', { viewTimeout: 5000 })
    orch.addNode('c', { viewTimeout: 5000 })
    orch.addNode('d', { viewTimeout: 5000 })
    orch.startAll()

    const keys = ['a', 'b', 'c', 'd'].map((id) => orch.getKey(id))
    for (const k of keys) await orch.fundAccount(k, 5000n)

    const leaderId = orch.findLeader()!
    orch.crashNode(leaderId)

    // Comfortably short of the configured 5s timeout.
    await orch.advanceTime(1000)

    expect(orch.findLeader(), 'no view change yet -- the configured timeout has not elapsed').toBeNull()
    for (const [id, node] of orch.runningNodes()) {
      expect(node.node.consensus.currentView, `${id}'s view`).toBe(0n)
    }
  })
})
