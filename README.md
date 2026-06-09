# Athena -- Portable AI Agent

A personal AI agent that lives on a USB drive and runs on whatever machine you plug into. She can run shell commands, read/write files, search the web, remember things across sessions, spawn sub-agents for parallel work, build her own skill library, and proactively watch the machine she is running on.

Nothing is installed on the host. Nothing is left behind. Zero npm dependencies -- only Node built-ins.

## Providers

Switch between providers from the UI dropdown at any time, no restart needed:

| Provider | Models | Key needed |
|----------|--------|-----------|
| **OpenAI** | gpt-5.5, gpt-5.4-mini, gpt-4o, gpt-4o-mini | `OPENAI_API_KEY` |
| **Anthropic** | claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5-20251001 | `ANTHROPIC_API_KEY` |
| **Local (offline)** | Any `.gguf` model (default: Phi-3.5-mini) | none -- run `get-offline.sh` |

If OpenAI goes down, Athena automatically fails over to Anthropic (and back again after 15 minutes). Semantic recall falls back to BM25 keyword search if no embedding provider is available.

## Setup (do this once)

### 1. Configure your keys
```
config/.env.example  ->  copy to  config/.env
```
Fill in at least one provider key. See `.env.example` for all options.

### 2. Add portable runtimes (one per OS you will use)
Download Node 22 LTS from https://nodejs.org/dist/ and place it so the launcher finds it:

| OS | Download | Path |
|----|----------|------|
| Windows x64 | `node-vXX-win-x64.zip` | `runtime/win-x64/node.exe` |
| Windows ARM | `node-vXX-win-arm64.zip` | `runtime/win-arm64/node.exe` |
| macOS Apple Silicon | `node-vXX-darwin-arm64.tar.gz` | `runtime/mac-arm64/bin/node` |
| macOS Intel | `node-vXX-darwin-x64.tar.gz` | `runtime/mac-x64/bin/node` |
| Linux x64 | `node-vXX-linux-x64.tar.xz` | `runtime/linux-x64/bin/node` |
| Linux ARM | `node-vXX-linux-arm64.tar.xz` | `runtime/linux-arm64/bin/node` |

Windows users: `runtime/get-node.ps1` downloads and extracts automatically.

#### Optional: Portable Python (no host install)
```bash
bash runtime/get-python.sh        # Linux / macOS
powershell -ExecutionPolicy Bypass -File runtime\get-python.ps1   # Windows
```
Drops into `runtime/<arch>/python/`. Any `python` or `pip` command Athena runs uses the drive's Python first.

#### Optional: Loki malware scanner (no host install)
```bash
bash runtime/get-loki.sh          # Linux / macOS
powershell -ExecutionPolicy Bypass -File runtime\get-loki.ps1     # Windows
```
Clones Loki into `tools/loki/`, installs dependencies into drive Python. Ask Athena to `load_skill loki-scan` for usage.

#### Optional: Offline AI (no internet or API key required)
```bash
bash runtime/get-offline.sh          # Linux / macOS
powershell -ExecutionPolicy Bypass -File runtime\get-offline.ps1   # Windows
```
Downloads the `llama-server` binary and Phi-3.5-mini model (~2.2 GB) to the drive. After this, Athena runs fully offline -- no API key, no wifi needed. The local model starts in the background on launch; Athena is immediately usable while it loads.

## Running

- **Windows:** double-click `Athena.bat`
- **macOS:** double-click `Athena.command` *(first time: right-click -> Open to clear Gatekeeper)*
- **Linux:** `./start.sh`

Athena opens in your browser. Use the dropdown to switch models.

**Commands:** `/task <goal>` -- `/spawn <name> <goal>` -- `/mem` -- `/forget` -- `/model <name>` -- `/exit`

---

## What she can do

### Tools

| Tool | Tier | What it does |
|------|------|-------------|
| `run_shell` | 1/2 | Execute shell commands on the host |
| `read_file` / `write_file` / `edit_file` | 0/1/2 | File operations |
| `list_dir` | 0 | Browse the filesystem |
| `fetch_url` | 0 | Fetch and read any URL (strips HTML) |
| `web_search` | 0 | Brave Search -- live web results |
| `memory` | 0 | Read/write long-term memory |
| `recall` | 0 | Semantic search over all past sessions |
| `clipboard_read` / `clipboard_write` | 0/1 | Host clipboard |
| `notify` | 0 | Desktop notification |
| `open` | 0 | Open files, folders, or URLs |
| `clarify` | 0 | Ask a focused question before acting |
| `todo` | 0 | Track multi-step task progress |
| `spawn_agent` | 0 | Launch a parallel background agent |
| `workspace_read` / `workspace_write` | 0 | Share data between agents |
| `load_skill` / `save_skill` / `update_skill` | 0/2* | Skill library management |
| `skill_rollback` | 0 | Roll back a skill to a previous version |
| `machine_info` | 0 | Query detected machine capabilities |
| `boot_triage` | 0 | Firewall, AV, disk, SSH, updates health check |
| `threat_assess` | 0 | Risk score, open ports, SUID, missing controls |
| `network_scan` | 0 | Interfaces, DNS, listening ports, routing table |
| `machine_health_trend` | 0 | Longitudinal visit history and capability drift |
| `machine_diff` | 0 | Diff current state vs last saved fingerprint |
| `query_machine_logs` | 0 | Filtered OS event log query (severity, time range, pattern) |
| `diff_machine_state` | 0 | Runtime state diff -- new processes, ports, drivers vs baseline |
| `generate_report` | 0 | Full system / security / network report |
| `remediate` | 1/2 | Guided fix for a security or system issue |
| `audit_replay` | 0 | Replay the full tool audit trail for a given day |

*`load_skill` is Tier 2 for unverified (auto-crystallized) skills. User approval promotes them to verified.

**Tiers:** 0 = auto-run, no log. 1 = auto-run, logged as `action_taken`. 2 = blocks for explicit user approval.

### Memory

Three layers:

- **Long-term memory** (`data/memory/athena.md`, `user.md`, `instincts.md`) -- loaded into every system prompt. `instincts.md` holds learned behavioral patterns auto-promoted from session analysis.
- **Negative knowledge** (`data/memory/prohibited_patterns.md`) -- dead ends Athena has hit on this machine. Injected into system prompt so she never wastes tokens retrying known broken approaches.
- **Semantic recall** -- every memory entry and session summary is embedded and stored in `embeddings.jsonl`. `recall` finds relevant past context by meaning. Falls back to BM25 keyword search automatically if no embedding API is available.

### Instinct promotion

After every session, Athena scans the last 60 session files and scores tool usage by confidence (0-100) based on frequency and spread across sessions. Patterns with conf >= 85 seen in 3+ sessions are auto-promoted to `instincts.md` and applied in future turns without being asked.

### Auto-crystallization

After any `/task` that uses 4+ tool calls, Athena fires a cheap-model post-task hook that analyzes the tool trace and asks: is this a repeatable pattern? If yes, it saves or updates a skill automatically. Crystallized skills are marked `status: unverified` and require user approval (Tier 2) before first use -- approval promotes them to verified permanently.

### Proactive watcher

`watcher.mjs` runs in the background and watches four conditions:

| Condition | Interval | Fires when |
|-----------|----------|-----------|
| `disk_low` | 5 min | < 5 GB free (critical) or < 15 GB (low) or > 2 GB drop since last check |
| `kp41` | 10 min | New Windows Kernel-Power Event 41 (unexpected shutdown) |
| `temp_high` | 3 min | CPU >= 80 C (high) or >= 90 C (critical) -- Linux only |
| `net_change` | 2 min | Active network interfaces added or removed |
| `ram_pressure` | 3 min | < 300 MB free RAM (critical) or < 500 MB (low) |
| `cpu_spike` | 2 min | CPU > 95% for 2 consecutive checks |
| `battery_drain` | 5 min | Battery < 10% or draining > 5%/3 min |
| `login_failures` | 5 min | > 5 failed SSH/login attempts in 5 min window |
| `pending_reboot` | 60 min | `/var/run/reboot-required` present or Windows registry flag set |

Related alerts are correlated -- `cpu_spike` + `ram_pressure` within 5 minutes merge into a single combined event.

If Athena is mid-turn when an alert fires, it queues in `_pendingAlerts` and drains at the next safe turn boundary. Critical alerts (`temp_high`, `kp41`) also checkpoint the current task state to `data/memory/task_state.json`.

### Multi-agent (CORAL)

`spawn_agent` launches background agents with isolated message histories. Agents share data via a workspace and communicate skills via the **CORAL versioned log** -- an append-only broadcast channel. Skills are pulled at turn boundaries (never mid-execution) using a monotonic version counter so each agent only receives entries it hasn't seen. Cross-platform filtering ensures Windows-crystallized skills are not broadcast to Linux agents.

### Longitudinal machine records

Every boot creates or updates a machine fingerprint at `data/memory/machines/<id>.json`. The record tracks UUID, first seen date, visit count, hostname history, and a capped 50-entry history of capability snapshots. `machineTrend()` computes visits/day, span, unique tools seen, and recent changes. `machine_health_trend` exposes this in conversation.

### Runtime state diffing

`diff_machine_state` captures a live snapshot (running processes, listening ports, loaded drivers, TCP connection count) and diffs it against a saved baseline. The first call saves the baseline; subsequent calls report new/gone processes, opened/closed ports, loaded/removed drivers, and connection count delta. Turns "my network is suddenly slow" into a concrete delta report.

### API failover

Per-provider failure tracking with a 2-strike threshold. On two consecutive 429/401/403 errors, the failing provider is blocked for 15 minutes and Athena switches to the next available one automatically. `getProviderStatus()` shows current failure counts and reset times.

---

## What lives where

```
config/.env                         -- your keys and settings (gitignored)
data/memory/athena.md               -- Athena's long-term notes
data/memory/user.md                 -- facts about you (gitignored)
data/memory/instincts.md            -- auto-promoted behavioral patterns
data/memory/prohibited_patterns.md  -- dead ends on this machine
data/memory/summary.md              -- rolling session summaries (gitignored)
data/memory/embeddings.jsonl        -- semantic memory vectors (gitignored)
data/memory/machines/               -- longitudinal machine fingerprints
data/memory/task_state.json         -- watcher checkpoint (last interrupted task)
data/memory/errors.jsonl            -- error telemetry log (gitignored)
runtime/models/                     -- local LLM model files (.gguf, gitignored)
data/llm_server.log                 -- llama-server output log (gitignored)
data/sessions/                      -- full session transcripts (gitignored)
skills/                             -- self-built skill library
athena/                             -- source code
runtime/                            -- portable Node binaries (gitignored)
```

## Source layout

```
athena/
  athena.mjs        entry point (CLI + UI)
  api.mjs           LLM streaming, provider failover (OpenAI + Anthropic)
  agents.mjs        multi-agent pool, CORAL versioned log, shared workspace
  audit.mjs         append-only tool call audit trail
  capabilities.mjs  machine capability detection at boot
  compress.mjs      tool output compression (JSON, code, logs)
  config.mjs        env loading, constants, model lists
  core.mjs          turn loop, task runner, crystallization, watcher drain
  embed.mjs         embeddings, cosine similarity recall
  machines.mjs      fingerprinting, trend, runtime state capture + diff
  memory.mjs        long-term memory, instinct promotion, prohibited patterns
  network.mjs       network situational awareness tool
  paths.mjs         all filesystem paths
  personality.mjs   system prompt builder (memory + instincts + prohibited)
  remediate.mjs     guided remediation playbooks
  report.mjs        system / security / network report generator
  skills.mjs        skill scan, load, save, update, status verification
  threat.mjs        threat surface assessment
  tools.mjs         all tool definitions, handlers, classifyRisk()
  triage.mjs        boot health check
  ui.mjs            browser UI server, SSE streaming, HTML
  control_engine.mjs  L2 deterministic diagnostic engine (offline, no LLM)
  local_llm.mjs       L3 local LLM lifecycle (llama-server subprocess)
  memory_gc.mjs       memory garbage collector (dedup, contradictions, decay)
  telemetry.mjs       error logging to errors.jsonl
  tokens.mjs          token budget estimator (model-aware compression)
  watcher.mjs         proactive background polling engine
```

### Offline mode

Athena has three intelligence tiers that degrade gracefully:

| Tier | Requires | What works |
|------|----------|-----------|
| **L4** Cloud AI | Internet + API key | Full AI reasoning, tool calling, all features |
| **L3** Local AI | `get-offline.sh` run once | Same as L4 but slower, no internet needed |
| **L2** Control Engine | Nothing | Deterministic diagnostics: disk, network, processes, logs, ports, services, users, environment |

**L2 is always available** -- even with no model, no key, and no wifi. Just ask naturally ("check disk space", "is the network up", "what processes are eating CPU") and the control engine runs the right diagnostic workflows directly. Boots in under 2 seconds regardless of model state.

---

## Security

- API keys sit in `config/.env` in plaintext. If you lose the drive, rotate the keys.
- `AUTO_APPROVE=true` in `.env` skips all approval gates. Only use on machines you fully trust.
- Tiered autonomy: read-only tools run silently, low-impact writes are logged, destructive operations block for explicit approval.
- Auto-crystallized skills are `status: unverified` and require user approval (Tier 2) before first execution. Approval promotes to verified -- chain-loading an unverified skill from inside a verified one still triggers the approval gate.
- Prohibited patterns are logged to `prohibited_patterns.md` when a tool chain fails repeatedly. This prevents Athena from re-attempting known broken approaches on the same machine.

---

## Roadmap

| Phase | Version | What shipped |
|-------|---------|-------------|
| **1** | v1.0 | Portable launchers (Windows/macOS/Linux), chat, shell + file tools, basic memory |
| **2** | v1.1 | Web fetch, live web search, patch/diff editing, multi-step task runner (`/task`) |
| **3** | v1.2 | Rolling session summaries, session save/resume, auto-compression at 40 messages |
| **4** | v2.0 | Multi-provider (OpenAI + Anthropic), semantic recall via embeddings |
| **5** | v2.1 | Multi-agent system, skill library, full web UI, tool output compression |
| **6** | v2.2 | Machine capability detection at boot, portable Python + Loki scanner |
| **8** | v3.0 | Tiered autonomy -- `classifyRisk()` replaces flat DESTRUCTIVE set (Tier 0/1/2) |
| **9** | v3.0 | Auto-crystallization -- post-task cheap-model hook saves repeatable patterns as skills |
| **10** | v3.0 | Instinct auto-promotion -- conf-scored patterns promoted to `instincts.md` after 3+ sessions |
| **11** | v3.0 | Longitudinal machine records -- UUID, visit history, capability drift tracking |
| **12** | v3.0 | Proactive watcher -- disk, KP41 crashes, CPU temp, network change monitoring |
| **13-15** | v3.0 | CORAL peer learning, API failover (OpenAI <-> Anthropic) |
| **16a** | v3.0 | CORAL versioned pull model -- version-tracked, pull-at-turn-boundary, no race conditions |
| **16b** | v3.0 | Watcher preemption fix -- alert queueing during active turns, task state checkpoint |
| **16c** | v3.0 | Negative knowledge -- `prohibited_patterns.md` injected into system prompt |
| **16d** | v3.0 | `query_machine_logs` -- filtered OS event log queries before LLM context |
| **16e** | v3.0 | `diff_machine_state` -- runtime process/port/driver diff vs boot baseline |
| **16f** | v3.0 | Skill trust chain -- unverified skills blocked (Tier 2), CORAL platform filtering, circular crystallization prevention |
| **17** | v3.1 | Offline-first architecture -- L2 Control Engine (deterministic diagnostics, zero dependencies), L3 local LLM via llama.cpp (non-blocking, Phi-3.5-mini ~2.2 GB). Graceful degradation: Cloud AI -> Local AI -> Control Engine. Also: BM25 offline recall, skill versioning + rollback, token-aware compression, memory GC (dedup/contradiction/decay), error telemetry, expanded watcher (RAM/CPU/battery/login/reboot + alert correlation), sudo lockout |
