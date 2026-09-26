/**
 * Validator catch-up / state-sync after a crash (issue #45), end-to-end
 * through the real `ValidatorNode`/`BlockProducer`/`Mempool` stack and the
 * test harness's own transport/orchestrator -- not just the consensus-level
 * mechanics (see packages/consensus/test/sync.test.ts for those, with full
 * control over message delivery).
 *
 * Before this fix, `TestOrchestrator.restartNode` had to seed a fresh
 * node's store by reaching directly into a peer's `InMemoryStateStore`
 * (documented there as "the test harness's minimal stand-in" for a real
 * protocol) -- there was no way for a rejoining node to learn the current
 * view or catch up on a round in flight at all. `restartNodeViaSync` uses
 * the real API instead: `RaijinTestNode.syncFrom` -> `ValidatorNode.syncFrom`
 * -> `PBFTConsensus.importSyncState` (view + justifying VIEW-CHANGE quorum,
 * round in flight) plus the state store's own `exportData`/`importData`.
 */

import { describe, it, expect } from 'vitest'

import { toHex } from '@johnhenry/raijin-core'
import { TestOrchestrator } from '../src/orchestrator.js'
import { NoForkChecker } from '../src/checkers/no-fork.js'

describe('Validator catch-up via the real sync API: 4-node cluster', () => {
  it('a validator crashed mid-round, restarted via syncFrom, ends up at the correct height, adopts the current view after a later view change, and keeps participating correctly', async () => {
    const orch = new TestOrchestrator()
    orch.addNode('a') // leader for view 0
    orch.addNode('b')
    orch.addNode('c') // stays up for the whole test -- the "never went down" comparison peer
    orch.addNode('d') // the one that crashes and rejoins
    orch.startAll()

    const keys = ['a', 'b', 'c', 'd'].map((id) => orch.getKey(id))
    for (const k of keys) await orch.fundAccount(k, 10_000n)

    // Block 1, normally, with all four up.
    expect(await orch.produceBlock(keys[0], keys[1], 100n)).toBe(true)
    for (const [id, node] of orch.nodes) {
      expect(node.latestBlock, id).not.toBeNull()
      expect(node.latestBlock!.header.number, id).toBe(1n)
    }

    // Crash 'd' right as the leader proposes block 2 -- it is disconnected
    // before the round's messages are drained, so it never sees any of
    // them (the strongest version of "killed mid-round": zero visibility
    // into the round, exactly the case a rejoining node has no memory of).
    const leaderId = orch.findLeader()! // 'a'
    const leader = orch.nodes.get(leaderId)!
    await leader.submitTx(keys[1], keys[2], 50n, 1n)
    const block2 = await leader.proposeBlock()
    expect(block2).not.toBeNull()

    orch.crashNode('d')
    await orch.drainFully()

    // The three survivors are exactly quorum (n=4, f=1, 2f+1=3) and
    // finalize block 2 without 'd'.
    for (const id of ['a', 'b', 'c']) {
      const node = orch.nodes.get(id)!
      expect(node.latestBlock, id).not.toBeNull()
      expect(node.latestBlock!.header.number, id).toBe(2n)
    }

    // Restart 'd' and catch it up through the real API rather than a
    // direct store copy.
    await orch.restartNodeViaSync('d')

    const c = orch.nodes.get('c')!
    const d = orch.nodes.get('d')!

    expect(d.latestBlock, 'd should have caught up to height 2').not.toBeNull()
    expect(d.latestBlock!.header.number).toBe(2n)
    expect(d.node.consensus.currentView).toBe(c.node.consensus.currentView)
    expect(toHex(await d.store.root())).toBe(toHex(await c.store.root()))

    // Now force a REAL view change: crash the current leader ('a'). The
    // three survivors (b, c, and the just-resynced d) are again exactly
    // quorum, and 'd' -- fully caught up -- participates in the live
    // VIEW-CHANGE vote itself, same as any other honest node.
    orch.crashNode(leaderId)
    expect(orch.findLeader()).toBeNull()
    await orch.advanceTime(11_000) // past the default 10s view timeout

    const newLeaderId = orch.findLeader()
    expect(newLeaderId).not.toBeNull()
    expect(newLeaderId).not.toBe(leaderId)
    for (const id of ['b', 'c', 'd']) {
      expect(orch.nodes.get(id)!.node.consensus.currentView, id).toBeGreaterThan(0n)
    }
    // d's view genuinely matches its peers' -- it isn't just running, it's
    // running the same protocol state as everyone else.
    expect(d.node.consensus.currentView).toBe(c.node.consensus.currentView)

    // The new leader produces block 3; all three survivors (including d)
    // must finalize it, which requires d's own PREPARE and COMMIT to count
    // toward quorum -- not just that it's connected.
    expect(await orch.produceBlock(keys[2], keys[3], 25n)).toBe(true)
    for (const id of ['b', 'c', 'd']) {
      const node = orch.nodes.get(id)!
      expect(node.latestBlock, id).not.toBeNull()
      expect(node.latestBlock!.header.number, id).toBe(3n)
    }

    // Final state matches the peer that never crashed at all.
    expect(toHex(await d.store.root())).toBe(toHex(await c.store.root()))

    const noFork = await orch.check(new NoForkChecker())
    expect(noFork.passed, noFork.details).toBe(true)
  })
})
