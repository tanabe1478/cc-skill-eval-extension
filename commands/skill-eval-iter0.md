---
description: Run Iteration 0 description/body consistency review for a skill
argument-hint: "[skill-dir-or-SKILL.md] [--model <id>]"
allowed-tools: Bash(node:*)
---

Run the following command via Bash and report the output to the user verbatim (the reviewer verdict, missing coverage, over-broad triggers, and required edits). The script invokes a fresh `claude -p` executor as the reviewer.

```bash
node ~/.claude/scripts/skill-eval.mjs iter0 $ARGUMENTS
```

If `$ARGUMENTS` is empty, the current working directory is reviewed. Output is also written to `<skill>/evals/iter0-<timestamp>.md`.
