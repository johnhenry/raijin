# Raijin

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
| `raijin-core` | State machine, blocks, transactions, Merkle roots |
| `raijin-consensus` | PBFT consensus engine with leader rotation and view changes |
| `raijin-mempool` | Transaction pool with fee-based ordering and eviction |
| `raijin-da` | Data availability abstraction (Celestia, ETH blobs) |
| `raijin-validator` | Composition root wiring core + consensus + mempool |
| `raijin-sdk` | Developer-facing client API |
| `raijin-test-harness` | Multi-validator integration test utilities |

## Quick Start

```bash
pnpm install
pnpm build
pnpm test
```

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

## Design Principles

- **Transport agnostic.** The rollup doesn't know about WebRTC.
- **Storage agnostic.** State uses a `StateStore` interface.
- **Identity agnostic.** Accepts any signing function.
- **Browser-first, not browser-only.** Works in Node.js too.
- **Zero server cost.** Your users' browsers are the infrastructure.

## Development

```bash
# Install dependencies
pnpm install

# Build all packages (uses Turborepo)
pnpm build

# Run all tests
pnpm test

# Run tests in watch mode (root vitest config)
npx vitest

# Type-check all packages
pnpm typecheck

# Clean build artifacts
pnpm clean
```

## Name

Raijin (雷神) -- the Japanese god of lightning, thunder, and storms.
Like lightning connecting sky to earth, Raijin connects browser peers
into a consensus network.

## License

MIT
