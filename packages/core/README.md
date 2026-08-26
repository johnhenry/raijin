# @johnhenry/raijin-core

State machine, blocks, and transactions for the [Raijin](https://github.com/johnhenry/raijin) mesh rollup — a browser-native rollup framework where the users ARE the validators.

Zero external dependencies. Uses only `globalThis.crypto.subtle`. Works in the browser and in Node.js. Every other Raijin package depends on this one; if you only need the types, hashing, or the state transition function, this is the only install.

## Install

```bash
npm install @johnhenry/raijin-core
```

## Quick start

```js
import { StateMachine, InMemoryStateStore } from '@johnhenry/raijin-core'

const store = new InMemoryStateStore()
const sm = new StateMachine(store, myEd25519Verifier) // you inject signature verification

const receipt = await sm.applyTransaction(signedTx, 0)
// { txHash, status: 'success' | 'revert', revertReason?, index }
```

Failed transactions do not throw — they return `status: 'revert'` receipts with a `revertReason` (`'invalid signature'`, `'nonce mismatch: …'`, `'insufficient balance'`, …).

## Things to know first

- **Everything is async.** Hashing goes through `crypto.subtle`, so `hash`, `merkleRoot`, `stateRoot`, and every state-machine call return promises.
- **The first byte of `tx.data` selects the transaction type.** Empty `data` defaults to `Transfer`. Only `Transfer` (0x01) and `ReputationAttest` (0x02) execute real logic today; every other `TransactionType` value is a placeholder that just increments the sender's nonce.
- **`InMemoryStateStore.root()` is a flat hash of all entries, not a Merkle trie.** It's deterministic and good for equality checks across nodes, but it cannot produce inclusion proofs.
- **Byte-identity everywhere.** Addresses are 32-byte public keys as `Uint8Array`s; account state lives under namespaced keys like `'account:' + pubkey`. Seed genesis balances with `encodeAccount` + `store.put` (see [`examples/02-state-machine.mjs`](https://github.com/johnhenry/raijin/blob/main/examples/02-state-machine.mjs)).

## API

### Types

| Export | Shape |
| --- | --- |
| `Transaction` | `{ from, nonce, to, value, data, signature, chainId }` — `from`/`to` are 32-byte keys, amounts are `bigint` |
| `Block` | `{ header: BlockHeader, transactions: Transaction[], signatures: Uint8Array[] }` |
| `BlockHeader` | `{ number, parentHash, stateRoot, txRoot, receiptRoot, timestamp, proposer }` |
| `Account` | `{ balance: bigint, nonce: bigint, reputation: bigint }` |
| `TransactionReceipt` | `{ txHash, status, revertReason?, index }` |
| `TransactionType` | enum: `Transfer = 0x01` … `EscrowRefund = 0x0f` (15 values; most are placeholders, see above) |
| `StateStore` | interface: `get/put/delete/root/snapshot/revert` — implement over IndexedDB, OPFS, … |
| `StateSnapshot` | `{ id: number }` |
| `SignatureVerifier` | `{ verify(message, signature, publicKey): Promise<boolean> }` |
| `TransactionSigner` | `{ publicKey, sign(message): Promise<Uint8Array> }` |

### `StateMachine`

```ts
new StateMachine(store: StateStore, verifier: SignatureVerifier)
```

- `applyTransaction(tx, index): Promise<TransactionReceipt>` — verifies the signature over `encodeTx(tx)`, checks the nonce against the sender's account, dispatches on `tx.data[0]`, and writes state. Reverts are receipts, not exceptions.
- `applyBlock(block): Promise<TransactionReceipt[]>` — applies each transaction in order. Reverted transactions stay in the block with revert receipts; executors check preconditions before writing, so a reverted transaction leaves no partial state. There is no block-level rollback.
- `getAccount(address): Promise<Account>` — returns a zero account (`0n/0n/0n`) for unknown addresses.
- `stateRoot(): Promise<Uint8Array>` — delegates to `store.root()`.

### `InMemoryStateStore`

`StateStore` implementation backed by a `Map`, with full `snapshot()`/`revert()` support and a `size` getter. Fine for tests and small state; swap in a persistent store for anything real.

### Hashing — `hash`, `hashString`, `merkleRoot`, `equal`, `toHex`, `fromHex`

```js
import { hashString, merkleRoot, toHex } from '@johnhenry/raijin-core'

const root = await merkleRoot([await hashString('tx-a'), await hashString('tx-b')])
toHex(root) // '9c31…'
```

- `hash(data)` / `hashString(str)` — SHA-256, returns 32 bytes.
- `merkleRoot(leaves)` — binary tree over leaf hashes; odd levels duplicate the last leaf. A single leaf is returned **as-is** (no extra hash), and `[]` yields `hash(empty)`. There is no leaf/node domain separation — don't use this where second-preimage games matter.
- `equal(a, b)` — byte-wise comparison (not constant-time).
- `toHex` / `fromHex` — lowercase hex round-trip.

### Encoding — `encodeBigInt`, `decodeBigInt`, `encodeBytes`, `decodeBytes`, `encodeTx`, `encodeTxSigned`, `encodeAccount`, `decodeAccount`

Deterministic canonical binary encoding (LEB128 varints + length prefixes). `encodeTx(tx)` covers everything **except** the signature — it's the exact byte string that gets signed and that receipts hash. `encodeTxSigned(tx)` appends the signature and is what block producers hash for the tx Merkle root. The decoders return `[value, bytesConsumed]` pairs.

### Genesis funding

There is no genesis-block concept — initial state is whatever you write to the store before the first block. Accounts live under the `'account:'` namespace:

```js
import { InMemoryStateStore, encodeAccount } from '@johnhenry/raijin-core'

const store = new InMemoryStateStore()
const prefix = new TextEncoder().encode('account:')
await store.put(
  new Uint8Array([...prefix, ...alicePublicKey]),
  encodeAccount({ balance: 1_000n, nonce: 0n, reputation: 0n }),
)
```

Do this identically on every node (before `start()`), or their state roots diverge from block one.

### Errors

`RaijinError` base class, plus `InvalidTransactionError`, `InvalidBlockError`, `StateError`, `InsufficientBalanceError`. The state machine's normal failure path is revert receipts; these classes are for out-of-band failures.

## Provenance

Previously published unscoped as [`raijin-core`](https://www.npmjs.com/package/raijin-core), last version `0.0.1` (published 2026-03-15 as part of the project's initial `v0.1.0` release). Unlike its sibling packages, `raijin-core` has no internal `workspace:*` dependency of its own, so it was never affected by the `workspace:*`-leak publish bug that forced `raijin-consensus`/`raijin-mempool`/`raijin-da`/`raijin-validator`/`raijin-sdk` through a `0.0.2` → `0.0.3` republish — `0.0.1` was its only unscoped release.

Moved into the `@johnhenry` npm scope and restarted at `0.0.0` — no functional changes in the move. See the [root CHANGELOG](https://github.com/johnhenry/raijin/blob/main/CHANGELOG.md) for the full project history.

## License

MIT
