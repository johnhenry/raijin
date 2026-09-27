/**
 * A PRE-PREPARE for the next sequence arriving before this node finished the
 * current round's COMMITs (issue #47).
 *
 * The #44 fix buffered a PREPARE/COMMIT that arrives one sequence ahead of a
 * node's current round, so a slow node doesn't lose one of the votes it
 * needs toward quorum. It did NOT cover PRE-PREPARE itself: before this fix,
 * `#handlePrePrepare` accepted a PRE-PREPARE for the next sequence
 * unconditionally, with no check that the CURRENT round had actually
 * finished. A transport that doesn't guarantee cross-link ordering can
 * easily deliver the leader's next PRE-PREPARE (broadcast the instant the
 * leader itself finalizes) to a node that is still short a COMMIT or two for
 * the round in flight, simply because those specific messages are stuck on a
 * slower link. Accepting it then abandons the in-flight round -- including
 * whatever PREPARE/COMMIT votes were already collected for it -- and starts
 * executing the NEXT block on top of state that never saw the one it
 * skipped. That is a silent divergence: the node's own state root drifts
 * from its peers', and `applyBlock` used to check neither the block number
 * nor parent-hash linkage to catch it.
 *
 * This reproduces exactly that shape: delay 'b' and 'c's messages to 'd'
 * (their PREPARE/COMMIT for round 2, and incidentally round 3's too) so 'd'
 * is stuck short of quorum on round 2 while 'a', 'b', 'c' finish rounds 2
 * AND 3 among themselves (they're exactly quorum -- n=4, f=1, 2f+1=3 -- so
 * 'd' isn't needed). The leader's PRE-PREPARE for round 3 reaches 'd' over
 * the UNDELAYED a->d link before 'd' ever finishes round 2.
 */

import { describe, it, expect } from 'vitest'

import { toHex } from '@johnhenry/raijin-core'
import { PBFTPhase } from '@johnhenry/raijin-consensus'
import { TestOrchestrator } from '../src/orchestrator.js'
import { NoForkChecker } from '../src/checkers/no-fork.js'

describe('Early PRE-PREPARE before the current round finishes: 4-node cluster', () => {
  it('buffers the next round instead of abandoning the one in flight, and catches up cleanly once it can', async () => {
    const orch = new TestOrchestrator()
    orch.addNode('a') // leader for view 0 (round-robin over registration order)
    orch.addNode('b')
    orch.addNode('c')
    orch.addNode('d')
    orch.startAll()

    const keys = ['a', 'b', 'c', 'd'].map((id) => orch.getKey(id))
    for (const k of keys) await orch.fundAccount(k, 5000n)

    const bKey = orch.getKey('b')
    const cKey = orch.getKey('c')
    const dKey = orch.getKey('d')

    const a = orch.nodes.get('a')!
    const d = orch.nodes.get('d')!

    // Round 1, with the network still healthy -- everyone (including d)
    // finalizes block 1 normally, establishing a common baseline.
    expect(await orch.produceBlock(keys[0], keys[1], 100n)).toBe(true)
    for (const [id, node] of orch.nodes) {
      expect(node.latestBlock, id).not.toBeNull()
      expect(node.latestBlock!.header.number, id).toBe(1n)
    }

    // Now cripple d's inbound links from b and c. n=4, f=1, quorum=3: 'a',
    // 'b' and 'c' are exactly quorum among themselves, so they can keep
    // finalizing rounds without ever hearing from 'd' again -- and 'd' can
    // never reach a PREPARE quorum of its own (it only ever sees its own
    // vote plus the leader's, undelayed), so it stalls on whatever round is
    // in flight when the delay goes up.
    orch.network.addDelay(bKey, dKey, 20_000)
    orch.network.addDelay(cKey, dKey, 20_000)

    // Round 2: a, b, c finalize it among themselves. d accepts the
    // PRE-PREPARE (over the undelayed a->d link) and sends its own PREPARE,
    // but only ever collects two of the three it needs (itself + a) --
    // b's and c's PREPAREs are stuck behind the delay.
    expect(await orch.produceBlock(keys[1], keys[2], 10n)).toBe(true)
    for (const id of ['a', 'b', 'c']) {
      expect(orch.nodes.get(id)!.latestBlock!.header.number, id).toBe(2n)
    }
    expect(d.latestBlock!.header.number, 'd has not finalized round 2 -- it is short a quorum').toBe(1n)
    expect(d.node.consensus.currentSequence, 'd is still working on round 2').toBe(2n)
    expect(d.node.consensus.phase, 'd never reached Prepared for round 2').toBe(PBFTPhase.PrePrepared)

    // Round 3: the leader finalizes round 2 fast (among a, b, c) and
    // immediately proposes round 3. Its PRE-PREPARE for round 3 reaches d
    // over the still-undelayed a->d link -- while d is still stuck on round
    // 2. This is the exact moment #47 describes: with the bug, d would
    // accept this PRE-PREPARE right now, abandoning round 2 and everything
    // it had collected for it.
    expect(await orch.produceBlock(keys[2], keys[3], 5n)).toBe(true)
    for (const id of ['a', 'b', 'c']) {
      expect(orch.nodes.get(id)!.latestBlock!.header.number, id).toBe(3n)
    }

    // d must NOT have jumped to round 3. It's still exactly where it was:
    // stuck on round 2, having neither skipped it nor been hijacked into
    // executing round 3 on top of incomplete state.
    expect(d.latestBlock!.header.number, 'd did not silently skip to block 3').toBe(1n)
    expect(d.node.consensus.currentSequence, "d's round did not advance").toBe(2n)
    expect(d.node.consensus.phase, 'd is still exactly where it was').toBe(PBFTPhase.PrePrepared)

    // Heal the link and let the delayed round-2 (and round-3) messages
    // through. d should now collect the quorum it was missing, finalize
    // round 2, THEN -- via the buffered PRE-PREPARE replay -- catch up on
    // round 3 too, ending up in the exact same place as everyone else.
    orch.network.removeDelay(bKey, dKey)
    orch.network.removeDelay(cKey, dKey)
    await orch.advanceTime(20_000)

    expect(d.latestBlock, "d fully caught up").not.toBeNull()
    expect(d.latestBlock!.header.number).toBe(3n)
    expect(
      d.finalizedBlocks.map((blk) => blk.header.number),
      'd finalized blocks 1, 2, 3 in order -- it did not skip block 2',
    ).toEqual([1n, 2n, 3n])

    // Same final state as a peer that was never delayed at all.
    expect(toHex(await d.store.root())).toBe(toHex(await a.store.root()))

    const noFork = await orch.check(new NoForkChecker())
    expect(noFork.passed, noFork.details).toBe(true)
    expect(noFork.heightsCompared ?? 0, 'the check verified something').toBeGreaterThanOrEqual(3)
  })
})
