# Security Policy

## What runs locally
Athena runs entirely on your machine. The agent runtime, browser UI, skill system, and all persistent data
stay on your device. No telemetry, no analytics, no data leaves your machine except the prompts you
explicitly send to the LLM provider you configure (OpenAI, Anthropic, etc.).

## What does leave your machine
- Prompts and context sent to your configured LLM API (OpenAI / Anthropic)
- Web search queries if you use the `web_search` tool
- Nothing else

## API keys
Your API keys live in `config/.env` and are never committed to version control (`.gitignore` excludes it).
Never share your `.env` file or paste API keys in public issues.

## Reporting a vulnerability
If you find a security issue, please **do not open a public GitHub issue**.

Email: forcepack6@gmail.com

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested fix (optional)

We will respond within 72 hours and aim to release a patch within 7 days for critical issues.

## Scope
- In scope: code execution paths, skill trust chain bypass, credential exposure, CORAL swarm injection
- Out of scope: vulnerabilities in third-party LLM APIs themselves

## Tiered autonomy
Athena has a built-in tiered autonomy system (Tier 0/1/2) that controls what the agent can do without
explicit user approval. Destructive operations (file deletion, system writes, shell commands) require
Tier 2 confirmation by default. If you find a way to bypass this gate, please report it.
