/**
 * The whole network moves BYTES only (PartitionableNetwork queues Uint8Arrays;
 * objects are encoded on send and decoded on receive via `codecTransport`).
 * Four validators must still reach consensus and finalize a gossiped tx --
 * i.e. nothing in the stack relies on object identity, shared references, or
 * a JSON round trip, which `bigint`/`Uint8Array` would not survive.
 */

import { describe, it, expect } from 'vitest'
import { toHex } from '@johnhenry/raijin-core'
import { TestOrchestrator } from '../src/orchestrator.js'
import { NoForkChecker } from '../src/checkers/no-fork.js'

async function cluster() {
  const orch = new TestOrchestrator()
  for (const id of ['a', 'b', 'c', 'd']) orch.addNode(id)
  orch.startAll()
  const sender = orch.getKey('a')
  await orch.fundAccount(sender, 1000n)
  const leaderId = orch.findLeader()!
  const follower = [...orch.nodes.keys()].find((id) => id !== leaderId)!
  return { orch, sender, leaderId, follower }
}

describe('4 validators over a bytes-only transport', () => {
  it('finalizes a tx gossiped from a follower; every consensus phase crossed the wire as bytes', async () => {
    const { orch, sender, leaderId, follower } = await cluster()

    await orch.nodes.get(follower)!.submitTx(sender, orch.getKey('b'), 10n, 0n)
    await orch.drainFully()
    const leader = orch.nodes.get(leaderId)!
    expect(leader.node.mempool.size).toBe(1) // arrived as a decoded tx-gossip message

    expect(await leader.proposeBlock()).not.toBeNull()
    await orch.drainFully()

    for (const [id, node] of orch.nodes) {
      expect(node.latestBlock, `${id} finalized`).not.toBeNull()
      expect(node.latestBlock!.transactions).toHaveLength(1)
      expect(toHex(node.latestBlock!.transactions[0].from)).toBe(toHex(sender))
      expect(node.latestBlock!.transactions[0].value).toBe(10n)
    }
    const roots = new Set<string>()
    for (const [, node] of orch.nodes) roots.add(toHex(await node.store.root()))
    expect(roots.size).toBe(1)
    expect((await orch.check(new NoForkChecker())).passed).toBe(true)

    expect(orch.network.bytesEnqueued).toBeGreaterThan(0)
    const types = new Set(orch.network.deliveryLog.map((d) => d.type))
    for (const t of ['tx-gossip', 'pre-prepare', 'prepare', 'commit'] as const) expect(types.has(t), t).toBe(true)
    expect(types.has('undecodable' as never)).toBe(false)
  })

  it('garbage and hostile payloads are dropped without disturbing consensus', async () => {
    const { orch, sender, leaderId, follower } = await cluster()
    const attacker = orch.getKey(follower)
    const victim = orch.getKey(leaderId)
    const junk = [
      new Uint8Array(0),
      new Uint8Array([1]),
      new Uint8Array([0xff, 0xff, 0xff]),
      new TextEncoder().encode('{"type":"commit","view":"0"}'), // JSON is not the wire format
      new Uint8Array([1, 0x09, 0xff, 0xff, 0xff, 0xff]),
    ]
    for (const j of junk) orch.network.injectRaw(attacker, victim, j)
    await orch.drainFully()

    await orch.nodes.get(follower)!.submitTx(sender, orch.getKey('b'), 1n, 0n)
    await orch.drainFully()
    const leader = orch.nodes.get(leaderId)!
    expect(await leader.proposeBlock()).not.toBeNull()
    await orch.drainFully()
    for (const [id, node] of orch.nodes) expect(node.latestBlock, id).not.toBeNull()
  })
})
