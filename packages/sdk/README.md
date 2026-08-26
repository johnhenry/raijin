# @johnhenry/raijin-sdk

Developer-facing client API for the [Raijin](https://github.com/johnhenry/raijin) mesh rollup — submit transactions and query state from a browser-native validator mesh.

Two pieces: `Wallet` (Ed25519 key management + transaction building/signing over Web Crypto) and `RaijinClient` (submit/query/subscribe through an injected `ClientTransport`). The SDK deliberately does not know how bytes reach a validator — you implement `ClientTransport` over HTTP, WebRTC, a Worker port, or an in-process node.

## Install

```bash
npm install @johnhenry/raijin-sdk
```

## Things to know first

- **`Wallet` needs Web Crypto Ed25519.** Node 20+ and current browsers have it; older environments throw at `Wallet.generate()`. The repo targets Node ≥ 24.
- **Signatures cover `encodeTx(tx)` — everything except the signature itself.** Mutate any field after `buildTx()` and verification fails (that's the point). Validators hash the same bytes for the receipt `txHash`, so `hash(encodeTx(tx))` is how you match your transaction to its receipt.
- **Nonce management is yours.** `buildTx()` takes an explicit `nonce`; fetch the account first (`(await client.getAccount(wallet.publicKey)).nonce`) or track it locally. A wrong nonce becomes a `revert` receipt, not an error at submit time.
- **`chainId` defaults to `1n`** and exists to prevent cross-chain replay; the reference state machine does not yet enforce it.

## Quick start

```js
import { RaijinClient, Wallet } from '@johnhenry/raijin-sdk'

const wallet = await Wallet.generate()

const client = new RaijinClient(transport) // your ClientTransport implementation

const account = await client.getAccount(wallet.publicKey)
const tx = await wallet.buildTx({
  to: recipientPublicKey,     // Uint8Array(32), or null for system ops
  value: 250n,
  nonce: account.nonce,
})

const receipt = await client.submitTransaction(tx)  // { txHash, status, revertReason?, index }
const unsubscribe = client.subscribe((block) => console.log('block', block.header.number))
```

A complete end-to-end run — real Ed25519 verification against an in-process `ValidatorNode`, including a tampered-transaction revert — is in [`examples/07-sdk-end-to-end.mjs`](https://github.com/johnhenry/raijin/blob/main/examples/07-sdk-end-to-end.mjs).

## API

### `Wallet` (implements `TransactionSigner`)

| Member | Purpose |
| --- | --- |
| `static generate(): Promise<Wallet>` | New Ed25519 keypair via `crypto.subtle.generateKey`. |
| `static fromKey(pkcs8: Uint8Array): Promise<Wallet>` | Import a private key (PKCS8); the public key is derived from it. |
| `publicKey: Uint8Array` | 32-byte raw public key — this is your address. |
| `sign(message): Promise<Uint8Array>` | Raw Ed25519 signature (64 bytes, deterministic). |
| `buildTx(opts: BuildTxOptions): Promise<Transaction>` | Assembles `{ from: publicKey, to, value, nonce, data?, chainId? }` and signs it. |
| `exportPrivateKey(): Promise<Uint8Array>` | PKCS8 bytes for storage; round-trips through `fromKey()`. |

`BuildTxOptions`: `{ to, value, nonce, data?, chainId? }` — `data` defaults to empty (which the state machine treats as a `Transfer`; set `data[0]` to a `TransactionType` byte for anything else).

### `RaijinClient`

`new RaijinClient(transport: ClientTransport)`

| Member | Purpose |
| --- | --- |
| `submitTransaction(tx): Promise<TransactionReceipt>` | Send and wait for the execution receipt. |
| `getAccount(address): Promise<Account>` | `{ balance, nonce, reputation }`; unknown addresses are zero accounts. |
| `getBlock(number): Promise<Block \| null>` | By height. |
| `subscribe(handler): () => void` | New finalized blocks; returns the unsubscribe function. |

The client is a thin, typed pass-through — all reliability semantics (timeouts, retries, which validator answers queries) live in your transport.

### `ClientTransport` (interface)

```ts
interface ClientTransport {
  submitTransaction(tx: Transaction): Promise<TransactionReceipt>
  getAccount(address: Uint8Array): Promise<Account>
  getBlock(number: bigint): Promise<Block | null>
  onBlock(handler: (block: Block) => void): () => void
}
```

For tests and demos, back it directly with a `ValidatorNode`: `getAccount` → `node.stateMachine.getAccount`, `submitTransaction` → `node.submitTransaction` + match the receipt by `hash(encodeTx(tx))` in `onBlockFinalized`.

## Provenance

Previously published unscoped as [`raijin-sdk`](https://www.npmjs.com/package/raijin-sdk): `0.0.1` (initial release, 2026-03-15), then `0.0.2` (2026-07-16 — published with a broken build, because the release workflow used plain `npm publish`, which does not rewrite `workspace:*` internal dependency specifiers into real resolved versions; that tarball was unpublished), then `0.0.3` (2026-07-16, same day — republished correctly via `pnpm publish`, the last unscoped version, live until this move).

Moved into the `@johnhenry` npm scope and restarted at `0.0.0` — no functional changes in the move. The `workspace:*` publish bug can no longer recur: the monorepo has since converted to npm workspaces with real semver ranges, and releases go out via `npm publish --workspaces`. See the [root CHANGELOG](https://github.com/johnhenry/raijin/blob/main/CHANGELOG.md) for the full project history.

## License

MIT
