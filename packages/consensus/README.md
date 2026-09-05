# @johnhenry/raijin-consensus

PBFT consensus and leader rotation for the [Raijin](https://github.com/johnhenry/raijin) mesh rollup — a browser-native rollup framework where the users ARE the validators.

Implements a simplified Practical Byzantine Fault Tolerance protocol: the leader broadcasts PRE-PREPARE with a proposed block, validators answer PREPARE, then COMMIT, and the block finalizes once a quorum of `n - f` commits is collected. View changes rotate the leader when it stops proposing. Every vote is signed and verified against a payload that names the chain, the validator set, the phase, the view and the sequence, so no signature is reusable anywhere else. Transport and timers are injected, so the engine runs over WebRTC, WebSockets, or an in-memory bus, and tests can drive time deterministically.

## Install

```bash
npm install @johnhenry/raijin-consensus
```

## Quorum math — read this before choosing a validator count

`quorumSize() = n - f` with `f = floor((n - 1) / 3)`:

| validators (n) | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tolerated faults (f) | 0 | 0 | 0 | 1 | 1 | 1 | 2 | 2 | 2 | 3 |
| quorum (q) | 1 | 2 | 3 | 3 | 4 | 5 | 5 | 6 | 7 | 7 |

Safety needs any two quorums to overlap in at least one honest node — `2q - n >= f + 1`. `q = n - f` satisfies that at every `n`. At the canonical PBFT sizes (`n = 3f + 1`: 1, 4, 7, 10, …) it is exactly `2f + 1`; everywhere else it is strictly larger, which is the point. `q = 2f + 1` **is not safe off those sizes**, and at `n = 2` or `n = 3` it degenerates to `q = 1` — one node reaching its own PREPARE and COMMIT quorum and finalizing blocks alone. That is what this package used to do, and it does not any more.

You still get no Byzantine *tolerance* below `n = 4` — with `f = 0` a single faulty node is one too many — but a faulty node can no longer finalize by itself: at `n = 3` it needs all three.

Two more sharp edges:

- **`chainId` is required and has no default.** It is signed into every vote. A default would be an id shared by every deployment that never chose one, and votes would then replay verbatim between them (testnet into mainnet, a fork into its parent). `PBFTConsensus` throws `TypeError` if it is missing.
- **The engine never builds blocks.** The leader's block timer fires into a no-op; something external (`BlockProducer` in `@johnhenry/raijin-validator`) must construct a block and call `propose()`.

## What the engine authenticates, and what is still yours

Earlier versions of this package collected vote signatures without checking them and told you that authentication was your transport's job. It isn't any more. Be precise about the new line, because the half that is still yours has not moved.

**The engine now guarantees, on every PRE-PREPARE, PREPARE, COMMIT and VIEW-CHANGE it acts on:**

- **The signature is verified** against the claimed sender, through the `verify` (`SignatureVerifier`) you inject. A message that fails is dropped before it reaches any counter. `verify` is a required config field — there is no unverified mode to fall back into.
- **The signature is bound to its scope.** A vote is signed over `voteDigest({ phase, chainId, epoch, view, sequence, digest })`, so one signature authorizes exactly one phase, of one round, at one sequence, on one chain, under one validator set. A PREPARE is not a COMMIT. A vote from view 4 is not a vote in view 5. A testnet vote is not a mainnet vote. A vote cast before a membership change is not a vote after it — `epoch` is a digest of the exact set and order, so a removed validator's still-valid signatures stop counting toward the quorum of the set that removed it.
- **`chainId` and `epoch` come from this node, never from the message.** A peer cannot tell you which chain or which set its vote should count under; it can only produce a signature that matches your scope or does not.
- **A sender counts once.** VIEW-CHANGE messages are deduplicated by sender, and PREPARE/COMMIT are collected into per-digest sets keyed by validator, so re-broadcasting cannot manufacture a quorum from one node.
- **Views only move forward.** A recorded VIEW-CHANGE quorum stays valid forever, so replaying one would otherwise rewind the view and clear every in-flight round indefinitely. `newView <= currentView` is dropped, for both VIEW-CHANGE and NEW-VIEW.

**Still yours:**

- **Delivery.** The engine never retries, never orders, never detects a dropped message. If your transport loses PREPAREs, rounds simply time out into view changes. Liveness is a transport property; only safety is defended here.
- **Sybil resistance and the membership list itself.** `from` is checked for membership in the `ValidatorSet` you supply, and *that* is what the signature then proves. The engine has no opinion on who belongs in the set or how it changes — it will faithfully authenticate a vote from a validator you should never have admitted.
- **Confidentiality and DoS.** Nothing here is encrypted, and signature verification happens per message, so an unauthenticated peer that can reach `onMessage` can still make you do work. Rate-limit at the transport.
- **The verifier's correctness.** `verify` is injected. An implementation that returns `true` unconditionally reinstates every hole listed above; `ed25519Verifier` from `@johnhenry/raijin-core` is the real one.

## Quick start

```js
import { StateMachine, InMemoryStateStore, ed25519Verifier } from '@johnhenry/raijin-core'
import { PBFTConsensus, ValidatorSet } from '@johnhenry/raijin-consensus'

const consensus = new PBFTConsensus({
  identity: myPublicKey,             // 32 bytes
  chainId: 42n,                      // required, no default — see above
  validators: new ValidatorSet([myPublicKey, peerA, peerB, peerC]),
  transport,                         // NetworkTransport — your WebRTC/WebSocket bridge
  timer: { set: (ms, cb) => setTimeout(cb, ms), clear: clearTimeout },
  stateMachine: new StateMachine(new InMemoryStateStore(), verifier),
  sign: (msg) => wallet.sign(msg),
  verify: ed25519Verifier,           // required — every vote is checked with this
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

`new PBFTConsensus(config: PBFTConfig)` — config fields: `identity`, `chainId` (**required**, `bigint`), `validators`, `transport`, `timer`, `stateMachine`, `sign`, `verify` (**required**, `SignatureVerifier`), optional `blockTime` (ms, default 2000), optional `viewTimeout` (ms, default 10000).

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

View changes: if the view timer expires without progress, the node broadcasts `view-change` for `view + 1`; once `quorumSize()` validly-signed view-change messages from *distinct* senders accumulate, everyone rotates, clears in-flight rounds, and the new leader takes over. A view change only ever moves forward — a message for a view at or below the current one is dropped, so a replayed quorum cannot rewind the node.

Carry-over is partial: a new leader is prevented from proposing a *conflicting* block at a sequence that already reached a PREPARE quorum, but the original block is not automatically re-proposed. Full prepared-certificate carry-over is tracked as follow-up work.

### `ValidatorSet`

`new ValidatorSet(validators?: Uint8Array[])` — ordered set of 32-byte public keys.

- `add(pubkey)` / `remove(pubkey)` / `has(pubkey)` — membership; `add` returns `false` on duplicates.
- `epoch(): Promise<Uint8Array>` — a 32-byte digest of this exact set, in this exact order. Every vote signature covers it, which is what stops votes crossing a membership change. It is a digest rather than a counter on purpose: two nodes that applied *different* changes would still agree on "epoch 2" and go on counting each other's votes, whereas disagreeing about who is in the set makes them disagree about the epoch. Order is included because `leaderForView` picks by index, so the same members in a different order are genuinely a different set. Memoized, and invalidated by `add`/`remove`. A `ValidatorSet` replacement or wrapper must provide it.
- `leaderForView(view)` — deterministic round-robin: `validators[view % n]`. Throws on an empty set.
- `quorumSize()` / `maxFaults` — the math above (`n - f` and `floor((n - 1) / 3)`).
- `size` / `all()` / `at(index)` — inspection.

Every node must construct its `ValidatorSet` with the **same keys in the same order**, or leader election disagrees and nothing finalizes.

### Types

`PBFTConfig`, `PBFTPhase`, `NetworkTransport` (`broadcast`/`send`/`onMessage`), `ConsensusTimer` + `TimerHandle` (`set`/`clear` — injectable for deterministic tests), and the message union `ConsensusMessage` = `PrePrepareMessage | PrepareMessage | CommitMessage | ViewChangeMessage | NewViewMessage`.

### `voteDigest(vote: Vote)` / `NO_BLOCK_DIGEST`

The bytes a validator signs for one vote, exported so a transport, relay or test can construct and check a vote without re-deriving the layout — there is one definition and this is it.

```ts
voteDigest({ phase, chainId, epoch, view, sequence, digest }): Promise<Uint8Array>
```

`H(tag ‖ 0x00 ‖ chainId ‖ epoch ‖ view ‖ sequence ‖ digest)`, integers LEB128, `epoch` and `digest` length-prefixed, so every field is self-delimiting and no two distinct votes share an input. `phase` is a `VotePhase` (`'pre-prepare' | 'prepare' | 'commit' | 'view-change'`) selecting the domain tag. Use `NO_BLOCK_DIGEST` (32 zero bytes) as the `digest` for VIEW-CHANGE, which commits to no block.

It takes one object rather than positional arguments deliberately: four of the six fields are bigints or byte strings of the same shape, and a transposed pair would silently sign a valid-looking signature over the wrong scope.

If your transport serializes to JSON, remember consensus messages carry `bigint`s and `Uint8Array`s — you need a replacer/reviver pair (see `test/helpers.ts` in the repo for a working one).

## Provenance

Previously published unscoped as [`raijin-consensus`](https://www.npmjs.com/package/raijin-consensus): `0.0.1` (initial release, 2026-03-15), then `0.0.2` (2026-07-16 — published with a broken build, because the release workflow used plain `npm publish`, which does not rewrite `workspace:*` internal dependency specifiers into real resolved versions; that tarball was unpublished), then `0.0.3` (2026-07-16, same day — republished correctly via `pnpm publish`, the last unscoped version, live until this move).

Moved into the `@johnhenry` npm scope and restarted at `0.0.0` — no functional changes in the move. The `workspace:*` publish bug can no longer recur: the monorepo has since converted to npm workspaces with real semver ranges, and releases go out via `npm publish --workspaces`. See the [root CHANGELOG](https://github.com/johnhenry/raijin/blob/main/CHANGELOG.md) for the full project history.

## License

MIT
