# Athena Agent Brief

Athena v4 lives in `v4/`.

Read `v4/CLAUDE.md` before making implementation changes. The old v3 rules no longer apply because the v3 runtime has been removed from this repository.

Key boundary:

- Do not recreate `.mjs`-only v3 architecture.
- Do not bring back root launchers or Markdown-primary runtime state.
- Do not change preserved behavior without updating `v4/SEMANTICS.md` and matching tests.
- Keep the rebuild centered on the v4 TypeScript, Svelte, SQLite, WebSocket, vendored-runtime design.
