# Athena

Athena is a portable AI agent and debugging companion. It runs as a local server with an authenticated WebSocket API and a Svelte UI, backed by SQLite for persistent state, and works either online — with automatic failover across LLM providers — or fully offline using a vendored local model.

## Abilities

- **Persistent state** — memory, instincts, skills, CORAL learning, alerts, audit log, and provider health are stored in SQLite and survive restarts
- **Authenticated, resumable UI** — token-authenticated WebSocket transport with a byte-bounded replay buffer, so the UI can reconnect and catch up on missed events
- **Provider failover** — routes between cloud LLM providers and a vendored local llama-server, with automatic fallback and offline model selection
- **Safe tool execution** — every tool call passes through a deterministic, fail-closed risk engine, Tier 2 approval gates, per-tool output caps, and audit logging; built-in handlers cover workspace-scoped file access, search, hashing, stack traces, memory recall, and shell commands
- **Offline command surface** — `/tool`, `/risk`, and `/recall` work without a model or network connection
- **Memory & learning** — persistent memory and instincts, CORAL turn-boundary learning, watchers that correlate related events, and summarize-not-drop compression
- **Eight-view Svelte UI** for monitoring and interacting with the agent
- **Portable & cross-platform** — self-contained after first boot, with vendored per-architecture runtimes for Windows, macOS, and Linux, verified via a SHA-256 manifest

## Setup

Requires Node.js >= 22.13.0 and pnpm 9.15.4 (`corepack enable` installs it).

```bash
cd v4
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify` runs lint, typecheck, tests, build, and an artifact check. Build output lands in `v4/dist/` (`server.js`, `cli.js`, `ui/`).

## Usage

Run from `v4/` after building, or use the portable launcher on a deployed drive.

**Start the server:**

```bash
node dist/cli.js serve
```

Prints the UI URL with its auth token.

**Run diagnostics:**

```bash
node dist/cli.js doctor
```

Checks Node version, SQLite, and FTS5 availability.

**Ask a one-off question:**

```bash
node dist/cli.js ask "<your question>"
```

**Offline commands** — inside `ask` or the UI, these route straight through the tool/risk pipeline without calling a model:

- `/tool <name> <json>` — run a tool directly
- `/risk <command>` — show the risk verdict for a command
- `/recall <query>` — search memory

**Portable launcher:** on a deployed drive, `v4/scripts/athena.cmd` (Windows) or `athena.ps1` (PowerShell) starts the bundled runtime using the vendored Node build — no system install required.

## Project layout

- `v4/src/` — server, CLI, shared types, and Svelte UI source
- `v4/SEMANTICS.md` — preserved behavior, mapped to regression tests
- `v4/CLAUDE.md` — engineering rules for this codebase
