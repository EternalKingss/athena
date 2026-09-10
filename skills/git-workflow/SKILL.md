---
name: git-workflow
description: Git conventions — commit messages, branching, PRs, cleaning up history
---

# Git Workflow

## Commit message format
```
<type>: <short summary under 72 chars>

<optional body — what changed and why, not how>
```

Types: `feat` `fix` `refactor` `docs` `test` `chore` `style`

Examples:
- `feat: add web search tool using Brave API`
- `fix: clipboard write fails on Linux when text has quotes`
- `refactor: extract provider resolution into resolveProvider()`

## Before committing
```bash
git status           # see what changed
git diff             # review unstaged changes
git diff --staged    # review staged changes
```

## Branch naming
- Feature: `feat/short-description`
- Fix: `fix/what-was-broken`
- Experiment: `exp/idea-name`

## Common operations
```bash
# Start clean feature branch
git checkout -b feat/my-feature

# Stage specific files (never git add .)
git add src/specific-file.js

# Amend last commit message (before push)
git commit --amend -m "fix: better message"

# Undo last commit but keep changes
git reset --soft HEAD~1

# See full log with graph
git log --oneline --graph --all

# Clean up merged branches
git branch --merged | grep -v main | xargs git branch -d
```

## PR checklist
- [ ] One concern per PR
- [ ] Tests pass
- [ ] No debug logs or commented-out code left in
- [ ] Commit messages are clean
