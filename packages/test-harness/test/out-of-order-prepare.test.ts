/**
 * Out-of-order PREPARE before its PRE-PREPARE (issue #44).
 *
 * With 4 validators and one down, quorum (2f+1=3) requires all three
 * remaining honest nodes to fully participate in a round: PREPARE AND
 * COMMIT. A transport that doesn't guarantee cross-link ordering (a real
 * network, or an in-memory pub/sub without ordering) can deliver a PREPARE
 * to a node before the PRE-PREPARE it depends on, even though every message
 * was sent in the "right" order and nothing is actually faulty. The old
 * behaviour discarded that PREPARE outright (`#handlePrepare` dropped
 * anything whose sequence didn't exactly match the node's current one) --
 * which costs that node one of the three votes it needs. Because every one
 * of the three surviving nodes is required for quorum here, losing even one
 * node's vote stalls the ENTIRE round (not just that node), and the cluster
 * pays for it with an unnecessary view change even though 3 honest
 * validators were present and PBFT-safe the whole time.
 *
 * `PartitionableNetwork` preserves each link's own delivery order but
 * reorders across links (see its docs) -- exactly the transport model this
 * bug depends on. Delaying only the leader's direct link to one follower
 * lets a third node's PREPARE (sent only after it processes the undelayed
 * PRE-PREPARE) race ahead of the leader's own messages on the delayed link.
 */

import { describe, it, expect } from 'vitest'

import { toHex } from '@johnhenry/raijin-core'
import { TestOrchestrator } from '../src/orchestrator.js'
import { NoForkChecker } from '../src/checkers/no-fork.js'

describe('Out-of-order PREPARE before PRE-PREPARE: 4-node cluster, one down', () => {
  it('completes the round without an unnecessary view change when a PREPARE beats its PRE-PREPARE', async () => {
    const orch = new TestOrchestrator()
    orch.addNode('a') // leader for view 0 (round-robin over registration order)
    orch.addNode('b')
    orch.addNode('c')
    orch.addNode('d')
    orch.startAll()

    const keys = ['a', 'b', 'c', 'd'].map((id) => orch.getKey(id))
    for (const k of keys) await orch.fundAccount(k, 5000n)

    // n=4, f=1: kill one validator. 3 remain -- still a valid PBFT quorum
    // (2f+1=3), but now every remaining node's own PREPARE and COMMIT is
    // required to reach it; there is no longer a spare vote to lose.
    orch.crashNode('d')
    expect(orch.findLeader()).toBe('a')

    const leader = orch.nodes.get('a')!
    const aKey = orch.getKey('a')
    const bKey = orch.getKey('b')
    const cKey = orch.getKey('c')

    // Delay the leader's direct messages to 'b'. Per-link order is
    // preserved (PartitionableNetwork), so the leader's own PRE-PREPARE and
    // PREPARE to 'b' still arrive in the order the leader sent them -- but
    // 'c', reached without delay, processes the PRE-PREPARE immediately and
    // broadcasts its own PREPARE, which is free to reach 'b' first.
    orch.network.addDelay(aKey, bKey, 5000)

    await leader.submitTx(keys[0], keys[1], 100n, 0n)
    const block = await leader.proposeBlock()
    expect(block).not.toBeNull()

    // Drain everything deliverable right now WITHOUT advancing the logical
    // clock. The delayed a->b messages stay queued; everything else moves.
    await orch.drainFully()

    expect(orch.network.pending, 'the delayed a->b messages should still be queued').toBeGreaterThan(0)

    const bHex = toHex(bKey)
    const cHex = toHex(cKey)
    const log = orch.network.deliveryLog

    // The reordering actually happened: 'b' received c's PREPARE...
    expect(
      log.some((d) => d.type === 'prepare' && d.from === cHex && d.to === bHex),
      'expected c\'s PREPARE to have reached b already',
    ).toBe(true)
    // ...strictly before it ever saw the leader's PRE-PREPARE (still
    // sitting in the delayed queue at this point).
    expect(
      log.some((d) => d.type === 'pre-prepare' && d.to === bHex),
      'the leader\'s PRE-PREPARE to b must not have been delivered yet',
    ).toBe(false)

    const bNode = orch.nodes.get('b')!
    expect(bNode.latestBlock, 'b has not finalized yet -- it is still waiting on the delayed link').toBeNull()

    // Release the delayed messages. Remove the standing delay first --
    // otherwise it would also apply to messages generated *after* this
    // point (e.g. the leader's COMMIT, sent only once b's PREPARE reaches
    // it), re-delaying them from whatever the clock has advanced to and
    // masking completion behind a second, incidental delay this test isn't
    // about. 5s is well within the default 10s view timeout, so nothing
    // here should force a view change.
    orch.network.removeDelay(aKey, bKey)
    await orch.advanceTime(5000)

    for (const id of ['a', 'b', 'c']) {
      const node = orch.nodes.get(id)!
      expect(node.latestBlock, `${id} should have finalized block 1`).not.toBeNull()
      expect(node.latestBlock!.header.number).toBe(1n)
    }

    // No view change was needed anywhere -- the round completed in view 0.
    for (const id of ['a', 'b', 'c']) {
      expect(orch.nodes.get(id)!.node.consensus.currentView, `${id}'s view`).toBe(0n)
    }

    // And the previously-delayed PRE-PREPARE really did arrive by now,
    // confirming the earlier absence wasn't just a timing fluke.
    expect(
      orch.network.deliveryLog.some((d) => d.type === 'pre-prepare' && d.to === bHex),
    ).toBe(true)

    const noFork = await orch.check(new NoForkChecker())
    expect(noFork.passed, noFork.details).toBe(true)
  })
})
