# Contributing to Athena

Thanks for your interest. Here's how to get started.

## Core constraints (read this first)
- **No npm / no node_modules** -- Athena has zero external dependencies. All code uses Node.js built-ins only.
- **ES modules only** -- `.mjs` files, `import`/`export` syntax, no CommonJS.
- **ASCII only in source** -- no em dashes or smart quotes. Use `--` not `--`. Files truncate silently on non-ASCII.
- **No local model inference** -- Athena calls external LLM APIs. We are not adding bundled models.

## Setup
```bash
# Clone
git clone https://github.com/EternalKingss/athena.git
cd athena

# Copy and fill in your API keys
cp config/.env.example config/.env
# edit config/.env

# Download Node.js runtime for your platform (see runtime/ folder)
# Then run:
./start.sh          # Linux/macOS
Athena.bat          # Windows
```

## Running tests
```bash
node regression.mjs
```
All 55 tests must pass before submitting a PR.

## Making changes

### Adding a tool
1. Add the tool definition to the `TOOLS` array in `athena/tools.mjs`
2. Add a handler in `runTool()` in the same file
3. Add it to `classifyRisk()` with the appropriate tier (0, 1, or 2)
4. Add a regression test in `regression.mjs`

### Adding a skill
Create `skills/<name>/SKILL.md` with frontmatter:
```
---
name: your-skill-name
description: one-line description
created: YYYY-MM-DD
status: verified
---

Skill content here...
```

### Modifying core files
Use Python scripts via bash for large edits to `.mjs` files to avoid truncation bugs:
```bash
python3 -c "
content = open('athena/core.mjs').read()
content = content.replace('old', 'new')
open('athena/core.mjs', 'w').write(content)
"
```

## Pull request checklist
- [ ] All 55 regression tests pass (`node regression.mjs`)
- [ ] No npm packages added
- [ ] No em dashes or non-ASCII in source files
- [ ] New tools have classifyRisk() tier assigned
- [ ] New auto-crystallized skills saved as `status: unverified`
- [ ] PR description explains what changed and why

## Architecture overview
See `CLAUDE.md` for a full breakdown of the architecture, tiered autonomy, skill trust chain, and CORAL peer learning system.

## Questions
Open a GitHub Discussion or email forcepack6@gmail.com.
