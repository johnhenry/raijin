# Raijin examples

Runnable, self-checking walkthroughs of the six publishable packages. Each one is a plain Node ES module that prints what it's doing and asserts the results — if it exits 0, everything it claims actually happened.

## Prerequisites

```bash
npm ci
npm run build   # examples import the built packages via workspace links
```

Node ≥ 24 (example 07 uses Web Crypto Ed25519).

## The examples

| # | File | Shows |
| --- | --- | --- |
| 01 | `01-hashing-merkle.mjs` | `@johnhenry/raijin-core` hashing: SHA-256, Merkle roots (leaf/node domain tags, odd levels promoted rather than duplicated, order sensitivity), hex round-trips |
| 02 | `02-state-machine.mjs` | `StateMachine` + `InMemoryStateStore`: genesis funding via `accountKey`, a successful transfer, insufficient-balance and nonce-mismatch revert receipts |
| 03 | `03-mempool-ordering.mjs` | `@johnhenry/raijin-mempool`: the 8-byte fee convention, fee-descending ordering, strict-inequality eviction, duplicate rejection |
| 04 | `04-da-local.mjs` | `@johnhenry/raijin-da`: `encode`/`decode` frame headers, `LocalDA` submit/retrieve/verify, what commitment verification does and doesn't prove |
| 05 | `05-consensus-round.mjs` | `@johnhenry/raijin-consensus`: the `n - f` quorum table (n=1..7), asserted safe at every size, then a full single-validator PBFT round from `propose()` to finalization |
| 06 | `06-validator-lifecycle.mjs` | `@johnhenry/raijin-validator`: a one-node chain with real timers — submit, block production, finalization, mempool pruning, clean stop |
| 07 | `07-sdk-end-to-end.mjs` | `@johnhenry/raijin-sdk`: `Wallet` (real Ed25519) → `RaijinClient` → in-process `ValidatorNode`, including a tampered transaction rejected by the mempool before it can reach a block |

Run one:

```bash
npm run example:06
```

Run all:

```bash
npm run examples
```

## Why every example is single-node

All seven examples run one validator in one process, on purpose. At n = 1 the quorum is 1 (see example 05 — it is the only validator count where that holds), so consensus completes deterministically with no cross-node timing, which makes these examples safe to run in CI as a smoke test (`npm run examples` is a CI step).

Multi-node scenarios (leader crashes, partitions, gossip convergence, membership churn) are exercised by the internal `raijin-test-harness` package instead. Those tests coordinate several nodes over a simulated network and are timing-sensitive — they are deliberately **excluded** from the examples loop and the CI smoke step so a scheduling hiccup can't fail an unrelated change. Run them directly with `npm run test -w raijin-test-harness` if you want them.
