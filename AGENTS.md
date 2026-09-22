# Agent playbook

npm workspaces monorepo, 7 packages under `packages/`, Node >= 26, `vitest`
for tests, orchestrated with Turborepo. Six packages publish to npm under
`@johnhenry/raijin-*`; the seventh, `raijin-test-harness`, is `private: true`
and never published — see its own section below.

`CLAUDE.md` in this directory is a symlink to this file.

## Workspace structure and build order

Packages are declared in `package.json`'s `workspaces` glob (`packages/*`);
Turborepo resolves the real build order from each package's own
dependencies (`dependsOn: ["^build"]` in `turbo.json`), not from array
order. Dependency order, leaf first:

| Package | Role |
| --- | --- |
| [`raijin-core`](packages/core) | State machine, blocks, transactions, Merkle roots. Zero external dependencies — only `globalThis.crypto.subtle`. Every other package depends on this one. |
| [`raijin-consensus`](packages/consensus) | PBFT consensus engine with leader rotation, view changes, and vote authentication. |
| [`raijin-mempool`](packages/mempool) | Transaction pool with fee-based ordering and eviction. |
| [`raijin-da`](packages/da) | Data availability abstraction (Celestia, ETH blobs), with bounded decompression. |
| [`raijin-validator`](packages/validator) | Composition root wiring core + consensus + mempool + da. |
| [`raijin-sdk`](packages/sdk) | Developer-facing client API (`Wallet`, transaction building). |
| [`raijin-test-harness`](packages/test-harness) | Multi-validator integration test utilities; `private: true`, unscoped, never published. |

## The verification loop (before every push)

Build must run before test or typecheck — Turbo's `test`/`typecheck` tasks
declare `dependsOn: ["build"]`, so a stale or missing build produces
misleading failures that look like real bugs, not build-order noise.

```bash
npm run build       # turbo run build, dependency order via ^build
npm run test        # turbo run test, dependsOn: ["build"]
npm run typecheck   # turbo run typecheck
npm run examples    # the seven numbered walkthroughs, single-node by design
```

CI (`.github/workflows/ci.yml`) runs install, build, test, typecheck, then
an "Examples smoke test" step, in that order. Match it locally before
pushing. Don't build a single package in isolation and assume it's safe — a
change to `raijin-core` can silently break `consensus`/`mempool`/`da`/
`validator`/`sdk`, all of which depend on it.

A genuinely fresh clone before a release:
`git clone . /tmp/raijin-verifyN && cd $_ && npm ci && npm run build && npm test`.

## Repo-specific gotchas

- **`raijin-test-harness` (`packages/test-harness`) is unpublished and
  known-flaky.** Its 27 multi-node tests reach into
  `../../consensus/test/helpers.ts` and drive timing-sensitive scenarios;
  flakiness there under load is expected and not automatically a
  regression — rerun in isolation before concluding otherwise. The 230
  tests in the six publishable packages are deterministic and are the ones
  that must be clean.
- **Dependency layering**: `raijin-sdk` → `raijin-validator` → (
  `raijin-consensus`, `raijin-mempool`, `raijin-da`) → `raijin-core`.
  `raijin-core` has zero external dependencies (only
  `globalThis.crypto.subtle`) — don't add any.
- **Quorum safety is load-bearing, not a style choice.** `n - f` with
  `f = floor((n - 1) / 3)` only tolerates a fault when `n >= 4`; below that
  every validator must be online and honest. If you touch consensus math,
  re-run `packages/consensus/test/validator-set.test.ts` and the Byzantine
  suite (`packages/consensus/test/byzantine.test.ts`) — don't just trust
  the type system.
- **No per-package `CHANGELOG.md` or `LICENSE`.** This repo's convention is
  root-only (`CHANGELOG.md`, `LICENSE` at the repo root); don't add
  per-package copies — keep documenting version history in the root file.
- **Packages restarted at `0.0.x`** after moving from unscoped npm names
  (`raijin-core`, etc.) to the `@johnhenry` scope — see the README's
  provenance note. `0.0.0` and earlier unscoped versions are unsafe
  (unverified quorum, unverified vote signatures); don't treat old
  version numbers as a maturity signal.
- **The published npm package name doesn't match the package directory.**
  `packages/core` publishes as `@johnhenry/raijin-core`,
  `packages/consensus` as `@johnhenry/raijin-consensus`, and so on — the
  directory name is the suffix after `raijin-`, not the full package name.
  Don't assume directory name == package name when wiring dependencies or
  docs links.
- **A `workspace:*` protocol string left unresolved by a hand-rolled
  publish loop is how the original unscoped `0.0.1` releases shipped
  uninstallable outside this repo (`EUNSUPPORTEDPROTOCOL`), and how a later
  `0.0.2` had to be republished as `0.0.3`.** The move from pnpm to npm
  workspaces (see CHANGELOG's `0.0.0` entry) closed this permanently —
  internal dependencies are now real semver ranges (`^0.0.x`) in
  `package.json`, not a `workspace:*` protocol string, so there is nothing
  left to forget to rewrite at publish time. A future change to the publish
  mechanism (see Releases below) should still verify a packed tarball's
  `package.json` has real versions, not assume it.

## New-package definition of done

Adding a package under `packages/` means all of the following, not just
`npm init`:
- `tsconfig.json` matching an existing package's shape, and an entry added
  to `turbo.json`'s task graph if the package needs build/test/typecheck
  ordering relative to its dependencies.
- The package's directory picked up automatically by the `packages/*`
  workspace glob — no array to edit — but it must still be added to any
  root script that enumerates packages by name (there is currently none;
  `npm run build`/`test`/`typecheck` all delegate to Turborepo, which
  discovers workspaces itself).
- `README.md` with the badge row (npm-version + license only — CI is a
  repo-level fact carried on the root README), provenance note if applicable,
  and Contents/API sections matching a sibling package's shape.
- `CHANGELOG.md` entry in the **root** file, not a new per-package one (see
  gotchas above).
- `"engines": { "node": ">=26.0.0" }` matching the root.
- If the package is publishable, add a `publish_if_new` call for it in
  `.github/workflows/publish.yml`, **in dependency order** — the publish
  step is a staggered per-package loop, not `npm publish --workspaces`, and
  publishing a dependent before its dependency fails or resolves a stale
  version (see Releases below). Mark internal-only packages
  `"private": true` instead, which npm's publish step already skips.

## Non-goals

Multi-node scenario testing is deliberately kept out of the six publishable
packages' own test suites — that's what `raijin-test-harness` is for. Don't
add cluster-level tests to `packages/consensus/test/` or similar; add them
to the harness instead, even though its flakiness under load is a known,
accepted cost of that separation.

## Releases

`npm run build && npm run test && npm run typecheck`, bump the affected
packages' `version` fields (and every internal `^0.0.x` dependency range
that depends on them, in the same change — see the CHANGELOG's `0.0.1`
Housekeeping entry for why a version-only bump without the range bump
installs the old, unfixed core alongside the new packages), add the root
`CHANGELOG.md` entry, merge, then `gh release create v<version>` — the
release event triggers `.github/workflows/publish.yml`.

That workflow does **not** use `npm publish --workspaces` — it calls a
`publish_if_new` function once per package, **in explicit dependency
order** (`core`, `consensus`, `mempool`, `da`, `sdk`, `validator`), because
`npm publish --workspaces` iterates alphabetically and `consensus` would
try to publish before its `raijin-core@^0.0.x` dependency exists on the
registry. Each call is individually guarded by an `npm view <name>@<version>`
pre-flight check, so the workflow is safe to re-run (or trigger via
`workflow_dispatch` to verify the token) even when nothing changed.
`raijin-test-harness` has no `publish_if_new` call and is never published.
Adding a new publishable package means adding its call **in the right
position** in that dependency-ordered list, not appending it at the end.
