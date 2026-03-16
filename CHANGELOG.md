# Changelog

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
