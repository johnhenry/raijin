# @johnhenry/raijin-da

Data availability abstraction with pluggable backends for the [Raijin](https://github.com/johnhenry/raijin) mesh rollup — a browser-native rollup framework where the users ARE the validators.

One interface, three backends: `LocalDA` (in-memory, for dev/tests), `CelestiaDA` (talks to a Celestia light node's REST API), and `EthBlobDA` (EIP-4844 — currently a documented stub). Plus `encode()`/`decode()` for compressing block data before submission.

`viem` is an optional peer dependency, needed only if you go on to implement the ETH-blobs backend.

## Install

```bash
npm install @johnhenry/raijin-da
```

## What a commitment does and does not prove

`submit()` returns a `DACommitment`: `{ layer, height, index, hash }`, where `hash` is the SHA-256 of the submitted bytes. `verify(commitment)` retrieves whatever the backend has for that hash and re-hashes it. So:

- **It proves**: "this backend currently serves bytes matching this content hash."
- **It does not prove**: inclusion at `height`/`index` (LocalDA's height is a local counter you advance manually; CelestiaDA always reports `index: 0`), nor availability over time, nor anything a light client could check without refetching the full data. There are no inclusion/KZG proofs here.

Other traps:

- **`EthBlobDA` throws on every method.** It exists to pin the interface and document the implementation path (viem blob transactions, KZG setup, Beacon API retrieval); the error messages are the TODO list. Ethereum blobs are also pruned after ~18 days — plan for archival.
- **`encode()` output depends on the environment.** If the optional `fflate` package is importable, payloads that shrink get deflate-compressed with an `RJC` magic prefix; otherwise raw bytes with `RJR`. `decode()` of an `RJC` payload **throws if fflate is absent** — if writers may compress, every reader needs fflate too.
- **`CelestiaDA` needs a running light node** (default endpoint `http://localhost:26658`, usually with an auth token). It does not embed one.

## Quick start

```js
import { LocalDA, encode, decode } from '@johnhenry/raijin-da'

const da = new LocalDA()

const payload = await encode(blockBytes)      // magic header + optional compression
const commitment = await da.submit(payload)   // { layer: 'local', height, index, hash }

const roundTrip = await decode(await da.retrieve(commitment))
await da.verify(commitment)                   // true
```

Swapping backends is a one-line change:

```js
import { CelestiaDA } from '@johnhenry/raijin-da'

const da = new CelestiaDA({
  namespace: '00c0ffee00c0ffee',      // required, 8-byte hex namespace
  endpoint: 'http://localhost:26658', // default
  authToken: process.env.CELESTIA_NODE_AUTH_TOKEN,
})
```

## API

### `DALayer` (interface) and `DACommitment`

```ts
interface DALayer {
  readonly name: string
  submit(data: Uint8Array): Promise<DACommitment>
  retrieve(commitment: DACommitment): Promise<Uint8Array>
  verify(commitment: DACommitment): Promise<boolean>
}
```

Implement this to add your own backend; consumers only see `DALayer`.

### `LocalDA`

In-memory, content-addressed blob store. `retrieve()` throws for unknown hashes; `verify()` returns `false` instead. Extras for tests: `nextBlock()` advances the reported height and resets the index, `size` counts stored blobs, `clear()` wipes everything. Resubmitting identical bytes reuses the same slot (content addressing).

### `CelestiaDA` / `CelestiaDAOptions`

Client for the Celestia Node REST API (`submit_pfb`, `namespaced_data`). `submit()` posts to your namespace and returns the inclusion height; `retrieve()` scans the namespace at that height for a blob matching the commitment hash; `verify()` is retrieve-and-rehash (network errors ⇒ `false`, not an exception). Options: `namespace` (required), `endpoint`, `authToken`.

### `EthBlobDA` / `EthBlobDAOptions`

The stub. Options (`rpcUrl`, `beaconUrl`, `chainId`) are accepted and stored; `submit`/`retrieve`/`verify` throw with step-by-step implementation requirements. Read the source of `eth-blobs.ts` for a complete viem-based sketch.

### `encode(data)` / `decode(data)`

3-byte magic header (`RJC` compressed / `RJR` raw) + payload. Compression is used only when fflate is available **and** actually shrinks the payload. `decode()` throws on missing/unknown magic and on compressed data without fflate.

## Wiring DA into a validator

`ValidatorNode` (in `@johnhenry/raijin-validator`) does not post blocks to a DA layer yet — the pipeline is yours to call, and the natural place is a block-finalization handler:

```js
node.onBlockFinalized(async (block) => {
  const bytes = serializeBlock(block)          // your serialization
  const commitment = await da.submit(await encode(bytes))
  await commitmentStore.save(block.header.number, commitment)
})
```

Keep the commitment next to the block number; that pair is what a later reader needs to `retrieve()` and `verify()`. And remember the scoping above — storing the commitment proves nothing by itself; verification happens at read time, against whatever the backend still serves.

## Provenance

Previously published unscoped as [`raijin-da`](https://www.npmjs.com/package/raijin-da): `0.0.1` (initial release, 2026-03-15), then `0.0.2` (2026-07-16 — published with a broken build, because the release workflow used plain `npm publish`, which does not rewrite `workspace:*` internal dependency specifiers into real resolved versions; that tarball was unpublished), then `0.0.3` (2026-07-16, same day — republished correctly via `pnpm publish`, the last unscoped version, live until this move).

Moved into the `@johnhenry` npm scope and restarted at `0.0.0` — no functional changes in the move. The `workspace:*` publish bug can no longer recur: the monorepo has since converted to npm workspaces with real semver ranges, and releases go out via `npm publish --workspaces`. See the [root CHANGELOG](https://github.com/johnhenry/raijin/blob/main/CHANGELOG.md) for the full project history.

## License

MIT
