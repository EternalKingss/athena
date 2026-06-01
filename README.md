# Athena — Portable AI Agent

A personal AI agent that lives on this drive and runs on whatever machine you plug into. She can run shell commands, read/write files, search the web, remember things across sessions, spawn sub-agents for parallel work, and build her own skill library over time. Her memory lives on the drive and travels with you.

Nothing is installed on the host. Nothing is left behind.

## Providers

Athena supports three AI providers — switch between them from the UI dropdown at any time:

| Provider | Models | Key needed |
|----------|--------|-----------|
| **OpenAI** | gpt-5.5, gpt-5.4-mini, gpt-4o, gpt-4o-mini | `OPENAI_API_KEY` |
| **Anthropic** | claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5 | `ANTHROPIC_API_KEY` |
| **NVIDIA NIM** | Nemotron, DeepSeek, Llama, Qwen | `NVIDIA_API_KEY` |

You only need keys for the providers you actually use. OpenAI is also required for semantic memory (embeddings) regardless of which model you chat with.

## Setup (do this once)

### 1. Configure your keys
```
config/.env.example  →  copy to  config/.env
```
Fill in at least one provider key. See `.env.example` for all options.

### 2. Add portable Node (one per OS you'll use)
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

You only need the platforms you plug into.

## Running

- **Windows:** double-click `Athena.bat`
- **macOS:** double-click `Athena.command` *(first time: right-click → Open to clear Gatekeeper)*
- **Linux:** `./start.sh`

Athena opens in your browser. Type to talk. Use the dropdown to switch models.

**UI commands:** `/task <goal>` · `/mem` · `/forget` · `/model <name>` · `/exit`

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

### Memory
Two tiers:

- **Long-term memory** (`data/memory/athena.md`, `user.md`) — facts that survive across sessions. Loaded into every conversation. Bounded size, structured entries.
- **Semantic recall** — every memory entry and session summary is embedded (OpenAI `text-embedding-3-small`) and stored in `embeddings.jsonl`. `recall` finds relevant past context by meaning, not just keywords.

### Skills
Athena builds her own playbook. When she solves something non-trivial, she saves it as a skill in `skills/`. Skills are plain markdown with YAML frontmatter — hand-editable, version-controlled, loaded on demand.

Current skills: `system-health`, `git-workflow`, `dev-setup`, `remove-mcafee-windows`, `windows-pip-overlay-control`, `windows-safe-speed-cleanup`.

### Multi-agent
`spawn_agent` launches a background agent with its own message history. Agents communicate via a shared in-memory workspace (`workspace_write` / `workspace_read`). Athena uses this to parallelize research, diagnostics, or any task with independent sub-goals.

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
- Do not plug this into locked-down or monitored environments (work, government, someone else's secured box). An agent running shell commands and calling out to an API is exactly what those systems flag.
