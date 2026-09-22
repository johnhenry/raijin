# Raijin

[![CI](https://github.com/johnhenry/raijin/actions/workflows/ci.yml/badge.svg)](https://github.com/johnhenry/raijin/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Fraijin-core.svg)](LICENSE)

Full documentation: [opensource.johnhenry.me/raijin](https://opensource.johnhenry.me/raijin/)

A browser-native mesh rollup framework. Build sovereign rollups where
the users ARE the validators.

## What is this?

Raijin is a modular rollup framework that runs entirely in the browser.
No Go sequencer. No Rust node. No Docker. Users visiting your web app
form a P2P consensus network and produce blocks together.

Think of it as the OP Stack, but for browsers.

## Contents

- [What is this?](#what-is-this)
- [Which package do I want?](#which-package-do-i-want)
- [Packages](#packages)
- [Quick Start](#quick-start)
- [Examples](#examples)
- [Architecture](#architecture)
- [The test harness (`raijin-test-harness`)](#the-test-harness-raijin-test-harness)
- [Validator-set size](#validator-set-size)
- [Security model](#security-model)
- [Design Principles](#design-principles)
- [Development](#development)
- [Name](#name)
- [License](#license)

## Which package do I want?

| I want to... | Start with |
|---|---|
| Run a full rollup node — validate blocks, run consensus, manage a mempool | [`raijin-validator`](packages/validator) — the composition root; wires core + consensus + mempool + da together |
| Submit transactions or query state from a client app, browser or Node | [`raijin-sdk`](packages/sdk) — `Wallet`, transaction building, the developer-facing API |
| Implement PBFT consensus directly, without the rest of the stack | [`raijin-consensus`](packages/consensus) — leader rotation, view changes, vote authentication; see its [Security model](packages/consensus/README.md#what-the-engine-authenticates-and-what-is-still-yours) section before choosing a validator count |
| Only need hashing, the state machine, blocks, or Merkle roots | [`raijin-core`](packages/core) — zero external dependencies; everything else depends on this one |
| Wire up data availability (Celestia, ETH blobs) | [`raijin-da`](packages/da) — bounded, size-checked decompression on untrusted DA bytes |
| Manage a fee-ordered transaction pool outside a full validator | [`raijin-mempool`](packages/mempool) |
| Write multi-node integration tests against a real cluster | [`raijin-test-harness`](packages/test-harness) — internal, unpublished; reaches into `consensus`'s test helpers, so it only works inside this repo |

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
> under the `@johnhenry` npm scope, where they restarted at `0.0.0`. See
> [CHANGELOG.md](CHANGELOG.md) for exact prior versions per package.

> **If you are on `0.0.0`, upgrade.** `0.0.1` is the first release of these
> packages that is safe to run: `0.0.0` and every unscoped version before it
> finalize blocks on an unsafe quorum, collect consensus vote signatures
> without verifying them, and derive block, state and Merkle roots from
> encodings that two different structures can share. `0.0.1` is a hard wire-
> format break with no compatibility mode — see [CHANGELOG.md](CHANGELOG.md)
> and [MIGRATION.md](MIGRATION.md).

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
multi-node tests are timing-sensitive by nature — the 27 harness tests are
known to be flaky under load, which is acceptable for internal scenario
testing but not something to ship. The 230 tests across the six publishable
packages are deterministic; CI's example smoke step is also restricted to
single-node scenarios for the same reason (see
[examples/README.md](examples/README.md)).

The harness also carries the Byzantine scenarios: an equivocating proposer
that sends two different blocks for one sequence, and votes replayed across
phases. Both were proven non-vacuous by injection — restoring the old
`2f+1` quorum produces a real fork across honest replicas, and unbinding a
vote's phase lets a block finalize on a manufactured commit quorum.

## Validator-set size

Quorum is `n - f` where `f = maxFaults = floor((n - 1) / 3)` (see
`ValidatorSet.quorumSize`/`maxFaults`, asserted in
`packages/consensus/test/validator-set.test.ts`). That formula is safe at
*any* `n`, but it only tolerates a fault when `n >= 3f + 1` with `f >= 1`,
i.e. **`n >= 4`**:

| `n` | `f` (tolerated faults) | quorum | notes |
|---|---|---|---|
| 1–3 | 0 | `n` | safety holds, but *every* validator must be online and honest — one crash or lie halts the cluster. `smoke.test.ts` / the 3-node `multi-block.test.ts` / `credit-transfer.test.ts` scenarios run here deliberately, as the happy-path/no-fault case. |
| 4–6 | 1 | `n - 1` | smallest configuration with real Byzantine tolerance. Every Byzantine test in `packages/consensus/test/byzantine.test.ts` and the 4-validator harness scenarios run at `n = 4`. |
| `3f + 1`+ | `f` | `n - f` | general case. |

There is no supported *upper* bound enforced in code; larger `n` has not
been load-tested here.

## Security model

Raijin's trust boundary is spread across three packages — consensus message
authentication, data-availability decoding, and SDK key handling — and this
section is the one place all three are stated together. The full detail on
consensus authentication lives in
[`packages/consensus/README.md`](packages/consensus/README.md#what-the-engine-authenticates-and-what-is-still-yours);
what follows here is the complete guarantee/responsibility split for the
framework as a whole, not a subset of it.

**What Raijin guarantees:**

- **Every consensus vote is verified before it counts.** PRE-PREPARE,
  PREPARE, COMMIT and VIEW-CHANGE are checked against the claimed sender
  through the `verify` (`SignatureVerifier`) you inject; a message that fails
  is dropped before it reaches any counter. `PBFTConfig.verify` is a required
  field — there is no unverified mode to fall back into.
- **Each vote signature is bound to exactly one use.** A vote is signed over
  `voteDigest({ phase, chainId, epoch, view, sequence, digest })`, so one
  signature authorizes exactly one phase, of one round, at one sequence, on
  one chain, under one validator set — a PREPARE cannot double as a COMMIT,
  and a validator removed from the set (`epoch` changes) stops counting
  toward future quorums even with an old, still-valid signature.
- **The quorum is `n - f`, not `2f + 1`.** `2f + 1` degenerates to a
  single-node quorum at `n = 2` or `n = 3`; `n - f` satisfies the overlap
  condition `2q - n >= f + 1` at every validator count (see
  [Validator-set size](#validator-set-size) above). Views only move forward —
  a replayed VIEW-CHANGE quorum cannot rewind an in-flight round.
- **Decompressed DA payloads are bounded before they're trusted.**
  `@johnhenry/raijin-da`'s `decode()` checks the frame's declared
  decompressed length against `MAX_DECOMPRESSED_SIZE` (16 MiB) before
  inflating, and the inflate buffer is allocated one byte over that declared
  size — anything that comes back longer is refused as `DASizeLimitError`
  rather than silently truncated. DA bytes are untrusted by definition and
  DEFLATE can reach roughly 1000:1, so an unbounded decoder is a
  decompression-bomb vector, not a hardening nicety.
- **SDK-generated keys are non-extractable by default.** `Wallet.generate()`
  and `Wallet.fromKey()` both default `extractable` to `false`; a caller must
  explicitly opt in with `{ extractable: true }` to get a key that can leave
  the browser's key store.

**What is still yours:**

- **Delivery, ordering, and liveness.** The consensus engine never retries,
  never orders, never detects a dropped message — if your transport loses
  PREPAREs, rounds simply time out into view changes. Liveness is a
  transport property; only safety is defended here.
- **Sybil resistance and the validator membership list itself.** The engine
  checks that `from` belongs to the `ValidatorSet` you supply and
  authenticates the signature against it — it has no opinion on who belongs
  in that set or how it changes, and will faithfully authenticate a vote
  from a validator you should never have admitted.
- **Confidentiality and DoS.** Nothing in the consensus layer is encrypted,
  and signature verification happens per message, so an unauthenticated peer
  that can reach `onMessage` can still make a node do work. Rate-limit at
  the transport.
- **The correctness of every injected dependency.** `verify`
  (`SignatureVerifier`) is injected into consensus; an implementation that
  returns `true` unconditionally reinstates every authentication guarantee
  above. `ed25519Verifier` from `@johnhenry/raijin-core` is the real one —
  nothing prevents a caller from wiring in something weaker.
- **The DA backend's own transport security.** `CelestiaDA` refuses to send
  its auth token over cleartext `http:` to a non-loopback host unless
  `allowInsecureAuth` is explicitly set; that guard covers the token, not
  the confidentiality or availability of the DA layer itself, which is the
  backend's property, not Raijin's.
- **Genesis and state migration on upgrade.** `0.0.1` was a hard wire-format
  break with no compatibility mode (see [MIGRATION.md](MIGRATION.md)) — a
  version that authenticates correctly still will not interoperate with a
  node on an incompatible wire format, and Raijin does not detect or warn
  about that mismatch beyond the resulting digest failures.

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
