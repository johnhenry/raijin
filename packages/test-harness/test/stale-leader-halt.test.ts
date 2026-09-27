/**
 * A lagging leader's stale re-proposal must not permanently halt the
 * cluster (issue #50), through the real `ValidatorNode`/`BlockProducer`
 * stack and the test harness's own transport/orchestrator -- not just the
 * consensus-level mechanics (see packages/consensus/test/pbft.test.ts for
 * those, with full control over message delivery and view-change timing).
 *
 * Before this fix, `PBFTConsensus#onCommitted`'s number/parent-hash guard
 * (added for #47) only ran at APPLY time -- after a proposal had already
 * gone through PRE-PREPARE/PREPARE/COMMIT. A leader that is behind (just
 * restarted, or missed a round) proposing a stale-numbered block meant
 * every honest node PREPAREd and COMMITted it before anyone refused to
 * *apply* it; that refusal triggered a view change, and the next leader
 * automatically carried the same (now "prepared") stale block forward,
 * repeating forever -- a permanent halt, reproduced 3 of 3 times in the
 * issue's own soak test.
 */

import { describe, it, expect } from 'vitest'

import type { Block } from '@johnhenry/raijin-core'
import { TestOrchestrator } from '../src/orchestrator.js'
import { NoForkChecker } from '../src/checkers/no-fork.js'

/** A minimal, correctly-shaped-but-stale block a lagging leader hands out. */
function staleBlock(number: bigint, proposer: Uint8Array): Block {
  return {
    header: {
      number,
      parentHash: new Uint8Array(32),
      stateRoot: new Uint8Array(32),
      txRoot: new Uint8Array(32),
      receiptRoot: new Uint8Array(32),
      timestamp: Date.now(),
      proposer,
    },
    transactions: [],
    signatures: [],
  }
}

describe('Lagging-leader stale re-proposal: 4-node cluster (issue #50)', () => {
  it('a stale PRE-PREPARE from the view-1 leader is rejected outright, and the cluster recovers at the next (honest) view instead of halting permanently', async () => {
    const orch = new TestOrchestrator()
    // Registration order fixes round-robin leadership: a -> view 0,
    // liar -> view 1, b -> view 2, c -> view 3. n = 4, f = 1, quorum = 3
    // (a, b, c -- exactly the three honest nodes).
    orch.addNode('a', { viewTimeout: 500 })
    orch.addByzantineNode('liar')
    orch.addNode('b', { viewTimeout: 500 })
    orch.addNode('c', { viewTimeout: 500 })
    orch.startAll()

    const keys = ['a', 'b', 'c'].map((id) => orch.getKey(id))
    for (const k of keys) await orch.fundAccount(k, 10_000n)

    // Block 1, normally, under the honest leader 'a'.
    expect(await orch.produceBlock(keys[0], keys[1], 100n)).toBe(true)
    for (const id of ['a', 'b', 'c']) {
      const node = orch.nodes.get(id)!
      expect(node.latestBlock, id).not.toBeNull()
      expect(node.latestBlock!.header.number, id).toBe(1n)
    }

    // Nobody proposes for view 0's remaining slot; once the view timeout
    // elapses, the three honest nodes independently time out and move to
    // view 1 -- the Byzantine 'liar's turn.
    await orch.advanceTime(600)
    expect(orch.findLeader()).toBeNull() // 'liar' is never a RaijinTestNode

    // 'liar' is a lagging leader: it proposes sequence 2 numbered 1 again --
    // already at (not ahead of) every honest node's actual chain tip.
    // Before raijin#50, nothing caught this until apply time, well after
    // every honest node had already PREPAREd and COMMITted it.
    const liar = orch.byzantine.get('liar')!
    const bad = staleBlock(1n, liar.publicKey)
    await liar.peer.prePrepare([orch.getKey('a'), orch.getKey('b'), orch.getKey('c')], 1n, 2n, bad)
    await orch.drainFully()

    // The fix: rejected outright. No honest node applied anything bad, and
    // none is stuck holding a prepared certificate for it either.
    for (const id of ['a', 'b', 'c']) {
      const node = orch.nodes.get(id)!
      expect(node.latestBlock!.header.number, id).toBe(1n)
      expect(node.finalizedBlocks, id).toHaveLength(1)
    }

    // The view-1 timeout elapses with nothing pending; the three honest
    // nodes move on to view 2 -- 'b's turn, an honest leader.
    await orch.advanceTime(600)
    expect(orch.findLeader()).toBe('b')

    // The cluster is NOT permanently halted: 'b' proposes block 2 and every
    // honest node finalizes it. (Pre-#50, 'b' would instead have
    // immediately re-proposed the same stale block via view-change
    // carry-over, and this would time out and repeat forever instead.)
    expect(await orch.produceBlock(keys[1], keys[2], 50n)).toBe(true)
    for (const id of ['a', 'b', 'c']) {
      const node = orch.nodes.get(id)!
      expect(node.latestBlock, id).not.toBeNull()
      expect(node.latestBlock!.header.number, id).toBe(2n)
    }

    const noFork = await orch.check(new NoForkChecker())
    expect(noFork.passed, noFork.details).toBe(true)
  })
})
