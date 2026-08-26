# @johnhenry/raijin-consensus

PBFT consensus and leader rotation for the [Raijin](https://github.com/johnhenry/raijin) mesh rollup — a browser-native rollup framework where the users ARE the validators.

Implements a simplified Practical Byzantine Fault Tolerance protocol: the leader broadcasts PRE-PREPARE with a proposed block, validators answer PREPARE, then COMMIT, and the block finalizes once `2f+1` commits are collected. View changes rotate the leader when it stops proposing. Transport and timers are injected, so the engine runs over WebRTC, WebSockets, or an in-memory bus, and tests can drive time deterministically.

## Install

```bash
npm install @johnhenry/raijin-consensus
```

## Quorum math — read this before choosing a validator count

`quorumSize() = 2f + 1` with `f = floor((n - 1) / 3)`:

| validators (n) | tolerated faults (f) | quorum |
| --- | --- | --- |
| 1–3 | 0 | **1** |
| 4–6 | 1 | 3 |
| 7–9 | 2 | 5 |

With 1, 2, or 3 validators, **a single node meets quorum and finalizes alone** — there is no Byzantine tolerance below `n = 4`. That's convenient for demos and fatal if you assumed otherwise.

Two more sharp edges:

- **Messages are trusted from the transport.** The engine checks that `from` is in the validator set, but nothing verifies that the transport reported `from` honestly, and the signatures carried on COMMIT messages are collected, not verified. Authentication is your transport's job.
- **The engine never builds blocks.** The leader's block timer fires into a no-op; something external (`BlockProducer` in `@johnhenry/raijin-validator`) must construct a block and call `propose()`.

## Quick start

```js
import { StateMachine, InMemoryStateStore } from '@johnhenry/raijin-core'
import { PBFTConsensus, ValidatorSet } from '@johnhenry/raijin-consensus'

const consensus = new PBFTConsensus({
  identity: myPublicKey,             // 32 bytes
  validators: new ValidatorSet([myPublicKey, peerA, peerB, peerC]),
  transport,                         // NetworkTransport — your WebRTC/WebSocket bridge
  timer: { set: (ms, cb) => setTimeout(cb, ms), clear: clearTimeout },
  stateMachine: new StateMachine(new InMemoryStateStore(), verifier),
  sign: (msg) => wallet.sign(msg),
  blockTime: 2000,                   // default 2000
  viewTimeout: 10000,                // default 10000
})

consensus.onBlockFinalized((block, receipts) => console.log('final', block.header.number))
consensus.onViewChange((view) => console.log('new view', view))
consensus.start()

if (consensus.isLeader) await consensus.propose(block)
```

`propose()` throws unless this node is the current leader **and** `phase` is `Idle` — one consensus round at a time. On finalization the engine applies the block via `stateMachine.applyBlock()`, notifies handlers, and resets to `Idle`.

## API

### `PBFTConsensus`

`new PBFTConsensus(config: PBFTConfig)` — config fields: `identity`, `validators`, `transport`, `timer`, `stateMachine`, `sign`, optional `blockTime` (ms, default 2000), optional `viewTimeout` (ms, default 10000).

| Member | Purpose |
| --- | --- |
| `start()` / `stop()` | Arm/clear timers and begin/stop processing messages. Messages received while stopped are dropped. |
| `propose(block): Promise<void>` | Leader-only. Broadcasts PRE-PREPARE (+ its own PREPARE) and increments the sequence. |
| `onBlockFinalized(handler)` | `(block, receipts) => void` after quorum commit + state application. |
| `onViewChange(handler)` | `(newView: bigint) => void` after a view change takes effect. |
| `currentView` / `currentSequence` | `bigint` counters. |
| `phase` | `PBFTPhase`: `Idle → PrePrepared → Prepared → Committed → Idle`. |
| `isLeader` / `currentLeader` | Leader for the current view (round-robin over the validator set). |
| `running` | Whether `start()` has been called. |

View changes: if the view timer expires without progress, the node broadcasts `view-change` for `view + 1`; once `quorumSize()` view-change messages accumulate, everyone rotates, clears in-flight rounds, and the new leader takes over.

### `ValidatorSet`

`new ValidatorSet(validators?: Uint8Array[])` — ordered set of 32-byte public keys.

- `add(pubkey)` / `remove(pubkey)` / `has(pubkey)` — membership; `add` returns `false` on duplicates.
- `leaderForView(view)` — deterministic round-robin: `validators[view % n]`. Throws on an empty set.
- `quorumSize()` / `maxFaults` — the math above.
- `size` / `all()` / `at(index)` — inspection.

Every node must construct its `ValidatorSet` with the **same keys in the same order**, or leader election disagrees and nothing finalizes.

### Types

`PBFTConfig`, `PBFTPhase`, `NetworkTransport` (`broadcast`/`send`/`onMessage`), `ConsensusTimer` + `TimerHandle` (`set`/`clear` — injectable for deterministic tests), and the message union `ConsensusMessage` = `PrePrepareMessage | PrepareMessage | CommitMessage | ViewChangeMessage | NewViewMessage`.

If your transport serializes to JSON, remember consensus messages carry `bigint`s and `Uint8Array`s — you need a replacer/reviver pair (see `test/helpers.ts` in the repo for a working one).

## Provenance

Previously published unscoped as [`raijin-consensus`](https://www.npmjs.com/package/raijin-consensus): `0.0.1` (initial release, 2026-03-15), then `0.0.2` (2026-07-16 — published with a broken build, because the release workflow used plain `npm publish`, which does not rewrite `workspace:*` internal dependency specifiers into real resolved versions; that tarball was unpublished), then `0.0.3` (2026-07-16, same day — republished correctly via `pnpm publish`, the last unscoped version, live until this move).

Moved into the `@johnhenry` npm scope and restarted at `0.0.0` — no functional changes in the move. The `workspace:*` publish bug can no longer recur: the monorepo has since converted to npm workspaces with real semver ranges, and releases go out via `npm publish --workspaces`. See the [root CHANGELOG](https://github.com/johnhenry/raijin/blob/main/CHANGELOG.md) for the full project history.

## License

MIT
