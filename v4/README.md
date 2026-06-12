# Athena v4

This directory is the full redesign track for Athena. The old v3 runtime has been removed; preserved behavior now lives in `SEMANTICS.md` and its regression tests.

## Current state

This is a P0 scaffold:

- strict TypeScript package boundary
- shared event contract in `src/shared/events.ts`
- server and CLI entrypoints
- byte-bounded event replay buffer
- Node 22.13 `node:sqlite` / FTS5 boot self-check
- initial Svelte system shell
- CI job for v4 verification

It is not yet the production runtime.

## Design stance

v4 may use TypeScript, Svelte, Vite, esbuild, pnpm, and bundled pure JS/TS packages. That is intentional. The old v3 rules about zero npm dependencies and `.mjs`-only source do not apply inside `v4/`.

The shipping artifact still must not contain `node_modules`. Build output, vendored runtimes, vendored native binaries, models, and verified wasm assets are the deployable surface.

## Commands

```bash
corepack enable
pnpm install --no-frozen-lockfile
pnpm verify
```

Package versions are pinned in `package.json` and resolved in `pnpm-lock.yaml`.

## Authority

- `CLAUDE.md` defines v4 engineering rules.
- `SEMANTICS.md` defines preserved v3 behavior and must stay test-mapped.
- The external blueprint remains human-owned and must not be regenerated wholesale.
