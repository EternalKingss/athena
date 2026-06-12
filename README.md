# Athena

Athena is being rebuilt as v4.

This repository now tracks the redesign in `v4/`. The old v3 runtime has been removed so the rebuild can move without carrying obsolete launchers, `.mjs` constraints, Markdown-primary storage, or SSE-era UI assumptions.

## Current State

The current branch is a P0 scaffold for the new architecture:

- strict TypeScript package under `v4/`
- shared event contract in `v4/src/shared/events.ts`
- server and CLI entrypoints
- byte-bounded event replay buffer
- Node 22.13 `node:sqlite` / FTS5 boot self-check
- initial Svelte system shell
- v4-only CI verification

It is not yet the production runtime.

## Architecture Direction

Athena v4 is a portable AI debugging companion that lives on an external SSD and treats every host machine as a guest environment.

Core invariants:

- portable and self-contained after first boot
- cross-platform across win-x64, mac-arm64, and linux-x64
- graceful offline mode with no network and no API keys
- deterministic risk engine and explicit approval gates
- SQLite as the source of truth
- authenticated local transport with replayable events
- vendored native components with SHA-256 verification
- no shipped `node_modules`

## Working In This Repo

Use the v4 docs as the source of truth:

- `V4-OVERHAUL.md` explains the redesign boundary.
- `v4/CLAUDE.md` defines engineering rules for agents.
- `v4/SEMANTICS.md` pins preserved behavior that must be mapped to tests.

From `v4/`:

```bash
npm install --global pnpm@9.15.4
pnpm install --no-frozen-lockfile
pnpm verify
```

Package versions are pinned in `v4/package.json` and resolved in `v4/pnpm-lock.yaml`.
