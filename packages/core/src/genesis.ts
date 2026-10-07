/**
 * Genesis — the deterministic block 0 every node of a chain must agree on.
 *
 * A `GenesisConfig` is plain data. Every node derives the SAME block 0 from
 * it, so two nodes started from equal configs agree on `genesisHash`, and a
 * node started from a different config computes a different hash and can be
 * told apart before it ever votes.
 *
 * Trust model: genesis is NOT discovered trustlessly. A node must be told
 * the genesis config, or at minimum the expected genesis hash, out of band
 * (a config file, a release note, a trusted operator). Anything fetched from
 * a peer is only accepted if it hashes to that out-of-band value.
 */

import type { Block, StateStore } from './types.js'
import { InMemoryStateStore } from './state.js'
import { accountKey } from './state-machine.js'
import {
  Domain,
  blockHash,
  encodeAccount,
  encodeBigInt,
  encodeBytes,
} from './encoding.js'
import { hash, merkleRoot, equal, toHex } from './hash.js'
import { RaijinError } from './errors.js'

export interface GenesisAccount {
  address: Uint8Array
  balance: bigint
  /** Default 0n. */
  nonce?: bigint
  /** Default 0n. */
  reputation?: bigint
}

export interface GenesisConfig {
  /** Chain identifier; committed to by the genesis hash. */
  chainId: bigint
  /**
   * Initial validator public keys. ORDER MATTERS (leader rotation follows
   * it) and is committed to by the genesis hash.
   */
  validators: Uint8Array[]
  /** Initial account state (funding). Order-insensitive. */
  accounts?: GenesisAccount[]
  /** Genesis timestamp (ms). Default 0 — never `Date.now()`, which would differ per node. */
  timestamp?: number
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

function validate(config: GenesisConfig): void {
  if (config.validators.length === 0) {
    throw new RaijinError('Genesis requires at least one validator')
  }
  const seen = new Set<string>()
  for (const v of config.validators) {
    const h = toHex(v)
    if (seen.has(h)) throw new RaijinError('Genesis validator set contains a duplicate key')
    seen.add(h)
  }
}

function sortedAccounts(config: GenesisConfig) {
  return [...(config.accounts ?? [])].sort((a, b) => {
    const x = toHex(a.address), y = toHex(b.address)
    return x < y ? -1 : x > y ? 1 : 0
  })
}

/** Genesis-time state root: the root of a fresh store holding only the genesis accounts. */
async function genesisStateRoot(config: GenesisConfig): Promise<Uint8Array> {
  const store = new InMemoryStateStore()
  await applyGenesisState(store, config)
  return store.root()
}

/**
 * Write the genesis accounts into `store`. Call on a fresh store only; it
 * overwrites any existing entry for a genesis address.
 */
export async function applyGenesisState(store: StateStore, config: GenesisConfig): Promise<void> {
  const seen = new Set<string>()
  for (const acct of sortedAccounts(config)) {
    const h = toHex(acct.address)
    if (seen.has(h)) throw new RaijinError('Genesis accounts contain a duplicate address')
    seen.add(h)
    await store.put(accountKey(acct.address), encodeAccount({
      balance: acct.balance,
      nonce: acct.nonce ?? 0n,
      reputation: acct.reputation ?? 0n,
    }))
  }
}

/**
 * Derive block 0. Deterministic: number 0, zero parent, empty receipts,
 * `stateRoot` = root of the genesis accounts, proposer = zero key, and
 * `txRoot` = a commitment to `chainId` + the ordered validator set (block 0
 * has no transactions, so the field is free to carry it). Chain id and
 * validators are therefore inside the block hash.
 */
export async function createGenesisBlock(config: GenesisConfig): Promise<Block> {
  validate(config)
  const commitment = await hash(concat([
    new Uint8Array([Domain.Genesis]),
    encodeBigInt(config.chainId),
    encodeBigInt(BigInt(config.validators.length)),
    ...config.validators.map((v) => encodeBytes(v)),
  ]))
  return {
    header: {
      number: 0n,
      parentHash: new Uint8Array(32),
      stateRoot: await genesisStateRoot(config),
      txRoot: commitment,
      receiptRoot: await merkleRoot([]),
      timestamp: config.timestamp ?? 0,
      proposer: new Uint8Array(32),
    },
    transactions: [],
    signatures: [],
  }
}

/** The canonical hash of block 0 for `config` — the value to distribute out of band. */
export async function genesisHash(config: GenesisConfig): Promise<Uint8Array> {
  return blockHash(await createGenesisBlock(config))
}

/** Throw unless `config` derives exactly `expectedHash`. */
export async function assertGenesisMatches(config: GenesisConfig, expectedHash: Uint8Array): Promise<void> {
  const actual = await genesisHash(config)
  if (!equal(actual, expectedHash)) {
    throw new RaijinError(
      `Genesis mismatch: config hashes to ${toHex(actual)}, expected ${toHex(expectedHash)}`,
    )
  }
}
