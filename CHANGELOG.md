# Changelog

## 0.0.2 — raijin-consensus, raijin-mempool, raijin-da, raijin-sdk, raijin-validator (2026-07-16)

Fixes a real installability bug found while wiring `raijin-consensus` into
an external consumer (Clawser's `ClawserPod.initMesh`): the 0.0.1 tarballs
published to npm for these 5 packages shipped their internal
`raijin-core`/`raijin-consensus` dependency as the literal string
`"workspace:*"` instead of a real resolved version — a `workspace:*`
reference is only meaningful inside this pnpm workspace, so any external
`npm install` of these packages failed with `EUNSUPPORTEDPROTOCOL`.

No source or dependency-string changes were needed (`pnpm pack`/`pnpm
publish` already rewrite `workspace:*` to the real resolved version
correctly, verified by inspecting the packed tarball's package.json) — the
original 0.0.1 releases were evidently published with something else (e.g.
plain `npm publish` inside each package directory) that skipped this
rewrite. This is a version bump only, republished via `pnpm publish` (or
`pnpm -r publish --filter ...`) to produce a correctly-rewritten tarball.
Verified end-to-end: packed all 5 with `pnpm pack`, confirmed each tarball's
package.json has real versions (not `workspace:*`), and `npm install`ed all
5 tarballs together into a scratch project with zero errors.

## 0.1.0 (2026-03-15)

Initial release of the Raijin mesh rollup framework.

### Packages

- **raijin-core** — State machine, blocks, transactions, Merkle roots, state store interface
- **raijin-consensus** — PBFT consensus engine with leader rotation and view changes
- **raijin-mempool** — Transaction pool with fee-based ordering and eviction
- **raijin-da** — Data availability abstraction with pluggable backends (Celestia, ETH blobs)
- **raijin-validator** — Composition root wiring core, consensus, and mempool into a runnable validator
- **raijin-sdk** — Developer-facing client API for submitting transactions and querying state
- **raijin-test-harness** — Multi-validator integration test utilities
