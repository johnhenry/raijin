# Raijin

Full documentation: [opensource.johnhenry.me/raijin](https://opensource.johnhenry.me/raijin/)

A browser-native mesh rollup framework. Build sovereign rollups where
the users ARE the validators.

## What is this?

Raijin is a modular rollup framework that runs entirely in the browser.
No Go sequencer. No Rust node. No Docker. Users visiting your web app
form a P2P consensus network and produce blocks together.

Think of it as the OP Stack, but for browsers.

## Packages

| Package | Description |
|---------|-------------|
| [`@johnhenry/raijin-core`](packages/core) | State machine, blocks, transactions, Merkle roots |
| [`@johnhenry/raijin-consensus`](packages/consensus) | PBFT consensus engine with leader rotation and view changes |
| [`@johnhenry/raijin-mempool`](packages/mempool) | Transaction pool with fee-based ordering and eviction |
| [`@johnhenry/raijin-da`](packages/da) | Data availability abstraction (Celestia, ETH blobs) |
| [`@johnhenry/raijin-validator`](packages/validator) | Composition root wiring core + consensus + mempool |
| [`@johnhenry/raijin-sdk`](packages/sdk) | Developer-facing client API |
| `raijin-test-harness` | Multi-validator integration test utilities (internal, unpublished) |

> **Provenance:** the six publishable packages above were previously
> published unscoped (`raijin-core`, `raijin-consensus`, etc.) and now live
> under the `@johnhenry` npm scope, restarting at `0.0.0`. See
> [CHANGELOG.md](CHANGELOG.md) for exact prior versions per package.

## Quick Start

```bash
npm install
npm run build
npm run test
npm run examples   # run the numbered walkthroughs in examples/
```

## Examples

[`examples/`](examples) contains seven numbered, self-checking walkthroughs —
hashing/Merkle roots, the state machine, mempool fee ordering, data
availability, a PBFT consensus round, the validator node lifecycle, and an
SDK end-to-end run against an in-process node. Each runs standalone
(`npm run example:01` … `example:07`) or all together (`npm run examples`,
also a CI smoke step). See [examples/README.md](examples/README.md) — and
note why they're all deliberately single-node.

## Architecture

```
raijin-sdk          (client API)
    |
raijin-validator    (composition root)
    |
    +-- raijin-consensus  (PBFT + leader rotation)
    +-- raijin-mempool    (tx ordering)
    +-- raijin-da         (data availability)
    |
raijin-core         (state machine, blocks, transactions)
```

All packages are transport-agnostic, storage-agnostic, and identity-agnostic.
The framework accepts any signing function, any key-value store, and any
network transport (WebRTC, WebSocket, libp2p, etc.).

## The test harness (`raijin-test-harness`)

The seventh workspace package is internal test infrastructure, not a
library — it's `private: true`, unscoped, and never published. It exists
because the unit tests above only ever exercise one node at a time, and
consensus bugs live between nodes.

What it provides:

- **`TestOrchestrator`** — spins up a cluster of `RaijinTestNode`s (real
  `ValidatorNode`s, not mocks) on a shared `PartitionableNetwork` and
  `MockTimer`, with two-phase setup so every node sees the same validator
  set.
- **`PartitionableNetwork` / `SeededPRNG`** — an in-memory transport that
  can partition, heal, and (seeded) randomize delivery to reproduce
  distributed failure modes deterministically-ish.
- **Checkers** — invariant assertions run across the whole cluster after a
  scenario: `NoForkChecker`, `BalanceConsistencyChecker`,
  `EventLogIntegrityChecker`, `GossipConvergenceChecker`.
- **Workloads** — reusable scenario drivers (`ConsensusBlockWorkload`,
  `CreditTransferWorkload`, `MembershipChurnWorkload`) plus an
  `EventCollector`/`ReportGenerator` timeline for post-mortem output.

Why it stays unpublished: it reaches into `../../consensus/test/helpers.ts`
for its mock network/timer (a path that only exists in this repo), and its
multi-node tests are timing-sensitive by nature — the 11 harness tests are
known to be flaky under load, which is acceptable for internal scenario
testing but not something to ship. The 123 tests across the six publishable
packages are deterministic; CI's example smoke step is also restricted to
single-node scenarios for the same reason (see
[examples/README.md](examples/README.md)).

## Design Principles

- **Transport agnostic.** The rollup doesn't know about WebRTC.
- **Storage agnostic.** State uses a `StateStore` interface.
- **Identity agnostic.** Accepts any signing function.
- **Browser-first, not browser-only.** Works in Node.js too.
- **Zero server cost.** Your users' browsers are the infrastructure.

## Development

```bash
# Install dependencies
npm install

# Build all packages (uses Turborepo)
npm run build

# Run all tests
npm run test

# Run tests in watch mode (root vitest config)
npx vitest

# Type-check all packages
npm run typecheck

# Clean build artifacts
npm run clean
```

## Name

Raijin (雷神) -- the Japanese god of lightning, thunder, and storms.
Like lightning connecting sky to earth, Raijin connects browser peers
into a consensus network.

## License

MIT
