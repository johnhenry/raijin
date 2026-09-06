# Changelog

## 0.0.2 (2026-09-06)

**`@johnhenry/raijin-consensus`**

- **Full prepared-certificate carry-over on view change.** `#doViewChange`
  previously only guarded against a *conflicting* re-proposal at a sequence
  that was already validly prepared in a prior view (`#preparedCert`); it
  could not get the original block re-proposed, so a view change stalled
  progress even when the new leader itself had prepared the block. The new
  leader now automatically re-proposes the block it already prepared (kept
  in the new `#preparedBlock` map, alongside `#preparedCert`) the moment it
  becomes leader — no external `propose()` call needed. A new leader with no
  certificate for the sequence (never having seen the round) still falls
  back to normal block production, and the existing conflict guard is
  unchanged. See `packages/consensus/test/byzantine.test.ts` — "a new leader
  that already prepared the block automatically re-proposes and finalizes
  it".

**`@johnhenry/raijin-validator`**

- No code change. Version bump only, to pull in the fixed
  `@johnhenry/raijin-consensus@^0.0.2`.

**`raijin-test-harness`** (internal, unpublished)

- `SeededPRNG.next()` now returns the high 53 bits of the xorshift128+ word
  instead of the low 53 bits — the low bits of xorshift128+ fail linearity
  tests that the high bits pass, which is the standard reason to avoid them
  in a float generator.
- Added test coverage for `removeDelay` and `resetFaults`, previously
  unexercised by any test.

## 0.0.1 — the first release that is safe to run (2026-09-04)

All six published packages, together. **Upgrade from `0.0.0`.**

`0.0.0` and every unscoped release before it (`raijin-core@0.0.1`,
`raijin-consensus@0.0.3` and siblings) shipped a consensus engine that
collected vote signatures without ever verifying one, finalized on a quorum
that degenerates to a single node at two or three validators, and derived its
block hashes, Merkle roots and state roots from encodings that two different
structures could share. Those are not hardening opportunities; they are the
properties the library exists to provide, and they were absent. This release
supplies them. It is the first version of Raijin anyone should install.

### Can I keep my data? No.

This is a hard break, from a fresh genesis. Every format Raijin hashes or
signs changed: vote payloads, Merkle roots, the block header, the state key,
the transaction, account, receipt and state-entry encodings, and the state
root. Account records written by an earlier build are stored under keys an
upgraded node does not look up, and would be rejected by `decodeAccount` if it
found them. There is no state-format converter. Discard persisted state and
re-seed genesis balances.

### Can my nodes talk to nodes on 0.0.0? No.

There is no compatibility mode and no negotiation. A 0.0.1 node and a 0.0.0
node compute different block digests (so PRE-PREPARE is rejected as a digest
mismatch), different vote payloads (so every signature verification fails),
and different state roots (so even agreement on a block would leave them on
divergent chains). Stop every node and upgrade them together — a partial
upgrade is worse than a stopped network, because each half considers the
other's blocks invalid. Clients that sign transactions must be upgraded too.

[`MIGRATION.md`](./MIGRATION.md) has the format-by-format inventory, the API
breaks, and the operator checklist.

### Security fixes

**Consensus.**

- **Vote signatures are verified.** PRE-PREPARE, PREPARE, COMMIT and
  VIEW-CHANGE are checked against the claimed sender before they count toward
  anything. Previously they were collected and never verified, so any peer
  that could reach the message handler could forge votes on behalf of any
  validator. `PBFTConfig.verify` is now a required field; there is no
  unverified mode.
- **Each signature is bound to exactly one use.** A vote is signed over
  `voteDigest({ phase, chainId, epoch, view, sequence, digest })`. Signing the
  bare digest meant a PREPARE — broadcast to every peer — *was* a valid COMMIT
  from the same validator, so the commit phase proved nothing; and a signature
  not covering view/sequence could be lifted into a later round unchanged.
  `chainId` stops one deployment's votes being counted by another. `epoch`, a
  digest of the exact validator set and order, stops a removed validator's
  still-valid signatures counting toward the quorum of the set that removed
  them.
- **The quorum is `n - f`, not `2f + 1`.** `2f + 1` is only safe at
  `n = 3f + 1`; at `n = 2` or `n = 3` it degenerates to `q = 1`, letting one
  node reach its own PREPARE and COMMIT quorum and finalize blocks alone.
  `n - f` satisfies the overlap condition `2q - n >= f + 1` at every validator
  count.
- **Views only move forward.** A VIEW-CHANGE signature covers nothing
  time-bound, so a recorded quorum stays valid forever; replaying one used to
  rewind the view and clear every in-flight round, indefinitely, with no keys
  required. VIEW-CHANGE messages are also deduplicated by sender, and NEW-VIEW
  is honoured only when backed by a real quorum of validly-signed,
  distinct-sender VIEW-CHANGEs.

**Encoding — swept as a class, not case by case.** Two rules now hold
everywhere: every variable-length field carries its length, and every distinct
structure carries a domain tag.

- Domain tags `0x01`–`0x07` across `encodeTx`, `encodeTxSigned`,
  `encodeAccount`, `encodeReceipt`, `encodeBlockHeader`, `encodeStateEntry`
  and state keys. `decodeAccount` rejects anything not tagged as an account
  rather than misreading it.
- `merkleRoot` commits uniquely to its leaf list: `0x00`/`0x01` leaf and node
  tags, and an odd level promotes its last node instead of duplicating it.
  Without both, `[A, B, C]` and `[A, B, C, C]` produce the same root
  (CVE-2012-2459), so a block's `txRoot` did not uniquely commit to its
  transactions. A lone leaf was also returned unhashed, making "root" and
  "leaf" the same value at n = 1.
- `InMemoryStateStore.root()` is a Merkle tree over domain-tagged, fully
  length-prefixed entries, ordered by key bytes. It was `H(key₀ ‖ value₀ ‖ …)`
  with no prefixes and `localeCompare` ordering — so a store holding key
  `0xab` with value `"cd"` and one holding key `0xabcd` with an empty value
  produced the same root, and two runtimes could order identical state
  differently.
- State keys are `0x07 ‖ len(ns) ‖ ns ‖ len(id) ‖ id`. The bare
  `namespace ‖ id` concatenation they replace was unambiguous only by
  coincidence — the shipped namespaces happen to be prefix-free and every id
  happens to be 32 bytes, and nothing enforced either. Use the new
  `accountKey`/`stateKey` exports rather than building keys by hand.
- `u64()` throws on out-of-range input instead of silently truncating to the
  high 8 bytes, which let two different block numbers encode identically.
- `parentHash` is the parent's canonical block hash,
  `blockHash(parent) = H(encodeBlockHeader(parent.header))`, exported. It was
  the parent's *state root*, which commits to the resulting account state and
  nothing else — not the transactions, proposer, timestamp or roots — so any
  two blocks leaving the same post-state were indistinguishable as parents,
  and an empty block's child pointed at a hash equal to the block's own.
- Block `stateRoot` and `receiptRoot` are computed after execution instead of
  being left as zero-filled placeholders forever.

**Data availability.**

- `CelestiaDA` no longer sends its auth token over cleartext `http:` to a
  non-loopback host (the token is a node credential and usually carries write
  access); opt back in with `allowInsecureAuth`. The caller-supplied namespace
  is percent-encoded so it cannot rewrite the request path and carry the token
  to a different route.
- Its base64 encoder is chunked, so blobs above 64 KiB survive instead of
  overflowing the call stack.
- `decode()` caps decompressed output at 16 MiB. DA bytes are untrusted by
  definition and DEFLATE reaches roughly 1000:1, so a few kilobytes could ask
  for gigabytes. The compressed frame now declares its decompressed length,
  which is checked *before* inflating and then used as a hard bound on the
  inflater. Rejections are `DADecodeError` / `DASizeLimitError` rather than
  whatever the compression library threw.

**SDK.**

- `Wallet` signs the `Uint8Array` view rather than its backing `ArrayBuffer` —
  a view into a larger buffer previously signed the whole buffer.
- Keys are non-extractable by default on `fromKey()` as well as `generate()`.
  `fromKey` is the persistence path, where a stored key comes back, so
  importing extractable by default quietly undid the `generate()` default for
  exactly the keys that live longest.
- `chainId` is required when building a transaction, with no default.

**Validator.**

- `ValidatorNode` runs the real fee-ordered, signature-verifying mempool from
  `@johnhenry/raijin-mempool` instead of an unvalidated FIFO queue.
  `submitTransaction()` now rejects a bad signature or a duplicate
  sender+nonce outright rather than accepting it and reverting it a block
  later. `@johnhenry/raijin-validator` re-exports that class; its own is gone.
- The canonical transaction id is the signed encoding everywhere — receipt
  `txHash`, `txRoot` leaves, mempool keys.

### Tests

251 → 254 across the seven workspace packages, 229 of them in the six
published ones. The new coverage is adversarial rather than incidental: a
Byzantine harness with an equivocating proposer and a vote replayed across
phases, both proven non-vacuous by injection — restoring the `2f + 1` quorum
produces a real fork, with two distinct blocks finalized across honest
replicas, and unbinding a vote's phase lets a block finalize on a manufactured
commit quorum.

### Documentation

Every README claim was re-checked against the code, and the ones this work
falsified were corrected rather than deleted — including
`packages/consensus/README.md`'s "the signatures carried on COMMIT messages
are collected, not verified; authentication is your transport's job," which
had become false in the most dangerous direction: it told a reader not to rely
on a guarantee the code now makes. Its replacement states what the engine
authenticates and what the transport still owes (delivery, Sybil resistance,
the membership list, and the correctness of the injected verifier). The
quorum tables, the `2f + 1` arithmetic, the `parentHash` semantics, the
`chainId` default, the receipt-`txHash` encoding and the two-`Mempool` story
were all stale in the same way and are now accurate.

### Housekeeping

- All six published packages `0.0.0` → `0.0.1`, with every internal dependency
  range moved `^0.0.0` → `^0.0.1` in the same change. `0.0.1` does not satisfy
  `^0.0.0`, and all six are already published at `0.0.0`, so a version-only
  bump would have installed the old, vulnerable core alongside the new
  packages. `raijin-test-harness` is `private: true` and stays at `0.1.0`.

### Development log — the encoding pass (2026-09-04)

Every format Raijin hashes or signs changed: vote payloads, Merkle roots, the
block header, state keys, the transaction, account, receipt and state-entry
encodings, and the state root. A node running these changes cannot talk to one
that isn't — different digests, different signatures, different roots.

Vote payloads changed twice: first to cover the phase, view and sequence, and
then again to cover the **chain id** and a **validator-set epoch**, so that a
vote cannot be replayed onto a different deployment or counted across a
membership change. `voteDigest()` now takes a single object, and `chainId` is
required — with no default — on `PBFTConfig` and `ValidatorNodeConfig`.

Two more unsafe defaults closed alongside them: `Wallet.fromKey()` imports
non-extractable keys unless the call site asks otherwise (it previously
hardcoded extractable, on the path persisted keys come back through), and
`@johnhenry/raijin-da`'s `decode()` caps decompressed output at 16 MiB
instead of running an unbounded `inflateSync` over untrusted DA bytes.

**See [`MIGRATION.md`](./MIGRATION.md)** for the format-by-format inventory
and the upgrade checklist. The short version: upgrade every node at once,
from a fresh genesis, and discard persisted state (account records written by
an earlier build no longer decode).

### Development log — documentation overhaul + runnable examples (2026-08-25)

Documentation only, plus example scripts and a CI smoke step — no library
source changes.

> Several "sharp edges" this pass documented were *fixed* later in the same
> release and no longer describe 0.0.1: the quorum below four validators, the
> two `Mempool` classes, and the zeroed roots in produced headers. The
> READMEs were re-checked claim by claim before release; see "Documentation"
> above.

- **All six per-package READMEs rewritten** from provenance-only stubs into
  real API documentation: full export surface with signatures, quick starts,
  and the sharp edges up front (PBFT quorum = 1 below 4 validators; the two
  unrelated `Mempool` classes in `raijin-mempool` vs `raijin-validator`; the
  8-byte fee convention colliding with the tx-type byte; what a
  `DACommitment` does and doesn't prove; `encode()`'s optional-fflate
  dependency; zeroed `stateRoot`/`receiptRoot` in produced headers). The
  provenance notes are kept, with the stale "publish.yml now uses pnpm
  publish" line updated to reflect the npm-workspaces conversion.
- **Root README**: new section documenting the internal `raijin-test-harness`
  package (what it provides, why it stays unpublished) and a pointer to the
  new examples.
- **`examples/`**: seven numbered, self-checking walkthroughs
  (`01-hashing-merkle` … `07-sdk-end-to-end`) with an `examples/README.md`.
  Root scripts `example:01`–`example:07` run them individually and
  `examples` runs the loop. All are single-node by design so they're
  deterministic; multi-node scenarios remain in `raijin-test-harness` and
  are excluded on purpose (documented in `examples/README.md`).
- **CI**: `.github/workflows/ci.yml` gains an "Examples smoke test" step
  running `npm run examples` after build/test/typecheck.

### Development log — npm workspaces + Turborepo (2026-08-25)

Converts the monorepo's package manager from pnpm to plain `npm` workspaces,
standardizing on the same tooling as the rest of the `@johnhenry` family
(matching the `ai.matey` precedent). Turborepo (`turbo.json`) is unchanged —
it already orchestrated `build`/`test`/`typecheck`/`clean` and needed no
edits, since Turborepo's task graph is package-manager-agnostic and resolves
npm workspace `name`-based linking the same way it resolved pnpm's.

- `pnpm-workspace.yaml` and `pnpm-lock.yaml` removed; the `packages/*` glob
  moved into root `package.json`'s new `workspaces` field. `package-lock.json`
  is now the committed lockfile.
- Every internal `"workspace:*"` dependency (pnpm's protocol, with no npm
  equivalent) became a real semver range, `^0.0.0`, matching only the
  packages' current `0.0.0` version per the family's version-restart
  convention. This also means the `workspace:*`-rewrite bug documented below
  (the reason `0.0.2` had to be republished as `0.0.3`) cannot recur under
  npm — there is no protocol string left to forget to rewrite.
- `packageManager: "pnpm@9.15.0"` replaced with `"npm@10.0.0"`, matching
  `ai.matey`'s root manifest. Turborepo 2.x also requires this (or
  `devEngines.packageManager`) to resolve the workspace at all — `turbo run
  build` fails outright with "Could not resolve workspace" if it's absent.
- `raijin-test-harness` marked `"private": true` — it was already excluded
  from the old per-package publish loop by not being named in it, but
  `npm publish --workspaces` publishes every non-private workspace member,
  so it now needs the flag explicitly to stay unpublished.
- `.github/workflows/ci.yml` and `.github/workflows/publish.yml`: dropped
  `pnpm/action-setup`, `pnpm install --frozen-lockfile` → `npm ci`,
  `pnpm build`/`test`/`typecheck` → `npm run build`/`test`/`typecheck`
  (both already ran through root scripts that call `turbo run ...`, so no
  script content changed, only the invoking package manager). `publish.yml`'s
  per-package `pnpm --filter <pkg> publish --access public --no-git-checks`
  loop replaced with a single `npm publish --workspaces --access public`,
  which publishes all 6 scoped packages and skips `raijin-test-harness`
  (private). `actions/setup-node` gained `cache: 'npm'` — safe here since CI
  runs on `ubuntu-latest`, not self-hosted runners.
- README's install/build/test/typecheck/clean examples updated to their
  `npm` equivalents.

## 0.0.0 — npm scope migration (2026-08-25)

All six publishable packages move into the `@johnhenry` npm scope and
restart at `0.0.0` (a new address is a new era). This is a rename + CI fix
only — no source changes.

| New name | Old name | Last unscoped version(s) |
|---|---|---|
| `@johnhenry/raijin-core` | `raijin-core` | `0.0.1` only — published 2026-03-15 as part of the `v0.1.0` initial release; never needed a republish because it has no internal `workspace:*` dependency to leak |
| `@johnhenry/raijin-consensus` | `raijin-consensus` | `0.0.1` (2026-03-15) → `0.0.2` (2026-07-16, broken, unpublished — see below) → `0.0.3` (2026-07-16, corrected, last published) |
| `@johnhenry/raijin-mempool` | `raijin-mempool` | same history as `raijin-consensus` |
| `@johnhenry/raijin-da` | `raijin-da` | same history as `raijin-consensus` |
| `@johnhenry/raijin-validator` | `raijin-validator` | same history as `raijin-consensus` |
| `@johnhenry/raijin-sdk` | `raijin-sdk` | same history as `raijin-consensus` |

`raijin-test-harness` is unaffected: it stays unscoped and unpublished
(internal integration-test utilities only). Its internal dependencies now
point at the renamed `@johnhenry/raijin-*` packages via `workspace:*`, same
as before.

This migration also fixes, for real, the bug that produced the `0.0.2` →
`0.0.3` republish documented below: `.github/workflows/publish.yml`
published with plain `npm publish` in a loop over `packages/*`, which does
NOT rewrite `workspace:*` protocol specifiers into resolved versions before
publishing — the same defect that made the original `0.0.1` releases (and
then `0.0.2`) uninstallable outside this workspace with
`EUNSUPPORTEDPROTOCOL`. The `0.0.3` releases only worked because they were
published by hand with `pnpm publish` as a workaround. The workflow now runs
`pnpm --filter <pkg> publish --access public --no-git-checks` per package
instead, so this can't regress again on the next scoped release. The
workflow's `|| true` around the publish loop and `continue-on-error: true`
on the test step have also been removed — a publish gate that can't fail on
broken tests or a failed publish isn't a gate.

CI's Node version and the packages' declared `engines.node` are also
reconciled: CI pinned Node 22 while `engines.node` required `>=24.0.0` (a
gap opened in March 2026, commit `4f9ef5d`, to work around a Vitest
incompatibility that was never revisited). Re-tested on Node 24.9.0 as part
of this migration: install, build, all 134 tests, and typecheck are clean —
the original incompatibility no longer reproduces — so CI now runs Node 24,
matching `engines`.

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
