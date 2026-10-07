/**
 * A validator over a durable store + checkpoint resumes from its last
 * committed height after a restart (issue #55), and refuses to resume if the
 * checkpoint and store disagree.
 */

import { describe, it, expect } from 'vitest'
import {
  PersistentStateStore,
  MemoryKVBackend,
  equal,
  blockHash,
  type GenesisConfig,
} from '@johnhenry/raijin-core'
import { kvCheckpointStore } from '@johnhenry/raijin-validator'
import { PartitionableNetwork } from '../src/network/partitionable-network.js'
import { RaijinTestNode } from '../src/nodes/raijin-test-node.js'
import { MockTimer, mockSign, mockVerifier, makeTestKey } from '../src/index.js'

const key = makeTestKey(1)
const funded = makeTestKey(50)
const genesis: GenesisConfig = { chainId: 1n, validators: [key], accounts: [{ address: funded, balance: 1000n }] }

function boot(disk: MemoryKVBackend, cpDisk: MemoryKVBackend, store: PersistentStateStore, withGenesis = true) {
  const net = new PartitionableNetwork()
  return new RaijinTestNode({
    id: 'solo',
    publicKey: key,
    sign: mockSign(key),
    verify: mockVerifier,
    transport: net.createTransport(key),
    timer: new MockTimer(),
    validators: [key],
    genesis: withGenesis ? genesis : undefined,
    store,
    checkpoint: kvCheckpointStore(cpDisk),
  })
}

async function mine(n: RaijinTestNode, nonce: bigint) {
  await n.submitTx(funded, key, 5n, nonce)
  expect(await n.proposeBlock()).not.toBeNull()
  for (let i = 0; i < 50 && (n.latestBlock?.header.number ?? 0n) < nonce + 1n; i++) {
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('validator persistence', () => {
  it('resumes at its last committed block after a restart and keeps building on it', async () => {
    const disk = new MemoryKVBackend()
    const cpDisk = new MemoryKVBackend()

    const first = boot(disk, cpDisk, await PersistentStateStore.open(disk))
    await first.node.ready()
    first.start()
    await Promise.resolve()
    await mine(first, 0n)
    await mine(first, 1n)
    expect(first.latestBlock!.header.number).toBe(2n)
    const tip = await blockHash(first.latestBlock!)
    const root = await first.store.root()
    first.stop()

    // "Process restart": brand-new objects over the same durable media.
    const second = boot(disk, cpDisk, await PersistentStateStore.open(disk))
    await second.node.ready()
    expect(second.latestBlock!.header.number).toBe(2n)
    expect(equal(await blockHash(second.latestBlock!), tip)).toBe(true)
    expect(equal(await second.store.root(), root)).toBe(true)
    expect((await second.node.stateMachine.getAccount(funded)).nonce).toBe(2n)

    second.start()
    await Promise.resolve()
    await mine(second, 2n)
    expect(second.latestBlock!.header.number).toBe(3n)
    expect(equal(second.latestBlock!.header.parentHash, tip)).toBe(true) // linked, not restarted from genesis
  })

  it('without a checkpoint the restarted node would restart from genesis numbering (control)', async () => {
    const disk = new MemoryKVBackend()
    const cpDisk = new MemoryKVBackend()
    const first = boot(disk, cpDisk, await PersistentStateStore.open(disk))
    await first.node.ready(); first.start(); await Promise.resolve()
    await mine(first, 0n)
    first.stop()
    const fresh = boot(disk, new MemoryKVBackend() /* empty checkpoint */, await PersistentStateStore.open(disk))
    await fresh.node.ready()
    expect(fresh.latestBlock).toBeNull()
  })

  it('refuses a checkpoint that disagrees with the state store', async () => {
    const disk = new MemoryKVBackend()
    const cpDisk = new MemoryKVBackend()
    const first = boot(disk, cpDisk, await PersistentStateStore.open(disk))
    await first.node.ready(); first.start(); await Promise.resolve()
    await mine(first, 0n)
    first.stop()

    // Store from a different history (here: genesis only) + this checkpoint.
    const other = new MemoryKVBackend()
    const mismatched = boot(other, cpDisk, await PersistentStateStore.open(other))
    await expect(mismatched.node.ready()).rejects.toThrow(/checkpoint/)
  })

  it('works without genesis (legacy mode) too', async () => {
    const disk = new MemoryKVBackend()
    const cpDisk = new MemoryKVBackend()
    const s1 = await PersistentStateStore.open(disk)
    const first = boot(disk, cpDisk, s1, false)
    await first.node.ready(); first.start(); await Promise.resolve()
    await first.fund(funded, 1000n)
    await mine(first, 0n)
    first.stop()
    const second = boot(disk, cpDisk, await PersistentStateStore.open(disk), false)
    await second.node.ready()
    expect(second.latestBlock!.header.number).toBe(1n)
  })
})
