/**
 * Transaction gossip: a tx submitted to ONE validator reaches the leader's
 * mempool and is included in a block the leader produces.
 */

import { describe, it, expect } from 'vitest'
import { toHex } from '@johnhenry/raijin-core'
import { TestOrchestrator } from '../src/orchestrator.js'
import { NoForkChecker } from '../src/checkers/no-fork.js'

async function cluster(gossip?: { enabled?: boolean; fanout?: number; maxHops?: number }) {
  const orch = new TestOrchestrator({ gossip })
  for (const id of ['a', 'b', 'c', 'd']) orch.addNode(id)
  orch.startAll()
  const sender = orch.getKey('a')
  await orch.fundAccount(sender, 1000n)
  const leaderId = orch.findLeader()!
  const follower = [...orch.nodes.keys()].find((id) => id !== leaderId)!
  return { orch, sender, leaderId, follower }
}

describe('Mempool gossip (issue #57)', () => {
  it('a tx submitted to a follower is included in a block proposed by the leader', async () => {
    const { orch, sender, leaderId, follower } = await cluster()
    const txHash = await orch.nodes.get(follower)!.submitTx(sender, orch.getKey('b'), 10n, 0n)
    await orch.drainFully()

    // The leader never saw a local submit, yet has the tx.
    const leader = orch.nodes.get(leaderId)!
    expect(leader.node.mempool.size).toBe(1)

    const block = await leader.proposeBlock()
    expect(block).not.toBeNull()
    await orch.drainFully()

    for (const [id, node] of orch.nodes) {
      expect(node.latestBlock, `${id} finalized`).not.toBeNull()
      expect(node.latestBlock!.transactions).toHaveLength(1)
      expect(toHex(node.latestBlock!.transactions[0].from)).toBe(toHex(sender))
      // included txs are pruned everywhere
      expect(node.node.mempool.size).toBe(0)
    }
    expect(txHash).toMatch(/^[0-9a-f]{64}$/)
    expect((await orch.check(new NoForkChecker())).passed).toBe(true)
  })

  it('control: with gossip disabled the leader never learns of it', async () => {
    const { orch, sender, leaderId, follower } = await cluster({ enabled: false })
    await orch.nodes.get(follower)!.submitTx(sender, orch.getKey('b'), 10n, 0n)
    await orch.drainFully()
    const leader = orch.nodes.get(leaderId)!
    expect(leader.node.mempool.size).toBe(0)
    expect(await leader.proposeBlock()).toBeNull()
  })

  it('dedupes: a tx is admitted once per node and the gossip storm terminates', async () => {
    const { orch, sender, follower } = await cluster()
    await orch.nodes.get(follower)!.submitTx(sender, orch.getKey('b'), 10n, 0n)
    const delivered = await orch.drainFully()
    for (const [, node] of orch.nodes) expect(node.node.mempool.size).toBe(1)
    // 1 origin broadcast (3) + each of 3 receivers relays to 2 others (6) = 9, bounded
    expect(delivered).toBeLessThanOrEqual(9)
    expect(await orch.drainFully()).toBe(0)
  })

  it('maxHops: 1 means receivers do not relay (origin broadcast only)', async () => {
    const { orch, sender, follower } = await cluster({ maxHops: 1 })
    await orch.nodes.get(follower)!.submitTx(sender, orch.getKey('b'), 10n, 0n)
    const delivered = await orch.drainFully()
    expect(delivered).toBe(3)
    for (const [, node] of orch.nodes) expect(node.node.mempool.size).toBe(1)
  })

  it('after finalization the included tx is gone from every mempool and the account nonce advanced', async () => {
    const { orch, sender, leaderId } = await cluster()
    const leader = orch.nodes.get(leaderId)!
    await leader.submitTx(sender, orch.getKey('b'), 1n, 0n)
    await orch.drainFully()
    await leader.proposeBlock()
    await orch.drainFully()
    const nonceOnChain = (await leader.node.stateMachine.getAccount(sender)).nonce
    expect(nonceOnChain).toBe(1n)
    for (const [, node] of orch.nodes) expect(node.node.mempool.size).toBe(0)
  })
})
