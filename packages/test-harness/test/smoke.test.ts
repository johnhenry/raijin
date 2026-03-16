/**
 * Smoke test: 3 nodes, fund accounts, transfer, produce block, verify consensus.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { TestOrchestrator } from '../src/orchestrator.js'
import { NoForkChecker } from '../src/checkers/no-fork.js'
import { BalanceConsistencyChecker } from '../src/checkers/balance-consistency.js'

describe('Smoke: 3-node cluster', () => {
  let orch: TestOrchestrator

  beforeEach(() => {
    orch = new TestOrchestrator()
  })

  it('finalizes a block with a transfer across 3 nodes', async () => {
    orch.addNode('a')
    orch.addNode('b')
    orch.addNode('c')

    const keyA = orch.getKey('a')
    const keyB = orch.getKey('b')
    const keyC = orch.getKey('c')

    orch.startAll()

    await orch.fundAccount(keyA, 1000n)
    await orch.fundAccount(keyB, 1000n)
    await orch.fundAccount(keyC, 1000n)

    // Produce a block via convenience method
    const ok = await orch.produceBlock(keyA, keyB, 100n)
    expect(ok).toBe(true)

    // All 3 nodes should have finalized the same block
    for (const [id, node] of orch.nodes) {
      expect(node.latestBlock, `node ${id} should have finalized`).not.toBeNull()
      expect(node.latestBlock!.header.number).toBe(1n)
    }

    // Assert balances on leader
    const leader = orch.nodes.get(orch.findLeader()!)!
    const acctA = await leader.node.stateMachine.getAccount(keyA)
    const acctB = await leader.node.stateMachine.getAccount(keyB)
    expect(acctA.balance).toBe(900n)
    expect(acctB.balance).toBe(1100n)

    // Checkers
    expect((await orch.check(new NoForkChecker())).passed).toBe(true)
    expect((await orch.check(new BalanceConsistencyChecker([keyA, keyB, keyC]))).passed).toBe(true)
  })
})
