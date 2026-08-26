# @johnhenry/raijin-mempool

Transaction mempool with fee-based ordering and eviction for the [Raijin](https://github.com/johnhenry/raijin) mesh rollup — a browser-native rollup framework where the users ARE the validators.

Accepts transactions, verifies signatures through an injected verifier, deduplicates by sender+nonce, orders by fee for block building, evicts the lowest-fee transaction when full, and optionally gossips accepted transactions to peers.

## Install

```bash
npm install @johnhenry/raijin-mempool
```

## The fee convention — read this first

`defaultFeeExtractor` reads the **first 8 bytes of `tx.data` as a big-endian uint64 fee** (shorter data ⇒ fee `0n`). Two traps hide in that sentence:

1. **It collides with the state machine's convention.** `@johnhenry/raijin-core`'s `StateMachine` treats `tx.data[0]` as the transaction *type*. A `data` layout can't serve both defaults at once — if your transactions carry typed data, supply your own `FeeExtractor` (e.g. `(tx) => tx.value` for tip-style fees).
2. **The config doc-comment in older builds says the default is `tx.value`. It is not.** The default is the 8-byte data prefix; verify with `defaultFeeExtractor(tx)` if in doubt.

Also note: this package is standalone. `@johnhenry/raijin-validator` ships its **own, different `Mempool`** (FIFO, no verification, throws when full) and uses that one internally — see "Which mempool am I holding?" below.

## Quick start

```js
import { Mempool, defaultFeeExtractor } from '@johnhenry/raijin-mempool'

const pool = new Mempool({
  verifier: async (tx) => myVerifySignature(tx), // required
  maxSize: 4096,                                 // default 4096
  feeExtractor: (tx) => tx.value,                // optional — see trap above
  gossip: { broadcast: (tx) => channel.send(tx) }, // optional
})

pool.onDropped((tx, reason) => console.log('dropped:', reason))
// reasons: 'duplicate' | 'invalid-signature' | 'pool-full' | 'evicted'

await pool.submit(tx)          // true if accepted (also gossiped), false if dropped
const forBlock = pool.pendingForProposer(100) // top-100 by fee
```

## API

### `Mempool`

`new Mempool(config: MempoolConfig)` — `config.verifier` is required; `maxSize`, `feeExtractor`, `gossip` optional.

| Member | Purpose |
| --- | --- |
| `submit(tx): Promise<boolean>` | Dedup (sender+nonce) → verify signature → evict-or-reject if full → accept + gossip. |
| `remove(tx): boolean` / `removeBatch(txs): number` | Drop by sender+nonce identity (e.g. after block inclusion). |
| `pending(): Transaction[]` | All transactions, fee-descending, nonce-ascending on ties. |
| `pendingForProposer(limit?): Transaction[]` | The same ordering, truncated to `limit`. |
| `has(tx)` / `hasNonce(sender, nonce)` | Membership checks by sender+nonce. |
| `size` | Current count. |
| `onAccepted(handler)` / `onDropped(handler)` | Event hooks; `onDropped` receives a reason string. |

Eviction rule: when the pool is full, an incoming transaction must have a **strictly higher** fee than the current lowest to displace it. Equal fee ⇒ dropped as `'pool-full'`. The displaced transaction is emitted as `'evicted'`.

Identity is sender+nonce, not content: a second transaction from the same sender with the same nonce is a `'duplicate'` even if its fee is higher — there is no replace-by-fee.

### `orderByFee(txs, feeExtractor): Transaction[]`

Pure sorting helper (fee descending, nonce ascending on ties). Returns a new array; usable without a `Mempool`.

### `defaultFeeExtractor(tx): bigint`

The 8-byte big-endian data prefix described above.

### Types

`MempoolConfig`, `FeeExtractor` (`(tx) => bigint`), `TransactionVerifier` (`(tx) => Promise<boolean>`), `GossipTransport` (`{ broadcast(tx) }`), `MempoolEvents`.

## Using it as a block builder's source

The intended consumption pattern — take the top of the pool, build, then prune exactly what was included:

```js
const txs = pool.pendingForProposer(maxTxPerBlock) // top-N by fee
const block = await buildBlock(txs)                // your producer
// …after the block finalizes:
pool.removeBatch(block.transactions)               // prune by sender+nonce
```

`pending()` returns a fresh array each call, so it's safe to build from while `submit()`s keep arriving — but the pool contents can change between `pendingForProposer()` and `removeBatch()`, which is fine: `removeBatch` returns how many were actually removed, and transactions that arrived meanwhile simply wait for the next block.

## Which mempool am I holding?

| | `@johnhenry/raijin-mempool` `Mempool` | `@johnhenry/raijin-validator` `Mempool` |
| --- | --- | --- |
| Ordering | fee-descending | FIFO |
| Signature check | yes, injected verifier | none |
| Full pool | evict lowest / reject | `throw new Error('Mempool full')` |
| Submit API | `submit(tx) → boolean` | `add(tx) → tx-hash hex` |
| Used by `ValidatorNode` | no | yes |

They share a name and nothing else. If you want fee ordering inside a validator today, you wire it yourself (the fee-ordered pool is not yet integrated into `ValidatorNode`).

## Provenance

Previously published unscoped as [`raijin-mempool`](https://www.npmjs.com/package/raijin-mempool): `0.0.1` (initial release, 2026-03-15), then `0.0.2` (2026-07-16 — published with a broken build, because the release workflow used plain `npm publish`, which does not rewrite `workspace:*` internal dependency specifiers into real resolved versions; that tarball was unpublished), then `0.0.3` (2026-07-16, same day — republished correctly via `pnpm publish`, the last unscoped version, live until this move).

Moved into the `@johnhenry` npm scope and restarted at `0.0.0` — no functional changes in the move. The `workspace:*` publish bug can no longer recur: the monorepo has since converted to npm workspaces with real semver ranges, and releases go out via `npm publish --workspaces`. See the [root CHANGELOG](https://github.com/johnhenry/raijin/blob/main/CHANGELOG.md) for the full project history.

## License

MIT
