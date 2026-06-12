# Athena v4 Overhaul

Athena v4 is a full redesign, not a patch series on v3.

The v3 runtime has been removed from this repository. The new implementation starts in `v4/` with its own TypeScript, Svelte, SQLite, WebSocket, offline-model, and vendored-runtime architecture.

Preserved behavior is tracked as explicit semantics in `v4/SEMANTICS.md`, not by keeping the old runtime around as a second implementation.

## What changes

- v4 is strict TypeScript instead of `.mjs`-only JavaScript.
- v4 may use pure JS/TS npm packages when bundled into the shipped artifacts.
- v4 ships no `node_modules` on the drive.
- v4 uses `node:sqlite` as the source of truth instead of Markdown files as primary storage.
- v4 replaces SSE with authenticated WebSocket replay.
- v4 makes offline/no-key mode a first-class supported state.
- v4 vendors native components per architecture and verifies them through `vendor/manifest.json`.

## What does not change

The preserved behavior in `v4/SEMANTICS.md` is non-negotiable unless a human changes the spec and the matching tests in the same PR.

That includes tiered autonomy, skill trust gates, CORAL turn-boundary learning, watcher semantics, memory/instinct behavior, machine fingerprint privacy, compression behavior, structured errors, provider failover windows, and the security ratchet.

## Current branch target

The first v4 branch establishes the P0 foundation:

- `v4/CLAUDE.md`
- `v4/SEMANTICS.md`
- `v4/package.json`
- strict TypeScript config
- shared event contract
- server/CLI/UI entrypoints
- byte-bounded event replay buffer
- Node 22.13 sqlite/FTS5 self-check
- v4 CI verification track

This is the foundation for the rebuild. It is not yet the cutover runtime.
