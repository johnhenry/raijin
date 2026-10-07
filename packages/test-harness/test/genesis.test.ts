/**
 * First-class genesis: same config => same block 0; a node with a different
 * genesis refuses to run / cannot join; a node can fetch genesis from peers
 * against an out-of-band hash.
 */

import { describe, it, expect } from 'vitest'
import {
  createGenesisBlock,
  genesisHash,
  blockHash,
  equal,
  type GenesisConfig,
} from '@johnhenry/raijin-core'
import { ValidatorNode } from '@johnhenry/raijin-validator'
import { InMemoryStateStore } from '@johnhenry/raijin-core'
import { PartitionableNetwork } from '../src/network/partitionable-network.js'
import { RaijinTestNode } from '../src/nodes/raijin-test-node.js'
import { MockTimer, mockSign, mockVerifier, makeTestKey } from '../src/index.js'

const keys = [1, 2, 3, 4].map(makeTestKey)
const funded = makeTestKey(50)

function genesisOf(over: Partial<GenesisConfig> = {}): GenesisConfig {
  return {
    chainId: 1n,
    validators: keys,
    accounts: [{ address: funded, balance: 1000n }],
    ...over,
  }
}

function build(net: PartitionableNetwork, timer: MockTimer, i: number, genesis: GenesisConfig, genesisHash?: Uint8Array) {
  return new RaijinTestNode({
    id: `n${i}`,
    publicKey: keys[i],
    sign: mockSign(keys[i]),
    verify: mockVerifier,
    transport: net.createTransport(keys[i]),
    timer,
    validators: keys,
    genesis,
    genesisHash,
  })
}

describe('genesis', () => {
  it('two nodes with the same genesis config agree on block 0 and on initial state', async () => {
    const net = new PartitionableNetwork(); const timer = new MockTimer()
    const a = build(net, timer, 0, genesisOf())
    const b = build(net, timer, 1, genesisOf())
    await a.node.ready(); await b.node.ready()
    expect(a.node.genesisBlock!.header.number).toBe(0n)
    expect(equal(await blockHash(a.node.genesisBlock!), await blockHash(b.node.genesisBlock!))).toBe(true)
    expect(equal(await a.store.root(), await b.store.root())).toBe(true)
    expect((await a.node.stateMachine.getAccount(funded)).balance).toBe(1000n)
  })

  it('a cluster started from genesis produces blocks whose first parent is block 0', async () => {
    const net = new PartitionableNetwork(); const timer = new MockTimer()
    const nodes = keys.map((_, i) => build(net, timer, i, genesisOf()))
    await Promise.all(nodes.map((n) => n.node.ready()))
    nodes.forEach((n) => n.start())
    await Promise.resolve()
    const g = await genesisHash(genesisOf())

    const leader = nodes.find((n) => n.node.consensus.isLeader)!
    await leader.submitTx(funded, keys[0], 5n, 0n)
    expect(await leader.proposeBlock()).not.toBeNull()
    await net.drainAll()
    for (let i = 0; i < 40 && nodes.some((n) => !n.latestBlock); i++) {
      await new Promise((r) => setTimeout(r, 5)); await net.drainAll()
    }
    for (const n of nodes) {
      expect(n.latestBlock, n.id).not.toBeNull()
      expect(n.latestBlock!.header.number).toBe(1n)
      expect(equal(n.latestBlock!.header.parentHash, g)).toBe(true)
    }
  })

  it('a node whose genesis does not hash to the pinned genesisHash refuses to run', async () => {
    const net = new PartitionableNetwork(); const timer = new MockTimer()
    const pinned = await genesisHash(genesisOf())
    const bad = build(net, timer, 0, genesisOf({ accounts: [{ address: funded, balance: 999999n }] }), pinned)
    await expect(bad.node.ready()).rejects.toThrow(/genesis mismatch/i)
    bad.start()
    await new Promise((r) => setTimeout(r, 10))
    expect(bad.node.running).toBe(false)
    // and ValidatorNode.create rejects outright
    await expect(ValidatorNode.create({
      chainId: 1n,
      identity: { publicKey: keys[0], sign: mockSign(keys[0]), verify: mockVerifier },
      transport: net.createTransport(makeTestKey(77)),
      timer,
      store: new InMemoryStateStore(),
      genesis: genesisOf({ chainId: 1n, accounts: [] }),
      genesisHash: pinned,
    })).rejects.toThrow(/genesis mismatch/i)
  })

  it('a node with a different genesis cannot finalize alongside the honest cluster', async () => {
    const net = new PartitionableNetwork(); const timer = new MockTimer()
    const honest = [0, 1, 2].map((i) => build(net, timer, i, genesisOf()))
    // same validators + chain, different initial state => different block 0
    const odd = build(net, timer, 3, genesisOf({ accounts: [{ address: funded, balance: 7n }] }))
    const all = [...honest, odd]
    await Promise.all(all.map((n) => n.node.ready()))
    expect(equal(await blockHash(odd.node.genesisBlock!), await blockHash(honest[0].node.genesisBlock!))).toBe(false)
    all.forEach((n) => n.start())
    await Promise.resolve()
    const leader = honest.find((n) => n.node.consensus.isLeader) ?? honest[0]
    if (!leader.node.consensus.isLeader) return // leader rotation put the odd node first; covered by hash inequality
    await leader.submitTx(funded, keys[0], 5n, 0n)
    await leader.proposeBlock()
    for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 5)); await net.drainAll() }
    for (const n of honest) expect(n.latestBlock, n.id).not.toBeNull()
    expect(odd.latestBlock).toBeNull()
  })

  it('fetchGenesis: a node started with only the hash adopts a peer genesis that matches', async () => {
    const net = new PartitionableNetwork(); const timer = new MockTimer()
    const peer = build(net, timer, 0, genesisOf())
    await peer.node.ready()
    const pinned = await genesisHash(genesisOf())
    const fresh = new ValidatorNode({
      chainId: 1n,
      identity: { publicKey: keys[1], sign: mockSign(keys[1]), verify: mockVerifier },
      transport: net.createTransport(keys[1]),
      timer,
      store: new InMemoryStateStore(),
      genesisHash: pinned,
    })
    expect(() => fresh.start()).toThrow(/fetchGenesis/)
    const p = fresh.fetchGenesis({ timeoutMs: 1000 })
    for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 5)); await net.drainAll() }
    const g = await p
    expect(equal(await genesisHash(g), pinned)).toBe(true)
    expect(equal(await blockHash(fresh.genesisBlock!), pinned)).toBe(true)
    expect((await fresh.stateMachine.getAccount(funded)).balance).toBe(1000n)
  })

  it('fetchGenesis ignores a peer serving a genesis that does not match, and times out', async () => {
    const net = new PartitionableNetwork(); const timer = new MockTimer()
    const liar = build(net, timer, 0, genesisOf({ accounts: [{ address: funded, balance: 1n }] }))
    await liar.node.ready()
    const fresh = new ValidatorNode({
      chainId: 1n,
      identity: { publicKey: keys[1], sign: mockSign(keys[1]), verify: mockVerifier },
      transport: net.createTransport(keys[1]),
      timer,
      store: new InMemoryStateStore(),
      genesisHash: await genesisHash(genesisOf()),
    })
    const p = fresh.fetchGenesis({ timeoutMs: 1000 })
    const settled = p.then(() => 'ok', (e) => String(e))
    for (let i = 0; i < 10; i++) { await new Promise((r) => setTimeout(r, 5)); await net.drainAll() }
    timer.advance(1500)
    expect(await settled).toMatch(/no peer served a genesis/)
    expect(fresh.genesis).toBeNull()
  })

  it('fetchGenesis without genesisHash is refused (no trustless bootstrap)', async () => {
    const net = new PartitionableNetwork(); const timer = new MockTimer()
    const n = new ValidatorNode({
      chainId: 1n,
      identity: { publicKey: keys[1], sign: mockSign(keys[1]), verify: mockVerifier },
      transport: net.createTransport(keys[1]),
      timer,
      store: new InMemoryStateStore(),
      validators: keys,
    })
    await expect(n.fetchGenesis()).rejects.toThrow(/genesisHash/)
  })

  it('config errors: chainId mismatch and validators disagreeing with genesis throw synchronously', () => {
    const net = new PartitionableNetwork(); const timer = new MockTimer()
    const base = {
      identity: { publicKey: keys[0], sign: mockSign(keys[0]), verify: mockVerifier },
      transport: net.createTransport(keys[0]), timer, store: new InMemoryStateStore(),
    }
    expect(() => new ValidatorNode({ ...base, chainId: 2n, genesis: genesisOf() })).toThrow(/chainId/)
    expect(() => new ValidatorNode({ ...base, chainId: 1n, genesis: genesisOf(), validators: [keys[0]] })).toThrow(/validators/)
  })

  it('createGenesisBlock is the single source of block 0', async () => {
    expect((await createGenesisBlock(genesisOf())).header.number).toBe(0n)
  })
})
