# @johnhenry/raijin-validator

Composition root wiring core, consensus, and mempool into a runnable validator node for the [Raijin](https://github.com/johnhenry/raijin) mesh rollup — a browser-native rollup framework where the users ARE the validators.

`ValidatorNode` assembles a `StateMachine`, a `PBFTConsensus` engine, a FIFO `Mempool`, and a `BlockProducer`, then runs the loop: accept transactions → (if leader) build a block on the block timer → propose → finalize → apply state → prune mempool. You inject identity (keys + sign/verify), a network transport, a timer, and a state store — the node is transport-, storage-, and identity-agnostic.

## Install

```bash
npm install @johnhenry/raijin-validator
```

## Traps first

- **This package's `Mempool` is not `@johnhenry/raijin-mempool`.** It's a separate, simpler class: FIFO order (no fee ordering), **no signature verification**, and `add()` **throws** `'Mempool full'` at capacity instead of evicting. The fee-ordered, verifying pool in `@johnhenry/raijin-mempool` is not wired into `ValidatorNode` today.
- **`submitTransaction()` accepts anything.** Invalid signatures, bad nonces, and overspends are only caught when the block executes — they become `revert` receipts, but they still occupied mempool and block space on the way.
- **`validators` must include this node's own public key**, or `isLeader` is never true and (with `n = 1`) nothing ever finalizes. All nodes must pass the same keys in the same order.
- **Block headers commit to transactions, not to state.** `BlockProducer` fills `txRoot` from the transactions but leaves `stateRoot`/`receiptRoot` zeroed ("filled after execution" — currently never filled), and `advance()` uses the previous header's `stateRoot` field as `parentHash`. Consensus therefore agrees on *transaction ordering*, and state agreement is by construction (same deterministic state machine), not by header commitment.
- **Quorum below 4 validators is 1.** See `@johnhenry/raijin-consensus` — a single-validator "network" finalizes its own blocks instantly, which is exactly what the quick start below exploits.

## Quick start — a one-validator chain

```js
import { InMemoryStateStore } from '@johnhenry/raijin-core'
import { ValidatorNode } from '@johnhenry/raijin-validator'

const node = new ValidatorNode({
  identity: { publicKey, sign, verify },   // your keys; verify checks tx signatures
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

Config: `identity` (`{ publicKey, sign, verify }`), `transport` (`NetworkTransport`), `timer` (`ConsensusTimer`), `store` (`StateStore`), plus optional `blockTime` (ms, default 2000), `validators` (default `[]` — see trap above), `maxTxPerBlock` (default 100), `maxMempoolSize` (default 4096).

| Member | Purpose |
| --- | --- |
| `start()` / `stop()` | Start/stop consensus and the block-production timer loop. Idempotent. |
| `submitTransaction(tx): Promise<string>` | Adds to the FIFO mempool; resolves to the tx hash hex (hash of the *signed* encoding). Throws if the mempool is full. |
| `onBlockFinalized(handler)` | `(block, receipts) => void` after every finalized block. |
| `latestBlock` | Most recently finalized `Block`, or `null`. |
| `running` | Boolean. |
| `consensus` / `mempool` / `stateMachine` / `blockProducer` | The wired sub-components, exposed for advanced use (e.g. `node.stateMachine.getAccount(addr)`). |

Block-production errors inside the timer loop are swallowed by design (not being leader or having an empty mempool is normal); drive `node.blockProducer.produceBlock()` manually if you need the error.

### `BlockProducer` / `BlockProducerConfig`

Config: `proposer` (pubkey), `consensus`, `mempool`, optional `maxTxPerBlock` (default 100).

- `produceBlock(): Promise<Block | null>` — returns `null` when not leader or mempool empty; otherwise builds a block (Merkle `txRoot` over signed-tx hashes) and calls `consensus.propose()`.
- `advance(block)` — called after finalization to bump `nextBlockNumber` and carry the parent linkage.
- `nextBlockNumber: bigint` — getter.

### `Mempool` (the FIFO one)

`new Mempool(maxSize = 4096)` — `add(tx): Promise<string>` (throws when full), `pending(limit?)` (FIFO), `remove(hashHex)`, `removeBatch(txs)`, `clear()`, `size`. Keyed by hash of the signed encoding, so the same signed tx submitted twice occupies one slot.

## Running more than one node

Everything above scales to a real mesh, but three things change:

1. **The transport becomes real.** Every node's `transport.broadcast`/`send` must reach every other validator, and `onMessage` must report the sender's actual public key as `from` — consensus trusts that value, so an unauthenticated transport means any peer can impersonate any validator. If your wire format is JSON, consensus messages carry `bigint`s and `Uint8Array`s; you need a replacer/reviver pair (`packages/consensus/test/helpers.ts` has a working one).
2. **`validators` must be byte-identical on every node** — same keys, same order. Leader election is positional (`view % n`), so a different ordering means nodes disagree about who may propose and nothing ever finalizes, with no error to tell you why.
3. **Quorum math starts to matter.** At n = 4 you tolerate one faulty node (quorum 3); below that, quorum is 1 and any single node can finalize alone. Pick n = 3f + 1 for the f you actually need.

Multi-node scenarios — leader crashes, partitions, membership churn — are exercised by the repo's internal `raijin-test-harness` package (`TestOrchestrator` + `PartitionableNetwork` + invariant checkers) rather than examples, because they're timing-sensitive by nature. Read the harness tests for working multi-node wiring.

## Provenance

Previously published unscoped as [`raijin-validator`](https://www.npmjs.com/package/raijin-validator): `0.0.1` (initial release, 2026-03-15), then `0.0.2` (2026-07-16 — published with a broken build, because the release workflow used plain `npm publish`, which does not rewrite `workspace:*` internal dependency specifiers into real resolved versions; that tarball was unpublished), then `0.0.3` (2026-07-16, same day — republished correctly via `pnpm publish`, the last unscoped version, live until this move).

Moved into the `@johnhenry` npm scope and restarted at `0.0.0` — no functional changes in the move. The `workspace:*` publish bug can no longer recur: the monorepo has since converted to npm workspaces with real semver ranges, and releases go out via `npm publish --workspaces`. See the [root CHANGELOG](https://github.com/johnhenry/raijin/blob/main/CHANGELOG.md) for the full project history.

## License

MIT
