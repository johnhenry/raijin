# Migration notes

## Unreleased → 0.0.1 — every hashed and signed format changed

The security work leading to 0.0.1 fixed a family of encoding bugs in which
two different structures could produce the same bytes, and therefore the same
hash, signature or Merkle root. Fixing that necessarily changes the bytes.

**This is a hard wire-format break.** A node running 0.0.1 and a node running
an earlier build cannot participate in the same network: they compute
different block digests, so PRE-PREPARE is rejected as a digest mismatch;
different vote payloads, so every signature verification fails; and different
state roots, so even agreement on a block would leave them on divergent
chains. There is no compatibility mode and no negotiation. Upgrade every node
together, from a fresh genesis.

Persisted state must also be discarded. Account records written by an earlier
build lack the account domain tag and `decodeAccount` now rejects them
(`RaijinError: Not an account encoding`), and every state root derived from
them would differ regardless.

### Formats that moved

| Format | Before | After | Consequence |
| --- | --- | --- | --- |
| PBFT vote signatures (`voteDigest`) | signature over the bare block digest | `H(phase tag ‖ 0x00 ‖ view ‖ sequence ‖ digest)` | every PREPARE/COMMIT/VIEW-CHANGE/PRE-PREPARE signature changes; old signatures verify nowhere |
| `merkleRoot` | plain pairwise hashing, last leaf duplicated on odd levels, single leaf returned unhashed | `0x00` leaf / `0x01` node domain tags, odd level promotes, empty list is `H(0x00)` | every `txRoot` and `receiptRoot` changes |
| Block header encoding (`encodeBlockHeader`, new export) | ad-hoc concatenation inside PBFT | domain tag `0x05`, length-prefixed roots and proposer, range-checked `u64` fields | the consensus digest changes; the header layout now has exactly one definition, shared by PBFT and `blockHash` |
| `parentHash` semantics | the parent's **state root** | the parent's **block hash** — `blockHash(parent)` = `H(encodeBlockHeader(parent.header))` (new export) | chain linkage now commits to the parent's transactions, proposer, timestamp and roots, not only to its post-state |
| `encodeTx` | raw concatenation; `to: null` encoded like `to: new Uint8Array(0)` | domain tag `0x01`; optional recipient carries a presence byte | the signed bytes change — every transaction signed by an earlier SDK is invalid |
| `encodeTxSigned` | `encodeTx ‖ signature` | domain tag `0x02` ahead of the same | transaction hashes change: `txRoot` leaves, mempool dedup keys, and the `txHash` on every receipt |
| `encodeAccount` / `decodeAccount` | three LEB128 fields | domain tag `0x03` ahead of them; the decoder rejects any other tag | stored account records are not readable by the other version, in either direction |
| `encodeReceipt` | raw concatenation; absent and empty `revertReason` identical | domain tag `0x04`; `revertReason` carries a presence byte | `receiptRoot` changes |
| `InMemoryStateStore.root()` | `H(hex(key₀) ‖ value₀ ‖ hex(key₁) ‖ value₁ ‖ …)`, entries ordered by `localeCompare` | `merkleRoot` over `H(encodeStateEntry(key, value))` per entry, ordered by key bytes | every `stateRoot` changes; a `StateStore` implemented elsewhere must use the exported `encodeStateEntry` to agree |

### Also breaking, though not a byte format

- `BlockProducer#advance(block)` returns `Promise<void>` rather than `void` —
  it hashes the parent header. Callers must `await` it.
- `Wallet` keys are non-extractable by default, and `chainId` is required
  when building a transaction rather than defaulting. (`chainId` was already
  part of `encodeTx`'s bytes; what changed is that the SDK no longer picks
  one for you.)
- `CelestiaDA` refuses to send an auth token over cleartext HTTP.

### Checklist for operators

1. Stop every node. A partial upgrade is worse than a stopped network: the
   old and new halves will both consider the other's blocks invalid.
2. Discard persisted state and start from a fresh genesis. There is no
   state-format converter, and account records will not decode.
3. Rebuild and redeploy every node, plus any client that signs transactions —
   an old client's signatures will be rejected by an upgraded validator.
4. Re-seed genesis balances with the current `encodeAccount`.
