---
name: council
description: Multi-voice decision framework — spawn 3 parallel advisor agents (Architect, Skeptic, Pragmatist) to surface tradeoffs before committing to an ambiguous choice
---

# Council

Use when a decision has multiple credible paths and real tradeoffs. Not for factual questions or implementation tasks — those have right answers. Council is for genuine forks where the choice shapes everything that comes after.

## When to use
- Architecture choices (monorepo vs split, rewrite vs patch, lib A vs lib B)
- Fix strategy forks (nuke and reinstall vs surgical fix vs workaround)
- Go/no-go calls (ship now vs polish, expose vs hide, automate vs manual)
- Any decision where you catch yourself going back and forth

## When NOT to use
- Factual questions — just answer them
- Code correctness — check it, don't debate it
- Implementation tasks — pick the obvious path and execute

## How to run it

**Step 1 — Extract the question**
Reduce the decision to one sentence. If you can't, the decision isn't ready yet.
Example: "Should I fix the firewall by reinstalling ufw or by editing the rules directly?"

**Step 2 — State your position first**
Write down what you currently think before spawning agents. This prevents anchoring.
"I lean toward reinstalling because the rules file looks corrupted."

**Step 3 — Spawn 3 agents in parallel**
Each gets ONLY: the question + the minimum context snippets (no full history).

```
spawn_agent("architect", "Decision: [question]. Context: [1-3 relevant facts].
Advise from the Architect perspective: focus on correctness, system integrity, and long-term implications. What are the risks of each path? What breaks 6 months from now?")

spawn_agent("skeptic", "Decision: [question]. Context: [1-3 relevant facts].
Advise from the Skeptic perspective: challenge the premises. What assumptions are we making? What could go wrong with the leading option? What are we not seeing?")

spawn_agent("pragmatist", "Decision: [question]. Context: [1-3 relevant facts].
Advise from the Pragmatist perspective: what is the fastest path that actually works? What is the cost of delay? Which option unblocks us right now?")
```

**Step 4 — Synthesize**
Read all 3 workspace results. Ask:
- What changed your initial view?
- Where do the advisors agree? Where do they disagree?
- What disagreement is worth keeping visible vs. resolving?

**Step 5 — Verdict**
State the decision + the key reason. Keep the dissent visible — don't fake consensus.

Example output:
> **Decision: Reinstall ufw**
> Architect and Pragmatist agree the rule file is the root issue, not config drift.
> Skeptic flagged that reinstalling clears custom rules — confirmed: we have none.
> Dissent: Pragmatist wanted to just flush rules; Architect overruled on integrity grounds.

## Guardrails
- Never let one voice dominate by giving it more context than the others
- If all 3 agree immediately, either the decision was obvious (don't use Council) or the context was too narrow (re-run with less bias)
- Synthesis is your job — don't delegate it to a 4th agent
