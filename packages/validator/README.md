# @johnhenry/raijin-validator

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Fraijin-validator.svg)](https://www.npmjs.com/package/@johnhenry/raijin-validator)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Fraijin-validator.svg)](../../LICENSE)

Composition root wiring core, consensus, and mempool into a runnable validator node for the [Raijin](https://github.com/johnhenry/raijin) mesh rollup — a browser-native rollup framework where the users ARE the validators.

`ValidatorNode` assembles a `StateMachine`, a `PBFTConsensus` engine, the fee-ordered `Mempool` from `@johnhenry/raijin-mempool`, and a `BlockProducer`, then runs the loop: accept transactions → (if leader) build a block on the block timer → propose → finalize → apply state → prune mempool. You inject identity (keys + sign/verify), a network transport, a timer, and a state store — the node is transport-, storage-, and identity-agnostic.

## Contents

- [Install](#install)
- [Traps first](#traps-first)
- [Quick start — a one-validator chain](#quick-start-a-one-validator-chain)
- [API](#api)
- [Running more than one node](#running-more-than-one-node)
- [Provenance](#provenance)
- [License](#license)

## Install

```bash
npm install @johnhenry/raijin-validator
```

## Traps first

- **`chainId` is required and has no default.** It is signed into every consensus vote; a default would be an id shared by every deployment that never chose one, letting votes replay between them. Give two different deployments two different ids.
- **`Mempool` is re-exported from `@johnhenry/raijin-mempool`.** This package used to ship its own simpler FIFO class of the same name; it no longer does. `ValidatorNode` wires the real one: fee-ordered, sender+nonce deduplicated, signature-verified against the same `SignatureVerifier` the state machine uses, and evicting the lowest-fee transaction when full rather than throwing. `import { Mempool } from '@johnhenry/raijin-validator'` still works and now gives you that pool.
- **`submitTransaction()` rejects rather than accepts-and-reverts.** An invalid signature, a duplicate sender+nonce, or a full pool with nothing cheaper to evict all make it **throw**, before the transaction ever occupies block space. A bad *nonce* is still only caught at execution, as a `revert` receipt — the mempool deduplicates nonces but does not know the account's current one.
- **`validators` must include this node's own public key**, or `isLeader` is never true and (with `n = 1`) nothing ever finalizes. All nodes must pass the same keys in the same order.
- **Block headers commit to transactions *and* to state.** `BlockProducer` fills `txRoot` up front and leaves `stateRoot`/`receiptRoot` zeroed in the proposal, because neither can be known before the block runs — the consensus digest is taken over that pre-execution header. PBFT then fills in the real `stateRoot` and `receiptRoot` after applying the block, and `advance()` hashes *that* completed header for the next block's `parentHash`. So the chain link commits to the executed result, while the digest nodes voted on commits to the proposal.
- **`parentHash` is the parent's block hash**, `blockHash(parent)` = `H(encodeBlockHeader(parent.header))` — not the parent's state root, which is what it used to be. It therefore commits to the parent's transactions, proposer, timestamp and roots, so "same height, different history" is detectable from headers alone.
- **Quorum is `n - f`, not `2f + 1`.** At `n = 1` quorum is 1 (which is what the single-node quick start below exploits), but at `n = 2` it is 2 and at `n = 3` it is 3 — a single node cannot finalize alone at any validator count. You still get no fault *tolerance* below `n = 4`. See `@johnhenry/raijin-consensus`.

## Quick start — a one-validator chain

```js
import { InMemoryStateStore } from '@johnhenry/raijin-core'
import { ValidatorNode } from '@johnhenry/raijin-validator'

const node = new ValidatorNode({
  chainId: 1n,                             // required — no default
  identity: { publicKey, sign, verify },   // your keys; verify checks tx AND vote signatures
  transport: { broadcast() {}, send() {}, onMessage() {} }, // single node: no peers
  timer: { set: (ms, cb) => setTimeout(cb, ms), clear: clearTimeout },
  store: new InMemoryStateStore(),
  validators: [publicKey],                  // include self!
  blockTime: 2000,
})

node.onBlockFinalized((block, receipts) => console.log('block', block.header.number))
node.start()

const txHashHex = await node.submitTransaction(signedTx)
```

With one validator the node is always leader: the block timer fires, `BlockProducer` drains the mempool, `propose()` runs, and quorum (1) finalizes immediately. A runnable version, including genesis funding, is in [`examples/06-validator-lifecycle.mjs`](https://github.com/johnhenry/raijin/blob/main/examples/06-validator-lifecycle.mjs).

## API

### `ValidatorNode` / `ValidatorNodeConfig`

Config: `chainId` (**required**, `bigint`), `identity` (`{ publicKey, sign, verify }`), `transport` (`NetworkTransport`), `timer` (`ConsensusTimer`), `store` (`StateStore`), plus optional `blockTime` (ms, default 2000), `validators` (default `[]` — see trap above), `maxTxPerBlock` (default 100), `maxMempoolSize` (default 4096), `gossip`, `genesis`, `genesisHash` (below).

**`identity.verify` argument order changed in 0.1.0** to `(publicKey, signature, message)` — see `@johnhenry/raijin-core`.

`identity.verify` is used for two different jobs: the state machine and the mempool check transaction signatures with it, and consensus checks every PRE-PREPARE/PREPARE/COMMIT/VIEW-CHANGE vote with it. A verifier that returns `true` unconditionally therefore disables vote authentication as well as transaction validation.

| Member | Purpose |
| --- | --- |
| `start()` / `stop()` | Start/stop consensus and the block-production timer loop. Idempotent. |
| `submitTransaction(tx): Promise<string>` | Verifies and adds to the mempool; resolves to the tx hash hex (hash of the *signed* encoding). Throws on an invalid signature, a duplicate sender+nonce, or a full pool. |
| `onBlockFinalized(handler)` | `(block, receipts) => void` after every finalized block. |
| `latestBlock` | Most recently finalized `Block`, or `null`. |
| `running` | Boolean. |
| `consensus` / `mempool` / `stateMachine` / `blockProducer` | The wired sub-components, exposed for advanced use (e.g. `node.stateMachine.getAccount(addr)`). |

Block-production errors inside the timer loop are swallowed by design (not being leader or having an empty mempool is normal); drive `node.blockProducer.produceBlock()` manually if you need the error.

#### Transaction gossip (default on)

`gossip?: { enabled?: boolean, fanout?: number, maxHops?: number }` — `submitTransaction` also relays the tx to the other validators over the same `transport` (a `tx-gossip` message; `PBFTConsensus` ignores it), so a client can submit to **any** validator and whichever one leads will include it. Before this, only the node you submitted to knew about the tx.

- **Dedupe:** by signed-tx hash (bounded FIFO seen-set) on top of the mempool's sender+nonce rule, so the relay storm terminates.
- **Hops:** the originator sends at hop 1; a receiver relays (to everyone except the sender) only while `hops < maxHops`. Default `maxHops: 2`.
- **Fanout:** default is `transport.broadcast`; with `fanout: k` each round goes to `k` random other validators via `send` (use with larger `maxHops`).
- **Backpressure:** an inbound tx is dropped before signature verification when the pool is full and it cannot out-bid the lowest-fee pending tx (`Mempool.hasCapacityFor`), when more than 64 verifications are already in flight, or when its nonce is already consumed on-chain. Only txs the mempool actually accepted are relayed. Only validators' gossip is accepted.
- `enabled: false` restores the old local-only behaviour. All nodes need a transport that carries `bigint`/`Uint8Array`: use `codecTransport` (see below).

#### Genesis

`genesis?: GenesisConfig`, `genesisHash?: Uint8Array` (see `@johnhenry/raijin-core`). With `genesis`, every node derives the same block 0 from the config; a fresh store is seeded with the genesis accounts, `validators` come from the config (set one or the other; they must match), `genesis.chainId` must equal `chainId`, and the first block's `parentHash` is the genesis hash. `await node.ready()` (or `await ValidatorNode.create(config)`) surfaces a genesis problem: if `genesisHash` is given and the config does not hash to it the node **refuses to run** (`ready()` rejects, `start()` never starts consensus). A node whose genesis differs from the cluster's (and was not pinned) computes a different block 0, so it ignores the cluster's blocks (parent hash mismatch) and never finalizes anything.

A node can also be started with **only** `genesisHash` (no `genesis`, no `validators`) and call `await node.fetchGenesis({ timeoutMs })`: it asks peers (`genesis-request`/`genesis-response` over the transport) and adopts the first response that hashes to the expected hash; others are ignored, and it rejects on timeout. **Trust model:** the hash (or the config) must be obtained out of band — a config file, release notes, an operator you trust. A peer cannot vouch for the genesis it serves, so there is no trustless bootstrap; fetching only saves you from distributing the full validator list and initial state, it does not remove the need to know the hash. Without `genesis` the node behaves as before (no block 0, first parent hash all zeros); all nodes of a chain must use the same mode.

### `BlockProducer` / `BlockProducerConfig`

Config: `proposer` (pubkey), `consensus`, `mempool`, optional `maxTxPerBlock` (default 100).

- `produceBlock(): Promise<Block | null>` — returns `null` when not leader or mempool empty; otherwise builds a block (Merkle `txRoot` over signed-tx hashes) and calls `consensus.propose()`.
- `advance(block): Promise<void>` — called after finalization to bump `nextBlockNumber` and set the next `parentHash` to `await blockHash(block)`. **Async** — it hashes the parent header, so callers must `await` it.
- `nextBlockNumber: bigint` — getter.

### `Mempool` (re-exported)

`export { Mempool } from '@johnhenry/raijin-mempool'` — a convenience re-export, not a separate implementation. See that package's README for the full API (`submit`, `pendingForProposer`, `removeBatch`, the fee convention and the eviction rule). `ValidatorNode` constructs it with `maxSize: maxMempoolSize` and a verifier built from `identity.verify`.

## Running more than one node

Everything above scales to a real mesh, but four things change:

1. **The transport becomes real.** Every node's `transport.broadcast`/`send` must reach every other validator, and `onMessage` reports the sender's public key as `from`. Consensus no longer *trusts* that value — every vote's signature is verified against it, so a transport that lies about `from` produces messages that fail verification and are dropped. What the transport still owes you is delivery: nothing here retries or reorders, so a lossy transport costs liveness, not safety. Consensus, `tx-gossip` and genesis messages carry `bigint`s and `Uint8Array`s, so they cannot be JSON'd. Implement the byte-level `BytesTransport` and wrap it with `codecTransport` from `@johnhenry/raijin-consensus`, which uses the canonical wire codec in `@johnhenry/raijin-core` (no hand-rolled replacer/reviver needed).
2. **`validators` must be byte-identical on every node** — same keys, same order. Leader election is positional (`view % n`), so a different ordering means nodes disagree about who may propose and nothing ever finalizes, with no error to tell you why.
3. **Quorum math starts to matter.** Quorum is `n - f` with `f = floor((n - 1) / 3)`: at n = 4 you tolerate one faulty node (quorum 3), at n = 3 quorum is 3 and you tolerate none. Pick n = 3f + 1 for the f you actually need — that is where `n - f` is also the minimum, `2f + 1`.

4. **Every node needs the same `chainId`**, and two different deployments need two different ones. That is what stops one network's votes being counted by the other.

Multi-node scenarios — leader crashes, partitions, membership churn — are exercised by the repo's internal `raijin-test-harness` package (`TestOrchestrator` + `PartitionableNetwork` + invariant checkers) rather than examples, because they're timing-sensitive by nature. Read the harness tests for working multi-node wiring.

## Persistence and restarts

`checkpoint?: CheckpointStore` (`{ load(): Promise<Uint8Array | null>; save(record): Promise<void> }`) makes a restarted validator resume from its last committed block instead of genesis. Pair it with a durable `store` (`PersistentStateStore` from `@johnhenry/raijin-core`):

```ts
const store = await PersistentStateStore.open(new IndexedDbKVBackend({ name: 'chain-state' }))
const checkpoint = kvCheckpointStore(new IndexedDbKVBackend({ name: 'chain-checkpoint' }))
const node = await ValidatorNode.create({ ..., store, checkpoint })
```

- On every finalized block the node saves `{ latestBlock, view }` (wire-codec encoded). On start (during `ready()`) it loads it, checks the block's `stateRoot` equals the store's root, and resumes block numbering, parent-hash linkage and consensus's chain tip from it.
- Use a **separate** storage location from the state store; a shared key space would put the record inside the state root.
- Ordering: transactions reach the state store before the checkpoint is written, so after a crash the store can be one block ahead of the checkpoint. A mismatch makes `ready()` reject with a clear error rather than guess; recover with `syncFrom`/`importSyncState` from a peer. A failed `save` does not halt finalization; see `node.checkpointError`.
- The consensus *view* is recorded but not re-adopted (a view needs its signed justification); a restarted node rejoins the current view through the normal protocol or `importSyncState`.
- `importSyncState` awaits `store.flush()` when the store has one, so synced state is durable before the node continues.

## Provenance

Previously published unscoped as [`raijin-validator`](https://www.npmjs.com/package/raijin-validator): `0.0.1` (initial release, 2026-03-15), then `0.0.2` (2026-07-16 — published with a broken build, because the release workflow used plain `npm publish`, which does not rewrite `workspace:*` internal dependency specifiers into real resolved versions; that tarball was unpublished), then `0.0.3` (2026-07-16, same day — republished correctly via `pnpm publish`, the last unscoped version, live until this move).

Moved into the `@johnhenry` npm scope and restarted at `0.0.0` — no functional changes in the move. The `workspace:*` publish bug can no longer recur: the monorepo has since converted to npm workspaces with real semver ranges, and releases go out via `npm publish --workspaces`. See the [root CHANGELOG](https://github.com/johnhenry/raijin/blob/main/CHANGELOG.md) for the full project history.

## License

MIT
