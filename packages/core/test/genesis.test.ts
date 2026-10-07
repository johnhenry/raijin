import { describe, it, expect } from 'vitest'
import {
  createGenesisBlock,
  genesisHash,
  applyGenesisState,
  assertGenesisMatches,
  InMemoryStateStore,
  blockHash,
  equal,
  type GenesisConfig,
} from '../src/index.js'

const key = (n: number) => { const k = new Uint8Array(32); k[0] = n; return k }

function config(over: Partial<GenesisConfig> = {}): GenesisConfig {
  return {
    chainId: 7n,
    validators: [key(1), key(2), key(3), key(4)],
    accounts: [{ address: key(9), balance: 1000n }],
    ...over,
  }
}

describe('genesis', () => {
  it('derives an identical block 0 from identical config (key order of accounts irrelevant)', async () => {
    const a = await createGenesisBlock(config())
    const b = await createGenesisBlock(config({ accounts: [{ address: key(9), balance: 1000n }] }))
    expect(a.header.number).toBe(0n)
    expect(equal(a.header.parentHash, new Uint8Array(32))).toBe(true)
    expect(equal(await blockHash(a), await blockHash(b))).toBe(true)
    expect(equal(await genesisHash(config()), await blockHash(a))).toBe(true)
  })

  it('account order does not change the hash', async () => {
    const accounts = [{ address: key(9), balance: 1n }, { address: key(8), balance: 2n }]
    const h1 = await genesisHash(config({ accounts }))
    const h2 = await genesisHash(config({ accounts: [...accounts].reverse() }))
    expect(equal(h1, h2)).toBe(true)
  })

  it.each([
    ['chainId', { chainId: 8n }],
    ['validator set', { validators: [key(1), key(2), key(3), key(5)] }],
    ['validator order', { validators: [key(2), key(1), key(3), key(4)] }],
    ['initial state', { accounts: [{ address: key(9), balance: 1001n }] }],
    ['timestamp', { timestamp: 5 }],
  ])('a different %s yields a different genesis hash', async (_n, over) => {
    expect(equal(await genesisHash(config()), await genesisHash(config(over as Partial<GenesisConfig>)))).toBe(false)
  })

  it('applyGenesisState writes the accounts so the store root equals block 0 stateRoot', async () => {
    const store = new InMemoryStateStore()
    await applyGenesisState(store, config())
    const block = await createGenesisBlock(config())
    expect(equal(await store.root(), block.header.stateRoot)).toBe(true)
  })

  it('assertGenesisMatches accepts the right hash and rejects another', async () => {
    const h = await genesisHash(config())
    await expect(assertGenesisMatches(config(), h)).resolves.toBeUndefined()
    await expect(assertGenesisMatches(config({ chainId: 8n }), h)).rejects.toThrow(/genesis/i)
  })

  it('rejects an empty validator set', async () => {
    await expect(createGenesisBlock(config({ validators: [] }))).rejects.toThrow()
  })
})
