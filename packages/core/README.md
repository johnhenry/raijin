# @johnhenry/raijin-core

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Fraijin-core.svg)](https://www.npmjs.com/package/@johnhenry/raijin-core)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Fraijin-core.svg)](../../LICENSE)

State machine, blocks, and transactions for the [Raijin](https://github.com/johnhenry/raijin) mesh rollup — a browser-native rollup framework where the users ARE the validators.

Zero external dependencies. Uses only `globalThis.crypto.subtle`. Works in the browser and in Node.js. Every other Raijin package depends on this one; if you only need the types, hashing, or the state transition function, this is the only install.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Things to know first](#things-to-know-first)
- [API](#api)
- [Provenance](#provenance)
- [License](#license)

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
- **`InMemoryStateStore.root()` is a Merkle root over the store's entries.** Each key→value pair is hashed through `encodeStateEntry` (domain-tagged, both fields length-prefixed) and the entry hashes are combined with `merkleRoot`, ordered by the key's bytes. It uniquely commits to the store's contents — but there is still no inclusion-proof API, so it is a commitment, not a queryable trie.
- **Byte-identity everywhere.** Addresses are 32-byte public keys as `Uint8Array`s; account state lives under namespaced keys. Build those keys with `accountKey(address)` — never by concatenating a prefix yourself, since the key bytes are hashed into the state root. Seed genesis balances with `accountKey` + `encodeAccount` + `store.put` (see [`examples/02-state-machine.mjs`](https://github.com/johnhenry/raijin/blob/main/examples/02-state-machine.mjs)).

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
| `StateStore` | interface: `get/put/delete/root/snapshot/revert` — see [Durable state](#durable-state--persistentstatestore-kvbackend-indexeddbkvbackend-memorykvbackend-checkstatestoreconformance) for IndexedDB-backed persistence |
| `StateSnapshot` | `{ id: number }` |
| `SignatureVerifier` | `{ verify(publicKey, signature, message): Promise<boolean> }` (WebCrypto order; **changed in 0.1.0**) |
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
- `merkleRoot(leaves)` — binary tree over leaf hashes, domain-separated: leaves are `H(0x00 ‖ leaf)`, internal nodes `H(0x01 ‖ left ‖ right)`. An odd level **promotes** its last node rather than pairing it with itself, and `[]` yields `H(0x00)`. Together these make the root a unique commitment to the leaf list: without them the tree has the CVE-2012-2459 shape, where `[A, B, C]` pads to `[A, B, C, C]` and both produce the same root.
- `equal(a, b)` — byte-wise comparison (not constant-time).
- `toHex` / `fromHex` — lowercase hex round-trip.

### Encoding — `encodeBigInt`, `decodeBigInt`, `encodeBytes`, `decodeBytes`, `encodeTx`, `encodeTxSigned`, `encodeAccount`, `decodeAccount`, `encodeReceipt`, `encodeStateEntry`, `encodeBlockHeader`, `blockHash`, `Domain`

Deterministic canonical binary encoding. Two rules hold throughout, and they are what make an encoding a *commitment* rather than merely a serialization:

1. **Every variable-length field carries its length** (LEB128), so concatenation never loses the boundary between adjacent fields.
2. **Every distinct structure carries a one-byte domain tag**, so one kind of encoding cannot be reinterpreted as another. The tags live in the `Domain` registry: `Transaction` 0x01, `SignedTransaction` 0x02, `Account` 0x03, `Receipt` 0x04, `BlockHeader` 0x05, `StateEntry` 0x06, `StateKey` 0x07. They are consensus-critical — never reuse or renumber one.

- `encodeTx(tx)` covers everything **except** the signature; it is the exact byte string that gets signed.
- `encodeTxSigned(tx)` wraps that plus the signature, and its hash is the canonical transaction identifier — block `txRoot` leaves, mempool dedup keys, and the `txHash` on every receipt.
- `encodeBlockHeader(header)` / `blockHash(block)` — one definition of a header's bytes, used both for the consensus digest and for the block hash a child's `parentHash` must equal. `blockHash` is `H(encodeBlockHeader(header))`.
- `encodeStateEntry(key, value)` — exported so that *any* `StateStore` implementation derives the same state root from the same contents. A store that invents its own layout forks from the ones that don't.
- `decodeAccount` rejects bytes that are not tagged `Domain.Account` rather than misreading them.
- The decoders return `[value, bytesConsumed]` pairs.

### State keys — `accountKey`, `stateKey`, `StateNamespace`

A state key is `0x07 ‖ len(namespace) ‖ namespace ‖ len(id) ‖ id`. Key bytes are hashed into the state root, so anything writing state directly — genesis funding, fixtures, a state-sync importer — must produce byte-identical keys or it silently forks from its peers.

- `accountKey(address)` — where an account record lives. This is the one you want.
- `stateKey(namespace, id)` — the general form, for the other `StateNamespace` entries.
- `StateNamespace` — `account:`, `credential:`, `proposal:`, `service:`, `identity:`, `escrow:`, `validator:`. Only `account:` is read or written by the state machine today.

Length-prefixing matters here even though the shipped namespaces happen not to collide: prefix-freeness and fixed-width ids are coincidences, not invariants, and a bare `namespace ‖ id` concatenation would let two different pairs land on one key. Keys within a namespace still share a prefix and sort together.

### Genesis funding

There is no genesis-block concept — initial state is whatever you write to the store before the first block. Accounts live under the `account:` namespace; use `accountKey` to build the key rather than concatenating the prefix by hand:

```js
import { InMemoryStateStore, encodeAccount, accountKey } from '@johnhenry/raijin-core'

const store = new InMemoryStateStore()
await store.put(
  accountKey(alicePublicKey),
  encodeAccount({ balance: 1_000n, nonce: 0n, reputation: 0n }),
)
```

Do this identically on every node (before `start()`), or their state roots diverge from block one.

### Signatures — `verifyEd25519`, `signEd25519`, `ed25519Verifier`

Argument order is WebCrypto's: key first, message last.

```ts
verifyEd25519(publicKey: Uint8Array, signature: Uint8Array, message: Uint8Array): Promise<boolean>
signEd25519(privateKey: CryptoKey | Uint8Array /* 32-byte seed */, message: Uint8Array): Promise<Uint8Array>
ed25519Verifier: SignatureVerifier   // { verify: verifyEd25519 } — what `identity.verify` / `PBFTConfig.verify` want
```

> **Throws on a bad public key.** `verifyEd25519` throws a `TypeError` (it does not return `false`) when `publicKey` is not a 32-byte `Uint8Array`. This changed in 0.1.0 along with the argument order, to catch swapped call sites. Every other failure (wrong, truncated or garbled signature; unusable key bytes of the right length) returns `false`. Wrap the call if a malformed key is attacker-controlled input you want to treat as "invalid" rather than as an exception.

**BREAKING in 0.1.0.** `verifyEd25519` used to be `(message, signature, publicKey)`. `ed25519Verifier` and the `SignatureVerifier` interface flipped with it, so a custom verifier you inject into `StateMachine`, `PBFTConsensus` or `ValidatorNode` must now take `(publicKey, signature, message)`. A swapped call no longer returns `false` silently: a public key is always 32 bytes, so `verifyEd25519` throws a `TypeError` naming the new order when `publicKey` is not a 32-byte `Uint8Array`. (A custom verifier that ignores its arguments is unaffected; one that reads them positionally is not — and the compiler will not catch a `(Uint8Array, Uint8Array, Uint8Array)` signature in plain JS.) The same order is used across raijin, wsh and browsermesh. `verifyEd25519` returns `false` (never throws) for a wrong/garbled signature; `signEd25519` throws on bad input.

### Wire codec — `encodeMessage`, `decodeMessage`, `WireFormatError`

Consensus messages, `tx-gossip` messages, genesis payloads, transactions and blocks carry `bigint` and `Uint8Array`, which `JSON.stringify` throws on or mangles. `encodeMessage(value): Uint8Array` / `decodeMessage(bytes): value` is a small, dependency-free, **canonical** binary format that round-trips `null`, booleans, numbers, `bigint`, strings, `Uint8Array`, arrays and plain objects. Canonical means one value has exactly one encoding (so the bytes can be hashed, signed or compared), and `decodeMessage` throws `WireFormatError` on anything that is not that encoding: truncation, trailing bytes, unknown version or tag, non-minimal integers, unsorted or duplicate object keys, invalid UTF-8, nesting deeper than 64. Decoded `Uint8Array`s are copies, never views into the input.

`undefined` object properties are omitted (like JSON); `undefined` elsewhere, functions, symbols, `Map`/`Set`/`Date`/class instances and lone surrogates throw `TypeError` on encode. `@johnhenry/raijin-consensus` adds typed `encodeConsensusMessage`/`decodeConsensusMessage` and `codecTransport` on top; `@johnhenry/raijin-sdk` re-exports `encodeMessage`/`decodeMessage`.

**Format spec (version 1)** — implement this in any language:

```
message = 0x01 || value                       ; 0x01 = format version
value   = tag(1 byte) || body
u32     = unsigned 32-bit, big-endian

tag  type            body
0x00 null            (empty)
0x01 false           (empty)
0x02 true            (empty)
0x03 bigint >= 0     u32 n || n bytes: big-endian magnitude, minimal (no leading 0x00); 0n is n = 0
0x04 bigint <  0     same body, holding the magnitude |v| (n = 0 is invalid: no negative zero)
0x05 number          8 bytes: IEEE-754 binary64, big-endian. Every NaN is 7ff8000000000000. -0 is kept.
0x06 string          u32 n || n bytes of well-formed UTF-8
0x07 bytes           u32 n || n raw bytes
0x08 array           u32 n || n values
0x09 object          u32 n || n x ( u32 klen || key UTF-8 || value ), keys strictly ascending by
                     their UTF-8 bytes (bytewise, unsigned), no duplicates
```

Examples (hex): `null` = `0100`; `true` = `0102`; `0n` = `010300000000`; `256n` = `0103000000020100`; `-1n` = `01040000000101`; `"hi"` = `0106000000026869`; `Uint8Array[0xab]` = `010700000001ab`; `1` (number) = `01053ff0000000000000`; `{a: 1n}` = `0109000000010000000161` `0300000001` `01`. `1` the number, `1n` the bigint and `"1"` the string encode differently, so types are preserved exactly. A receiver must still validate the *shape* of what it decodes (`decodeConsensusMessage` does this for consensus messages); the codec only guarantees well-formed, canonical values.

### Durable state — `PersistentStateStore`, `KVBackend`, `IndexedDbKVBackend`, `MemoryKVBackend`, `checkStateStoreConformance`

`InMemoryStateStore` loses everything on a reload. `PersistentStateStore` is a `StateStore` + `SyncableStateStore` that keeps the working set in memory (so `root()`, `snapshot()` and `revert()` are exactly the in-memory ones, and roots are identical by construction) and writes every change through to a `KVBackend`:

```ts
interface KVBackend {
  loadAll(): Promise<Map<string, Uint8Array>>   // hex(key) -> value
  write(batch: { puts: [string, Uint8Array][]; deletes: string[] }): Promise<void>  // MUST be atomic
  close?(): void | Promise<void>
}

const store = await PersistentStateStore.open(new IndexedDbKVBackend({ name: 'my-chain-state' }))
```

- `put`/`delete`/`revert` resolve only once the change is durable; a failed backend write rejects the call and leaves memory unchanged, so memory is never ahead of disk. Writes are serialised.
- `importData` (state sync) is synchronous by contract, so its disk write runs in the background: `await store.flush()` for durability; a failure rejects `flush()` (or the next `put`/`delete`). `ValidatorNode.importSyncState` flushes for you.
- Snapshots are in-memory only (rollback within a block, not across restarts).
- `IndexedDbKVBackend` (browser) uses one object store and one readwrite transaction per batch. It has been exercised against an in-process IndexedDB double in tests, not a real browser. An OPFS backend or a Node file backend is just another `KVBackend` (about 40 lines).
- `checkStateStoreConformance({ create, reopen? })` throws unless a store is root-equivalent to `InMemoryStateStore` (empty, after put/overwrite/delete, snapshot/revert including nested, after a real `StateMachine` transfer) and, with `reopen`, survives a restart. Run it from any test runner against your own `StateStore`.

To resume a *validator* (not just state) after a restart, also pass `checkpoint` to `ValidatorNode`; see `@johnhenry/raijin-validator`.

### Genesis — `GenesisConfig`, `createGenesisBlock`, `genesisHash`, `applyGenesisState`, `assertGenesisMatches`

A `GenesisConfig` (`chainId`, ordered `validators`, optional initial `accounts`, optional `timestamp`, default 0) deterministically derives block 0: number 0, zero parent, `stateRoot` = root of the genesis accounts, `txRoot` = a commitment to the chain id and ordered validator set. Equal configs give equal `genesisHash`; any difference (chain id, a validator or their order, a balance, the timestamp) gives a different one. **Trust model:** genesis is not discovered trustlessly — a node is told the config, or at least the expected hash, out of band. See `@johnhenry/raijin-validator` for `genesis`/`genesisHash`/`fetchGenesis`.

### Errors

`RaijinError` base class, plus `InvalidTransactionError`, `InvalidBlockError`, `StateError`, `InsufficientBalanceError`. The state machine's normal failure path is revert receipts; these classes are for out-of-band failures.

## Provenance

Previously published unscoped as [`raijin-core`](https://www.npmjs.com/package/raijin-core), last version `0.0.1` (published 2026-03-15 as part of the project's initial `v0.1.0` release). Unlike its sibling packages, `raijin-core` has no internal `workspace:*` dependency of its own, so it was never affected by the `workspace:*`-leak publish bug that forced `raijin-consensus`/`raijin-mempool`/`raijin-da`/`raijin-validator`/`raijin-sdk` through a `0.0.2` → `0.0.3` republish — `0.0.1` was its only unscoped release.

Moved into the `@johnhenry` npm scope and restarted at `0.0.0` — no functional changes in the move. See the [root CHANGELOG](https://github.com/johnhenry/raijin/blob/main/CHANGELOG.md) for the full project history.

## License

MIT
