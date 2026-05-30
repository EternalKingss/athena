# Athena — Portable AI Agent

A personal AI agent that lives on this drive and runs on whatever computer you
plug into. It can run shell commands and read/write files on the host machine to
fix things, set stuff up, and get work done. Its memory lives on the drive, so it
travels with you. The "brain" is an OpenAI API call, so the host needs internet —
but nothing about Athena is installed on the host, and nothing is left behind.

## One honest reality
A drive cannot auto-launch a program when you plug it in — every modern OS killed
that for security. The floor is **one double-click**. Everything else works.

## First-time setup (do this once, on the drive)

### 1. Add a key
- Copy `config/.env.example` to `config/.env`
- Put your OpenAI API key in it. Set the model if you want something other than `gpt-4o`.

### 2. Add portable Node (one per OS you'll use)
Download the official builds from https://nodejs.org/dist/ (Node 22 LTS or newer)
and lay them out so each launcher finds `node`:

| OS / chip            | Download                          | Put it so this path exists            |
|----------------------|-----------------------------------|---------------------------------------|
| Windows x64          | `node-vXX-win-x64.zip`            | `runtime/win-x64/node.exe`            |
| Windows ARM          | `node-vXX-win-arm64.zip`          | `runtime/win-arm64/node.exe`          |
| macOS Apple Silicon  | `node-vXX-darwin-arm64.tar.gz`    | `runtime/mac-arm64/bin/node`          |
| macOS Intel          | `node-vXX-darwin-x64.tar.gz`      | `runtime/mac-x64/bin/node`            |
| Linux x64            | `node-vXX-linux-x64.tar.xz`       | `runtime/linux-x64/bin/node`          |
| Linux ARM            | `node-vXX-linux-arm64.tar.xz`     | `runtime/linux-arm64/bin/node`        |

(Unzip the archive and copy its *contents* into the folder above. You only need the
platforms you actually plug into — most people: one Windows + one Mac.)

## Running it
- **Windows:** double-click `Athena.bat`
- **macOS:** double-click `Athena.command` (first time: right-click → Open to clear Gatekeeper; may need `chmod +x Athena.command`)
- **Linux:** `./start.sh` (may need `chmod +x start.sh`)

Type to talk. Commands: `/exit` saves and quits, `/mem` shows long-term memory,
`/forget` clears the current context, `/help` lists them.

When Athena wants to run a command or write a file, it shows you what it's about to
do and waits for `y`. (Set `AUTO_APPROVE=true` in `.env` to skip that — only on
machines you trust.)

## What lives where
- `config/.env` — your key and settings (stays on the drive)
- `data/memory/athena.md` — long-term memory, hand-editable, loaded every launch
- `data/memory/summary.md` — rolling auto-summary, appended on exit
- `data/sessions/` — full transcripts, one file per session

## Security — read this
- Your API key sits in plaintext in `config/.env`. If you lose the drive or plug into
  a compromised machine, treat the key as burned and rotate it. (Passphrase encryption
  is a planned upgrade — Phase 3.)
- Do **not** plug this into locked-down or monitored machines (work, government,
  someone else's secured box). An agent running shell commands and phoning out to an
  API is exactly what those environments flag.

## Roadmap
- **Phase 1 (this):** portable launchers, chat, host tools (shell + file r/w), memory.
- **Phase 2:** richer tools — patch/diff edits, multi-step task runner, web fetch for live info.
- **Phase 3:** passphrase-encrypted key, smarter rolling memory, session resume.
- **Phase 4 (optional):** semantic recall (sqlite + embeddings on the drive).
