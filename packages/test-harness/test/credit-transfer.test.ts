/**
 * Credit transfer tests: transfers under normal and partitioned conditions.
 */

import { describe, it, expect } from 'vitest'
import { TestOrchestrator } from '../src/orchestrator.js'
import { CreditTransferWorkload } from '../src/workloads/credit-transfer.js'
import { NoForkChecker } from '../src/checkers/no-fork.js'
import { BalanceConsistencyChecker } from '../src/checkers/balance-consistency.js'

describe('Credit transfer workload', () => {
  it('runs 10 transfers across 3 nodes', async () => {
    const orch = new TestOrchestrator()
    orch.addNode('a')
    orch.addNode('b')
    orch.addNode('c')
    orch.startAll()

    const keys = ['a', 'b', 'c'].map(id => orch.getKey(id))
    for (const k of keys) await orch.fundAccount(k, 100000n)

    const workload = new CreditTransferWorkload({
      transfers: 10,
      txPerBlock: 3,
      amount: 1n,
      seed: 42,
    })
    const result = await workload.run(orch)

    expect(result.txSubmitted).toBe(10)
    expect(result.blocksProduced).toBeGreaterThan(0)
    expect(result.errors).toHaveLength(0)

    // Balance consistency
    const balCheck = await orch.check(new BalanceConsistencyChecker(keys))
    expect(balCheck.passed).toBe(true)

    // No fork
    expect((await orch.check(new NoForkChecker())).passed).toBe(true)
  })

  it('preserves balance consistency with a 1-node partition (still has quorum)', async () => {
    const orch = new TestOrchestrator()
    orch.addNode('a')
    orch.addNode('b')
    orch.addNode('c')
    orch.addNode('d')
    orch.startAll()

    const keys = ['a', 'b', 'c', 'd'].map(id => orch.getKey(id))
    for (const k of keys) await orch.fundAccount(k, 100000n)

    // Produce 2 blocks normally
    expect(await orch.produceBlock(keys[0], keys[1], 100n)).toBe(true)
    expect(await orch.produceBlock(keys[1], keys[2], 50n)).toBe(true)

    // Partition node d (quorum = 3, still reachable with a,b,c)
    orch.partition(['d'], ['a', 'b', 'c'])

    // Run transfers with only 3 connected nodes
    const workload = new CreditTransferWorkload({
      transfers: 6,
      txPerBlock: 2,
      amount: 1n,
      seed: 99,
    })
    const result = await workload.run(orch)
    expect(result.blocksProduced).toBeGreaterThan(0)

    // Balance consistency on the 3 connected nodes (exclude partitioned node d)
    const connectedKeys = ['a', 'b', 'c'].map(id => orch.getKey(id))
    const connectedNodes = new Map(
      ['a', 'b', 'c'].map(id => [id, orch.nodes.get(id)!] as const)
    )
    const balCheck = await new BalanceConsistencyChecker(connectedKeys).check(connectedNodes)
    expect(balCheck.passed).toBe(true)

    // No fork
    expect((await orch.check(new NoForkChecker())).passed).toBe(true)
  })
})
