# Athena v4

This directory contains Athena's implementation — server, CLI, and UI. See the [root README](../README.md) for what Athena does and how to run it.

## What's here

- strict TypeScript package boundary; shared event contract in `src/shared/events.ts`
- server, CLI, and Svelte UI entrypoints
- authenticated WebSocket replay with a 4MB byte-bounded ring, cross-chunk frame reassembly, and guarded client-frame parsing
- composition root that instantiates every subsystem, hydrates it from SQLite on `init()`, and exposes a write-through services facade
- `storage/repository.ts`: typed persistence for memory, instincts(+events), skills(+versions), coral, alerts(+events), audit, errors, and provider health — state survives restart
- provider failover router with OpenAI and Anthropic cloud adapters (+ optional vendored llama-server adapter) and a turn engine with an offline command surface (`/tool`, `/risk`, `/recall`)
- `tools/executor.ts`: real tool execution through the full security pipeline — risk tier → Tier 2 approval gate → per-tool output cap → audit row + lifecycle events (workspace-scoped file, search, hash, stacktrace, recall, and shell handlers)
- deterministic risk engine (fail-closed quote handling), approval leases, memory, instincts, fingerprints, migration planning, skills, CORAL, watchers (related-only correlation), compression (summarize-not-drop), debug helpers, offline model selection, runtime manifest verification
- eight-view Svelte shell; CI verification on Ubuntu, Windows, and macOS
- 65 regression tests including a restart-survival integration test, a live over-the-wire turn, and cloud provider failover (OpenAI/Anthropic)

## Commands

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

Package versions are pinned in `package.json` and resolved in `pnpm-lock.yaml`.

## Reference

- `CLAUDE.md` — engineering rules for this codebase
- `SEMANTICS.md` — preserved behavior and its regression tests
