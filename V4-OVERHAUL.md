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

The active v4 branch consolidates the remaining rebuild plan into one full PR:

- P0 artifact gate and three-OS CI
- P1A authenticated WebSocket replay and loopback auth
- P1B provider failover and turn engine
- P2 deterministic risk, approvals, leases, tool registry, output caps, and ratchet corpus
- P3 memory, instincts, fingerprints, schema, migration planning, and offline recall fallback
- P4 skills, crystallization gate, and CORAL turn-boundary persistence
- P5 watcher FSM, offline mode, and local model selection
- P6 debug helper surface and pty fallback capability event
- P7 eight-view Svelte UI shell
- P8 runtime manifest, setup scripts, artifact boot verifier, and cutover notes

The only intentionally unresolved items are the human-owned operational decisions from the blueprint: real vendored artifact hashes, live v3 migration data, portable Python/Loki/search-key/env-key posture, and final validation from the physical drive runtime.
