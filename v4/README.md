# Athena v4

This directory is the full redesign track for Athena. The old v3 runtime has been removed; preserved behavior now lives in `SEMANTICS.md` and its regression tests.

## Current state

The subsystems are now wired into a running, durable runtime (not just isolated modules):

- strict TypeScript package boundary; shared event contract in `src/shared/events.ts`
- server, CLI, and Svelte UI entrypoints
- authenticated WebSocket replay with a 4MB byte-bounded ring, cross-chunk frame reassembly, and guarded client-frame parsing
- composition root that instantiates every subsystem, hydrates it from SQLite on `init()`, and exposes a write-through services facade
- `storage/repository.ts`: typed persistence for memory, instincts(+events), skills(+versions), coral, alerts(+events), audit, errors, and provider health — state survives restart
- provider failover router (+ optional vendored llama-server adapter) and a turn engine with an offline command surface (`/tool`, `/risk`, `/recall`)
- `tools/executor.ts`: real tool execution through the full security pipeline — risk tier → Tier 2 approval gate → per-tool output cap → audit row + lifecycle events (workspace-scoped file, search, hash, stacktrace, recall, and shell handlers)
- deterministic risk engine (fail-closed quote handling), approval leases, memory, instincts, fingerprints, migration planning, skills, CORAL, watchers (related-only correlation), compression (summarize-not-drop), debug helpers, offline model selection, runtime manifest verification
- eight-view Svelte shell; CI verification on Ubuntu, Windows, and macOS
- 46 regression tests including a restart-survival integration test and a live over-the-wire turn

The remaining work is operational, not architectural: vendor the per-arch Node + llama-server + model artifacts on the drive and pin their real SHA-256 values in `vendor/manifest.json`, run migration against live v3 data, build out the remaining tool handlers and the agentic LLM tool-call loop, deepen the UI surfaces, and validate from the shipped runtime on the physical drive.

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
