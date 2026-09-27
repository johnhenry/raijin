/**
 * The view-change timer fires once and is never re-armed (issue #48).
 *
 * `PBFTConsensus`'s view timer used to call `#requestViewChange` exactly
 * once. If that single VIEW-CHANGE didn't reach quorum -- e.g. because it
 * was lost in transit during a network partition, not merely delayed -- no
 * further VIEW-CHANGE was ever sent, and the node stalled in the old view
 * permanently, even long after the partition healed.
 *
 * This models "lost", not "delayed": `PartitionableNetwork.partition()`
 * BLOCKS delivery but still holds messages in its queue, so a VIEW-CHANGE
 * sent during a held partition is eventually delivered once healed anyway
 * (see partition.test.ts) -- that was never the bug. The actual bug needs a
 * VIEW-CHANGE that is genuinely gone, which a 100%-drop-rate edge (packets
 * actually lost, as `PBFTConsensus`'s own repro used) models correctly.
 *
 * n=4, f=1, quorum=3: crashing the leader leaves exactly 3 survivors who
 * need every one of their own VIEW-CHANGE votes to reach quorum. Dropping
 * all traffic between them for the FIRST timeout round means nobody
 * accumulates more than their own self-vote -- a genuine stall. Only once
 * the drop is lifted AND the view timer re-arms and retries does the
 * cluster recover.
 */

import { describe, it, expect } from 'vitest'
import { TestOrchestrator } from '../src/orchestrator.js'

describe('View-change timer re-arms after an unanswered VIEW-CHANGE: 4-node cluster', () => {
  it('recovers once a later retry gets through, after the first VIEW-CHANGE round was entirely lost', async () => {
    // A seed is required for drop rates to take effect at all --
    // `PartitionableNetwork#enqueue` only consults the configured drop rate
    // when a PRNG is set (see `setPRNG`); without one, `addDropRate` would
    // silently drop nothing.
    const orch = new TestOrchestrator({ seed: 1337 })
    // Short view timeout so the test doesn't need to simulate a real 10s wait.
    orch.addNode('a', { viewTimeout: 500 }) // leader for view 0
    orch.addNode('b', { viewTimeout: 500 })
    orch.addNode('c', { viewTimeout: 500 })
    orch.addNode('d', { viewTimeout: 500 })
    orch.startAll()

    const keys = ['a', 'b', 'c', 'd'].map((id) => orch.getKey(id))
    for (const k of keys) await orch.fundAccount(k, 5000n)

    const bKey = orch.getKey('b')
    const cKey = orch.getKey('c')
    const dKey = orch.getKey('d')
    const survivorPairs: [Uint8Array, Uint8Array][] = [
      [bKey, cKey], [cKey, bKey],
      [bKey, dKey], [dKey, bKey],
      [cKey, dKey], [dKey, cKey],
    ]

    // Crash the leader -- b, c, d are the 3 survivors, exactly quorum
    // (2f+1=3) among themselves.
    orch.crashNode('a')
    expect(orch.findLeader()).toBeNull()

    // "The partition": every survivor's traffic to every other survivor is
    // actually lost, not merely delayed.
    for (const [from, to] of survivorPairs) orch.network.addDropRate(from, to, 1)

    // Past the 500ms view timeout: each survivor's view timer fires and
    // broadcasts its own VIEW-CHANGE, but every one of those broadcasts is
    // dropped. Each survivor only ever counts its OWN self-processed vote
    // (self-processing is a direct call, not a network send, so it isn't
    // subject to the drop rate) -- 1 of the 3 needed. Nobody reaches quorum.
    await orch.advanceTime(600)
    // Generous extra drain margin before checking "still stalled": this
    // must reflect that the first VIEW-CHANGE round genuinely had every
    // chance to go out (and be dropped), not that this check merely ran
    // before its real async signing (crypto.subtle) finished. Getting this
    // wrong would make the "still stalled" assertion below pass for the
    // wrong reason. `drainFully` is a no-op once nothing is pending, so a
    // large budget only matters under contention.
    await orch.drainFully(300, 8)

    expect(orch.findLeader(), 'still stalled -- the first VIEW-CHANGE round was entirely lost').toBeNull()
    for (const id of ['b', 'c', 'd']) {
      expect(orch.nodes.get(id)!.node.consensus.currentView, id).toBe(0n)
    }

    // The partition heals.
    for (const [from, to] of survivorPairs) orch.network.removeDropRate(from, to)

    // Wait past the retry backoff (2x the 500ms base -- see
    // `PBFTConsensus#armViewChangeRetry`). Without the fix, nothing would
    // ever fire again here and the cluster would stay stalled forever, no
    // matter how long this waits. Drained with the same generous budget as
    // above, for the same reason -- this scenario pushes through an
    // unusually large burst of signing (two full VIEW-CHANGE rounds across
    // three nodes), and real `crypto.subtle` calls can take longer to
    // settle than the default drain budget assumes under heavy parallel
    // test load.
    await orch.advanceTime(1200)
    await orch.drainFully(300, 8)

    const newLeaderId = orch.findLeader()
    expect(newLeaderId, 'a later VIEW-CHANGE retry got through once the partition healed').not.toBeNull()
    for (const id of ['b', 'c', 'd']) {
      expect(orch.nodes.get(id)!.node.consensus.currentView, id).toBeGreaterThan(0n)
    }

    // And consensus genuinely resumes, not just "some view counter moved".
    const ok = await orch.produceBlock(keys[1], keys[2], 25n)
    expect(ok).toBe(true)
    for (const id of ['b', 'c', 'd']) {
      const node = orch.nodes.get(id)!
      expect(node.latestBlock, id).not.toBeNull()
      expect(node.latestBlock!.header.number).toBe(1n)
    }
  })
})
