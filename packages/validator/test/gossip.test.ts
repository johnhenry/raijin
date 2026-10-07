import { describe, it, expect } from 'vitest'
import {
  InMemoryStateStore,
  TransactionType,
  accountKey,
  encodeAccount,
  type Transaction,
  type SignatureVerifier,
} from '@johnhenry/raijin-core'
import type { NetworkTransport, ConsensusMessage, ConsensusTimer } from '@johnhenry/raijin-consensus'
import { ValidatorNode, type GossipConfig } from '../src/validator.js'

const ok: SignatureVerifier = { async verify() { return true } }
const key = (n: number) => { const k = new Uint8Array(32); k[0] = n; return k }
const [a, b, c, d] = [1, 2, 3, 4].map(key)
const outsider = key(99)
const sender = key(50)

const timer: ConsensusTimer = { set: () => 0, clear: () => {} }

class SpyTransport implements NetworkTransport {
  broadcasts: ConsensusMessage[] = []
  sends: { to: Uint8Array; msg: ConsensusMessage }[] = []
  handler: ((from: Uint8Array, msg: ConsensusMessage) => void | Promise<void>) | null = null
  broadcast(m: ConsensusMessage) { this.broadcasts.push(m) }
  send(to: Uint8Array, msg: ConsensusMessage) { this.sends.push({ to, msg }) }
  onMessage(h: (from: Uint8Array, msg: ConsensusMessage) => void) { this.handler = h }
}

function tx(nonce: bigint, fee = 1n, from = sender): Transaction {
  const data = new Uint8Array(9)
  data[0] = TransactionType.Transfer
  new DataView(data.buffer).setBigUint64(1, fee)
  return { from, to: b, value: 1n, nonce, data, signature: new Uint8Array(64), chainId: 1n }
}

async function make(gossip?: GossipConfig, maxMempoolSize?: number) {
  const transport = new SpyTransport()
  const store = new InMemoryStateStore()
  await store.put(accountKey(sender), encodeAccount({ balance: 1000n, nonce: 0n, reputation: 0n }))
  const node = new ValidatorNode({
    chainId: 1n,
    identity: { publicKey: a, sign: async () => a, verify: ok },
    transport, timer, store,
    validators: [a, b, c, d],
    gossip, maxMempoolSize,
  })
  node.start()
  return { node, transport }
}

const gossipOf = (m: ConsensusMessage) => m as Extract<ConsensusMessage, { type: 'tx-gossip' }>

describe('ValidatorNode tx gossip', () => {
  it('local submit broadcasts once at hop 1', async () => {
    const { node, transport } = await make()
    await node.submitTransaction(tx(0n))
    expect(transport.broadcasts.filter((m) => m.type === 'tx-gossip')).toHaveLength(1)
    expect(gossipOf(transport.broadcasts[0]).hops).toBe(1)
  })

  it('a rejected submit (duplicate) is not re-gossiped', async () => {
    const { node, transport } = await make()
    await node.submitTransaction(tx(0n))
    await expect(node.submitTransaction(tx(0n))).rejects.toThrow()
    expect(transport.broadcasts).toHaveLength(1)
  })

  it('enabled: false -> nothing is sent and inbound gossip is ignored', async () => {
    const { node, transport } = await make({ enabled: false })
    await node.submitTransaction(tx(0n))
    expect(transport.broadcasts).toHaveLength(0)
    await transport.handler!(b, { type: 'tx-gossip', tx: tx(1n), hops: 1 })
    expect(node.mempool.size).toBe(1)
  })

  it('fanout: N sends to distinct peers (never self) instead of a broadcast', async () => {
    const { node, transport } = await make({ fanout: 2 })
    await node.submitTransaction(tx(0n))
    expect(transport.broadcasts).toHaveLength(0)
    expect(transport.sends).toHaveLength(2)
    const targets = new Set(transport.sends.map((s) => s.to[0]))
    expect(targets.size).toBe(2)
    expect(targets.has(a[0])).toBe(false)
  })

  it('receive: admits, relays once (hops+1) excluding the sender, and dedupes a repeat', async () => {
    const { node, transport } = await make()
    await transport.handler!(b, { type: 'tx-gossip', tx: tx(0n), hops: 1 })
    expect(node.mempool.size).toBe(1)
    expect(transport.sends.map((s) => s.to[0]).sort()).toEqual([c[0], d[0]])
    expect(transport.sends.every((s) => gossipOf(s.msg).hops === 2)).toBe(true)
    const before = transport.sends.length
    await transport.handler!(c, { type: 'tx-gossip', tx: tx(0n), hops: 1 })
    expect(transport.sends.length).toBe(before)
  })

  it('does not relay once hops reaches maxHops', async () => {
    const { node, transport } = await make({ maxHops: 2 })
    await transport.handler!(b, { type: 'tx-gossip', tx: tx(0n), hops: 2 })
    expect(node.mempool.size).toBe(1)
    expect(transport.sends).toHaveLength(0)
  })

  it('ignores gossip from a non-validator and malformed hop counts', async () => {
    const { node, transport } = await make()
    await transport.handler!(outsider, { type: 'tx-gossip', tx: tx(0n), hops: 1 })
    await transport.handler!(b, { type: 'tx-gossip', tx: tx(1n), hops: 0 })
    await transport.handler!(b, { type: 'tx-gossip', tx: tx(2n), hops: 1.5 })
    expect(node.mempool.size).toBe(0)
  })

  it('does not admit a tx whose nonce the chain has already consumed', async () => {
    const { node, transport } = await make()
    await node.store.put(accountKey(sender), encodeAccount({ balance: 1000n, nonce: 5n, reputation: 0n }))
    await transport.handler!(b, { type: 'tx-gossip', tx: tx(2n), hops: 1 })
    expect(node.mempool.size).toBe(0)
  })

  it('backpressure: when the pool is full, a lower-or-equal fee tx is dropped and not relayed; a higher fee displaces', async () => {
    const { node, transport } = await make(undefined, 2)
    await transport.handler!(b, { type: 'tx-gossip', tx: tx(0n, 10n), hops: 1 })
    await transport.handler!(b, { type: 'tx-gossip', tx: tx(1n, 20n), hops: 1 })
    expect(node.mempool.size).toBe(2)
    const sends = transport.sends.length
    await transport.handler!(b, { type: 'tx-gossip', tx: tx(2n, 5n), hops: 1 })
    expect(node.mempool.size).toBe(2)
    expect(transport.sends.length).toBe(sends)
    await transport.handler!(b, { type: 'tx-gossip', tx: tx(3n, 99n), hops: 1 })
    expect(node.mempool.pending().map((t) => t.nonce).sort()).toEqual([1n, 3n])
    expect(transport.sends.length).toBeGreaterThan(sends)
  })

  it('rejects invalid gossip config', async () => {
    await expect(make({ fanout: 0 })).rejects.toThrow(/fanout/)
    await expect(make({ maxHops: 0 })).rejects.toThrow(/maxHops/)
  })
})
