# @johnhenry/raijin-core

State machine, blocks, and transactions for the [Raijin](https://github.com/johnhenry/raijin) mesh rollup — a browser-native rollup framework where the users ARE the validators.

Zero external dependencies. Uses only `globalThis.crypto.subtle`. Works in the browser and in Node.js.

## Install

```bash
npm install @johnhenry/raijin-core
```

## Provenance

Previously published unscoped as [`raijin-core`](https://www.npmjs.com/package/raijin-core), last version `0.0.1` (published 2026-03-15 as part of the project's initial `v0.1.0` release). Unlike its sibling packages, `raijin-core` has no internal `workspace:*` dependency of its own, so it was never affected by the `workspace:*`-leak publish bug that forced `raijin-consensus`/`raijin-mempool`/`raijin-da`/`raijin-validator`/`raijin-sdk` through a `0.0.2` → `0.0.3` republish — `0.0.1` was its only unscoped release.

Moved into the `@johnhenry` npm scope and restarted at `0.0.0` — no functional changes in the move. See the [root CHANGELOG](https://github.com/johnhenry/raijin/blob/main/CHANGELOG.md) for the full project history.

## License

MIT
