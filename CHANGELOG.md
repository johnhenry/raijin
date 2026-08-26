# Changelog

## Unreleased — documentation overhaul + runnable examples (2026-08-25)

Documentation only, plus example scripts and a CI smoke step — no library
source changes.

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

## Unreleased — npm workspaces + Turborepo (2026-08-25)

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
