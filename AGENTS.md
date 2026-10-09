# Athena — Codex Project Brief

## What this is
Portable AI agent that runs from a USB/HDD drive. Zero npm dependencies. Node.js ES modules only.
Browser UI served locally. Claude (Anthropic API) does all reasoning, diagnosis and fixing. An optional small local model
(llama.cpp) handles basic commands only -- volume, media, browser tabs -- and is never a fallback for Claude.
Offline, the only job is restoring the connection: hard-coded Wi-Fi/network triage in `net_triage.mjs`.

## Key constraints
- **No npm / no node_modules** — everything is vanilla Node.js built-ins + dynamic `import()` for stdlib
- **ES modules only** — all files are `.mjs`, use `import`/`export`, no CommonJS
- **ASCII only in source** — em dashes (U+2014 `--`) truncate files in Edit/Write tools. Always use `--` not `--`
- **File edits via Python bash scripts** — for any `.mjs` file modification, use Python heredoc in bash to avoid truncation bugs

## Entry points
- `Athena.bat` — Windows launcher
- `Athena.command` — macOS launcher
- `start.sh` — Linux launcher
- `athena/athena.mjs` — main process

## Source layout
```
athena/
  athena.mjs       -- main loop, CLI + browser server
  core.mjs         -- runTask(), crystallize(), tiered autonomy gate
  tools.mjs        -- all tool implementations + classifyRisk()
  skills.mjs       -- scanSkills(), loadSkill(), saveSkill(), updateSkill(), getSkillStatus()
  agents.mjs       -- CORAL peer learning, pullCoralUpdates(), broadcast
  memory.mjs       -- read/write persistent memory
  personality.mjs  -- system prompt assembly
  watcher.mjs      -- proactive background watcher engine
  machines.mjs     -- longitudinal machine records
  api.mjs          -- LLM API calls, model failover
  config.mjs       -- load .env, provider config
  paths.mjs        -- PATHS constant (data/, skills/, runtime/, config/)
  capabilities.mjs -- capability detection (OS, tools available)
  compress.mjs     -- context compression
  triage.mjs       -- task triage / prioritization
  remediate.mjs    -- auto-remediation
  embed.mjs        -- embeddings
  net_triage.mjs   -- offline Wi-Fi/network triage (the only offline behaviour)
  task_router.mjs  -- routes basic commands to the local model; fixing always goes to Claude
  agent_loop.mjs   -- bounded tool loop used by the local model
  kernel/          -- module registry, router (approval enforced here for modules), daemon
  modules/         -- system.mjs (Module 1), browser.mjs + browser/relay.mjs (Module 2), google.mjs (Module 3)

extension/         -- Chrome extension (Module 2); talks to the relay on 127.0.0.1:17861

skills/            -- each skill is a folder with SKILL.md
  system-health/
  council/
  git-workflow/
  ...

data/
  memory/
    athena.md      -- persistent agent memory
    instincts.md   -- promoted instinct patterns
  sessions/        -- session logs

config/
  .env             -- API keys (never committed)
  .env.example     -- template

runtime/           -- Node.js binary lives here (not committed, downloaded on first run)

selfcheck.mjs      -- test suite (run from the Athena root; skips checks that need your data/Google login)
```

## Architecture: tiered autonomy
Every tool call goes through `classifyRisk()` in `tools.mjs`:
- **Tier 0** -- silent auto-run (read-only, safe queries)
- **Tier 1** -- auto-run + logged as `action_taken`
- **Tier 2** -- blocks, emits `approval_required`, waits for explicit user confirmation

## Skill trust chain
Auto-crystallized skills are saved with `status: unverified` in SKILL.md frontmatter.
`classifyRisk` returns Tier 2 for `load_skill` calls targeting unverified skills.
On user approval, `load_skill` handler promotes the skill to `status: verified` atomically.

## CORAL (peer learning)
Versioned append-only log. Agents track `lastCoralVersion` and pull only new entries at turn boundaries.
Platform field recorded at broadcast time; `pullCoralUpdates` filters to matching platform only.

## Crystallization
After tasks with >= 4 primitive tool calls, `crystallize()` uses a cheap model to generate a reusable skill.
`load_skill` calls are filtered from the tool trace before crystallization to prevent circular drift.
All auto-crystallized skills are saved `unverified`.

## Common patterns
```js
// Reading a file safely
import { readFileSync } from 'node:fs';
const content = readFileSync(path, 'utf8');

// Emitting events to UI
emit({ type: 'text', text: 'message' });
emit({ type: 'system', text: 'internal note' });
emit({ type: 'approval_required', tool: name, args, tier: 2 });

// Saving a skill
await saveSkill(name, description, content, 'unverified'); // auto-crystallized
await saveSkill(name, description, content, 'verified');   // manual
```

## Running the tests
```bash
node selfcheck.mjs
```
Covers tiered autonomy and approval enforcement, shell risk classification, network triage, stall protection,
the browser relay, skill trust chain, routing, and a live boot. Every PR must leave it at 0 failed.

## What NOT to do
- Do not use `npm install` or introduce package.json dependencies
- Do not use CommonJS (`require`, `module.exports`)
- Do not use em dashes in source files -- use `--` instead
- Do not use Edit/Write tools on .mjs files for large changes -- use Python bash scripts
- Do not hardcode API keys -- they live in `config/.env`
