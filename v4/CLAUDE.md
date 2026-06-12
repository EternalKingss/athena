# Athena v4 Project Brief

Athena v4 is a full redesign. The v3 runtime has been removed from this repository, so preserved behavior is carried by `SEMANTICS.md` and tests rather than by keeping a second implementation beside the rebuild.

## Mission

Athena is a portable AI debugging companion that lives on a 1TB external SSD. She is a guest on every host machine: no host installs for her own benefit, no persistent host state, and no unnecessary host collection.

## Non-negotiable invariants

- Portable and self-contained after first boot.
- Cross-platform: win-x64, mac-arm64, and linux-x64 are first-class.
- Graceful offline mode with no network and no API keys.
- Native components are vendored per architecture and SHA-256 verified through `vendor/manifest.json`.
- Pure JS/TS npm packages are allowed only when bundled into shipped artifacts. No `node_modules` ships on the drive.
- Preserved v3 behavior lives in `SEMANTICS.md` and must map 1:1 to regression tests.

## Stack

- TypeScript, strict mode, pure ESM.
- Node >= 22.13.0, pinned in `vendor/manifest.json`.
- esbuild for `dist/server.js` and `dist/cli.js`.
- Svelte 5 + Vite for static `dist/ui/`.
- `node:sqlite` for `data/athena.db`, accessed through a DB worker.
- WebSocket `/ws` transport with sequence-numbered events and a 4MB byte-bounded replay ring.
- llama-server and pty bindings vendored per architecture.
- transformers.js / ONNX wasm assets vendored and treated as external runtime artifacts.

## Build boundaries

The v4 tree owns its own tooling and conventions. Removed v3 files are not a style guide for v4.

- Use TypeScript source under `v4/src/`.
- Put shared contracts in `v4/src/shared/` first.
- Keep security policy data in data files, not scattered conditionals.
- Prefer composition root wiring over globals or setter injection.
- Add tests with every preserved semantic or security rule.

## Phase 0 target

P0 proves that the new stack is real and isolated:

- `v4/CLAUDE.md` and `v4/SEMANTICS.md` exist from day one.
- Strict TS config, package scripts, server/CLI/UI entrypoints, and CI exist.
- The boot self-check asserts the pinned runtime can load `node:sqlite` without flags and that FTS5 is present.
- The shipped build must eventually boot with no `node_modules` present.

## Things not to do

- Do not rewrite the v4 blueprint wholesale from memory.
- Do not change preserved behavior without changing `SEMANTICS.md` and the matching test in the same PR.
- Do not weaken loopback auth, approval gates, skill trust, or offline guarantees for convenience.
- Do not silently fall back in security code. Fail closed and emit structured errors.
