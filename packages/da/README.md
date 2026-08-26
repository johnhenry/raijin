# @johnhenry/raijin-da

Data availability abstraction with pluggable backends (Celestia, ETH blobs) for the [Raijin](https://github.com/johnhenry/raijin) mesh rollup — a browser-native rollup framework where the users ARE the validators.

`viem` is an optional peer dependency, needed only for the ETH-blobs backend.

## Install

```bash
npm install @johnhenry/raijin-da
```

## Provenance

Previously published unscoped as [`raijin-da`](https://www.npmjs.com/package/raijin-da): `0.0.1` (initial release, 2026-03-15), then `0.0.2` (2026-07-16 — published with a broken build, because the release workflow used plain `npm publish`, which does not rewrite `workspace:*` internal dependency specifiers into real resolved versions; that tarball was unpublished), then `0.0.3` (2026-07-16, same day — republished correctly via `pnpm publish`, the last unscoped version, live until this move).

Moved into the `@johnhenry` npm scope and restarted at `0.0.0` — no functional changes in the move. The underlying publish-workflow bug is fixed for good as part of this migration (`.github/workflows/publish.yml` now uses `pnpm publish`). See the [root CHANGELOG](https://github.com/johnhenry/raijin/blob/main/CHANGELOG.md) for the full project history.

## License

MIT
