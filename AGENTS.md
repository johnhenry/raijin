# Agent playbook

Short rulebook for anyone (human or agent) working in this repo. Modeled on
the pattern established in `math-plus`'s `AGENTS.md`.

## The verification loop (before considering anything done)

1. `npm run build` — Turbo (`turbo.json`) builds packages in dependency
   order via `dependsOn: ["^build"]`. Don't build a single package in
   isolation and assume it's safe; a change to `raijin-core` can silently
   break `consensus`/`mempool`/`da`/`validator`/`sdk` that depend on it.
2. `npm run test` — Turbo runs `test` with `dependsOn: ["build"]`, so tests
   always exercise freshly built output, not stale `dist/`.
3. `npm run typecheck`.
4. `npm run examples` — the seven numbered walkthroughs in `examples/` are
   a CI smoke step, deliberately restricted to single-node scenarios (see
   `examples/README.md`).
5. Only then commit/push.

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
