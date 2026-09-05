# @johnhenry/raijin-validator

Composition root wiring core, consensus, and mempool into a runnable validator node for the [Raijin](https://github.com/johnhenry/raijin) mesh rollup — a browser-native rollup framework where the users ARE the validators.

`ValidatorNode` assembles a `StateMachine`, a `PBFTConsensus` engine, the fee-ordered `Mempool` from `@johnhenry/raijin-mempool`, and a `BlockProducer`, then runs the loop: accept transactions → (if leader) build a block on the block timer → propose → finalize → apply state → prune mempool. You inject identity (keys + sign/verify), a network transport, a timer, and a state store — the node is transport-, storage-, and identity-agnostic.

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

Config: `chainId` (**required**, `bigint`), `identity` (`{ publicKey, sign, verify }`), `transport` (`NetworkTransport`), `timer` (`ConsensusTimer`), `store` (`StateStore`), plus optional `blockTime` (ms, default 2000), `validators` (default `[]` — see trap above), `maxTxPerBlock` (default 100), `maxMempoolSize` (default 4096).

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

### `BlockProducer` / `BlockProducerConfig`

Config: `proposer` (pubkey), `consensus`, `mempool`, optional `maxTxPerBlock` (default 100).

- `produceBlock(): Promise<Block | null>` — returns `null` when not leader or mempool empty; otherwise builds a block (Merkle `txRoot` over signed-tx hashes) and calls `consensus.propose()`.
- `advance(block): Promise<void>` — called after finalization to bump `nextBlockNumber` and set the next `parentHash` to `await blockHash(block)`. **Async** — it hashes the parent header, so callers must `await` it.
- `nextBlockNumber: bigint` — getter.

### `Mempool` (re-exported)

`export { Mempool } from '@johnhenry/raijin-mempool'` — a convenience re-export, not a separate implementation. See that package's README for the full API (`submit`, `pendingForProposer`, `removeBatch`, the fee convention and the eviction rule). `ValidatorNode` constructs it with `maxSize: maxMempoolSize` and a verifier built from `identity.verify`.

## Running more than one node

Everything above scales to a real mesh, but four things change:

1. **The transport becomes real.** Every node's `transport.broadcast`/`send` must reach every other validator, and `onMessage` reports the sender's public key as `from`. Consensus no longer *trusts* that value — every vote's signature is verified against it, so a transport that lies about `from` produces messages that fail verification and are dropped. What the transport still owes you is delivery: nothing here retries or reorders, so a lossy transport costs liveness, not safety. If your wire format is JSON, consensus messages carry `bigint`s and `Uint8Array`s; you need a replacer/reviver pair (`packages/consensus/test/helpers.ts` has a working one).
2. **`validators` must be byte-identical on every node** — same keys, same order. Leader election is positional (`view % n`), so a different ordering means nodes disagree about who may propose and nothing ever finalizes, with no error to tell you why.
3. **Quorum math starts to matter.** Quorum is `n - f` with `f = floor((n - 1) / 3)`: at n = 4 you tolerate one faulty node (quorum 3), at n = 3 quorum is 3 and you tolerate none. Pick n = 3f + 1 for the f you actually need — that is where `n - f` is also the minimum, `2f + 1`.

4. **Every node needs the same `chainId`**, and two different deployments need two different ones. That is what stops one network's votes being counted by the other.

Multi-node scenarios — leader crashes, partitions, membership churn — are exercised by the repo's internal `raijin-test-harness` package (`TestOrchestrator` + `PartitionableNetwork` + invariant checkers) rather than examples, because they're timing-sensitive by nature. Read the harness tests for working multi-node wiring.

## Provenance

Previously published unscoped as [`raijin-validator`](https://www.npmjs.com/package/raijin-validator): `0.0.1` (initial release, 2026-03-15), then `0.0.2` (2026-07-16 — published with a broken build, because the release workflow used plain `npm publish`, which does not rewrite `workspace:*` internal dependency specifiers into real resolved versions; that tarball was unpublished), then `0.0.3` (2026-07-16, same day — republished correctly via `pnpm publish`, the last unscoped version, live until this move).

Moved into the `@johnhenry` npm scope and restarted at `0.0.0` — no functional changes in the move. The `workspace:*` publish bug can no longer recur: the monorepo has since converted to npm workspaces with real semver ranges, and releases go out via `npm publish --workspaces`. See the [root CHANGELOG](https://github.com/johnhenry/raijin/blob/main/CHANGELOG.md) for the full project history.

## License

MIT
