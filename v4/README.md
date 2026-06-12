# Athena v4

This directory is the full redesign track for Athena. The old v3 runtime has been removed; preserved behavior now lives in `SEMANTICS.md` and its regression tests.

## Current state

This tree now carries the v4 implementation surface for the full rebuild plan:

- strict TypeScript package boundary
- shared event contract in `src/shared/events.ts`
- server, CLI, and Svelte UI entrypoints
- authenticated WebSocket replay with a 4MB byte-bounded ring
- composition root, DB worker, schema bootstrap, and storage capability events
- provider failover router and L2 turn engine
- deterministic risk engine, approval leases, and typed tool registry
- memory, instincts, machine fingerprints, migration planning, skills, CORAL, watchers, compression, debug helpers, offline model selection, and runtime manifest verification
- eight-view Svelte shell for Chat, Approvals, Memory, Skills, Agents, Watchers, Sessions, and System
- CI verification on Ubuntu, Windows, and macOS

The remaining cutover work is operational rather than architectural: pin real vendored artifact SHA-256 values, run migration against live v3 data, and validate from the shipped runtime on the physical drive.

## Design stance

v4 may use TypeScript, Svelte, Vite, esbuild, pnpm, and bundled pure JS/TS packages. That is intentional. The old v3 rules about zero npm dependencies and `.mjs`-only source do not apply inside `v4/`.

The shipping artifact still must not contain `node_modules`. Build output, vendored runtimes, vendored native binaries, models, and verified wasm assets are the deployable surface.

## Commands

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

Package versions are pinned in `package.json` and resolved in `pnpm-lock.yaml`.

## Authority

- `CLAUDE.md` defines v4 engineering rules.
- `SEMANTICS.md` defines preserved v3 behavior and must stay test-mapped.
- The external blueprint remains human-owned and must not be regenerated wholesale.
