# Athena — Portable AI Agent

A personal AI agent that lives on this drive and runs on whatever machine you plug into. She can run shell commands, read/write files, search the web, remember things across sessions, spawn sub-agents for parallel work, and build her own skill library over time. Her memory lives on the drive and travels with you.

Nothing is installed on the host. Nothing is left behind. Zero npm dependencies — only Node built-ins.

## Providers

Switch between providers from the UI dropdown at any time, no restart needed:

| Provider | Models | Key needed |
|----------|--------|-----------|
| **OpenAI** | gpt-5.5, gpt-5.4-mini, gpt-4o, gpt-4o-mini | `OPENAI_API_KEY` |
| **Anthropic** | claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5-20251001 | `ANTHROPIC_API_KEY` |
| **NVIDIA NIM** | Nemotron-Super-120B, DeepSeek-V4-Pro, Llama-3.3-70B, Qwen3-235B, Nemotron-Ultra-253B | `NVIDIA_API_KEY` |

You only need keys for the providers you use. OpenAI is also required for semantic memory (embeddings) regardless of which model you chat with.

## Setup (do this once)

### 1. Configure your keys
```
config/.env.example  →  copy to  config/.env
```
Fill in at least one provider key. See `.env.example` for all options.

### 2. Add portable runtimes (one per OS you'll use)
Download Node 22 LTS from https://nodejs.org/dist/ and place it so the launcher finds it:

| OS | Download | Path |
|----|----------|------|
| Windows x64 | `node-vXX-win-x64.zip` | `runtime/win-x64/node.exe` |
| Windows ARM | `node-vXX-win-arm64.zip` | `runtime/win-arm64/node.exe` |
| macOS Apple Silicon | `node-vXX-darwin-arm64.tar.gz` | `runtime/mac-arm64/bin/node` |
| macOS Intel | `node-vXX-darwin-x64.tar.gz` | `runtime/mac-x64/bin/node` |
| Linux x64 | `node-vXX-linux-x64.tar.xz` | `runtime/linux-x64/bin/node` |
| Linux ARM | `node-vXX-linux-arm64.tar.xz` | `runtime/linux-arm64/bin/node` |

Windows users: `runtime/get-node.ps1` can download and extract it automatically.

#### Optional: Portable Python (no host install)
Athena can carry her own Python using [python-build-standalone](https://github.com/indygreg/python-build-standalone). Nothing touches the host.

```bash
# Linux / macOS
bash runtime/get-python.sh

# Windows
powershell -ExecutionPolicy Bypass -File runtime\get-python.ps1
```

Drops into `runtime/<arch>/python/`. Any `python` or `pip` command Athena runs automatically uses the drive's Python first.

#### Optional: Loki malware scanner (no host install)
Installs [Loki](https://github.com/Neo23x0/Loki) (YARA + IOC scanner) into the drive's Python. Requires portable Python above.

```bash
# Linux / macOS
bash runtime/get-loki.sh

# Windows
powershell -ExecutionPolicy Bypass -File runtime\get-loki.ps1
```

Clones Loki into `tools/loki/`, dependencies install into the drive's Python. Ask Athena to `load_skill loki-scan` for usage.

You only need the platforms you plug into.

## Running

- **Windows:** double-click `Athena.bat`
- **macOS:** double-click `Athena.command` *(first time: right-click → Open to clear Gatekeeper)*
- **Linux:** `./start.sh`

Athena opens in your browser. Type to talk. Use the dropdown to switch models.

**UI commands:** `/task <goal>` · `/spawn <name> <goal>` · `/mem` · `/forget` · `/model <name>` · `/exit`

## What she can do

### Tools
| Tool | What it does |
|------|-------------|
| `run_shell` | Execute shell commands on the host |
| `read_file` / `write_file` / `edit_file` | File operations |
| `list_dir` | Browse the filesystem |
| `fetch_url` | Fetch and read any URL (strips HTML) |
| `web_search` | Brave Search — live web results |
| `memory` | Read/write long-term memory (persists across sessions) |
| `recall` | Semantic search over all past memory and sessions |
| `clipboard_read` / `clipboard_write` | Host clipboard |
| `notify` | Desktop notification |
| `open` | Open files, folders, or URLs |
| `clarify` | Ask a focused question before acting |
| `todo` | Track multi-step task progress |
| `spawn_agent` | Launch a parallel background agent |
| `workspace_read` / `workspace_write` | Share data between agents |
| `load_skill` / `save_skill` / `update_skill` | Skill library management |
| `machine_info` | Query detected machine capabilities. Pass `rescan:true` to re-probe. |

### Memory
Two tiers:

- **Long-term memory** (`data/memory/athena.md`, `user.md`) — facts that survive across sessions. Loaded into every conversation. Bounded to 2,200 chars to stay concise.
- **Semantic recall** — every memory entry and session summary is embedded (OpenAI `text-embedding-3-small`) and stored in `embeddings.jsonl`. `recall` finds relevant past context by meaning, not just keywords.

### Context management
- **Auto-compression** kicks in at 40 messages — the middle of the conversation is summarized into bullets, keeping the first 4 messages (system context) and last 10 (recent context). Your active task list is reinjected so nothing is lost.
- **Tool output compression** — large tool results are automatically compressed before they enter the context window. JSON keeps its full schema but truncates long values; logs deduplicate repeated lines; code has comments stripped; all types get a head+tail treatment if still large. Triggers at 1,500 chars, hard cap at 8,000. The UI always shows you the full raw output — only the LLM gets the compressed version.
- **50 tool-call cap** per turn prevents runaway loops.

### Machine capabilities
When Athena boots, she runs a background scan of the host machine and injects the results into her system prompt. She detects:

- **Languages** — Python, Ruby, PHP, Perl, Lua, Julia, R, Swift, Kotlin, Scala, Elixir, Haskell, Zig
- **Compilers / Build** — gcc, clang, javac, rustc, Go, .NET, tsc, Maven, Gradle, CMake, Make, Ninja, Bazel
- **Package managers** — npm, pnpm, yarn, bun, deno, pip, uv, poetry, gem, composer, brew, apt, yum, dnf, pacman, nix, winget, choco, scoop
- **Containers** — Docker, docker-compose, Podman, kubectl, Helm, minikube, kind
- **Browsers** — Chrome, Chromium, Firefox, Brave, Edge, Opera, Safari, lynx
- **IDEs / Editors** — VS Code, Cursor, Zed, vim, nvim, emacs, IntelliJ, PyCharm, Helix, Sublime
- **Databases** — MySQL, PostgreSQL, SQLite, Redis, MongoDB, InfluxDB, DuckDB
- **DevOps / Cloud** — git, gh, aws, az, gcloud, terraform, ansible, pulumi, vault, fly, vercel, wrangler
- **Utilities** — curl, wget, jq, ffmpeg, tmux, fzf, ripgrep, bat, rsync, openssl, gpg, sops, age
- **GPUs** — NVIDIA (nvidia-smi), AMD (rocm-smi), macOS (system_profiler), Linux (lspci), Windows (wmic)
- **MCP servers** — scans Claude Desktop, Cursor, and project-level `.mcp.json` configs

The scan is non-blocking — Athena is ready immediately and the machine block appears in the system prompt as soon as the scan resolves (before the first response). Call `machine_info` to see the full result, or pass `rescan:true` to re-probe after installing something new.

### Skills
Athena builds her own playbook. When she solves something non-trivial, she saves it as a skill in `skills/`. Skills are plain markdown with YAML frontmatter — hand-editable, version-controlled, loaded on demand.

Current built-in skills: `system-health`, `git-workflow`, `dev-setup`, `remove-mcafee-windows`, `windows-pip-overlay-control`, `windows-safe-speed-cleanup`.

### Multi-agent
`spawn_agent` launches a background agent with its own isolated message history and task list. Agents communicate via a shared in-memory workspace (`workspace_write` / `workspace_read`). Final results are automatically posted to the workspace so the main agent can read them without being asked. The UI shows each agent in its own tab with a live status indicator and a toast notification when it finishes.

## What lives where

```
config/.env              — your keys and settings (stays on drive, never committed)
data/memory/athena.md    — Athena's long-term notes
data/memory/user.md      — facts about you (gitignored)
data/memory/summary.md   — rolling session summaries (gitignored)
data/memory/embeddings.jsonl — semantic memory vectors (gitignored)
data/sessions/           — full session transcripts (gitignored)
skills/                  — self-built skill library
athena/                  — source code
runtime/                 — portable Node binaries (gitignored, download separately)
```

## Source layout

```
athena/
  athena.mjs      entry point (CLI + UI)
  api.mjs         LLM API calls — OpenAI, Anthropic, NVIDIA streaming
  compress.mjs    tool output compression (JSON, code, logs, text)
  capabilities.mjs machine capability detection at startup
  config.mjs      env loading, constants, model lists
  core.mjs        turn loop, task runner, context compression
  embed.mjs       semantic embeddings, cosine similarity search
  memory.mjs      long-term memory read/write, session save
  paths.mjs       all filesystem paths
  personality.mjs Athena's character, voice, and system prompt builder
  skills.mjs      skill scan, load, save, update
  tools.mjs       all tool definitions and execution
  ui.mjs          browser UI server, SSE broadcast, HTML
  agents.mjs      multi-agent pool, shared workspace
```

## Security

- Your API keys sit in `config/.env` in plaintext. If you lose the drive or plug into a compromised machine, treat the keys as burned and rotate them.
- `AUTO_APPROVE=true` in `.env` means Athena runs shell commands and writes files without asking. Only use on machines you fully trust.
- In UI mode without `AUTO_APPROVE`, destructive tools (`run_shell`, `write_file`, `edit_file`) are blocked for the main agent — background agents spawned via `spawn_agent` auto-approve since they run unattended.
- Do not plug this into locked-down or monitored environments (work, government, someone else's secured box). An agent running shell commands and calling out to an API is exactly what those systems flag.

## Roadmap

| Phase | What shipped | Status |
|-------|-------------|--------|
| **1** | Portable launchers (Windows/macOS/Linux), chat, shell + file tools, basic memory | ✓ done |
| **2** | Web fetch, live web search, patch/diff editing, multi-step task runner | ✓ done |
| **3** | Rolling session summaries, session save/resume, smarter context management | ✓ done |
| **4** | Modular architecture, multi-provider (Anthropic + NVIDIA), semantic recall + embeddings | ✓ done |
| **5** | Multi-agent system, self-building skill library, full web UI, security hardening, tool output compression, codebase cleanup | ✓ done |
| **6** | Machine capability detection — languages, compilers, GPUs, containers, browsers, IDEs, databases, MCP servers detected at boot and injected into system prompt. Portable Python + Loki-RS malware scanner bundled on the drive, zero host footprint | ✅ current |
