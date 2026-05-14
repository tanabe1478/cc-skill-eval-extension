---
description: Scaffold evals/eval.json for a skill directory
argument-hint: "[skill-dir]"
allowed-tools: Bash(node:*)
---

Run the following command via Bash and report the output to the user:

```bash
node ~/.claude/scripts/skill-eval.mjs init $ARGUMENTS
```

If `$ARGUMENTS` is empty, the current working directory is used as the skill directory.
After running, briefly summarize what was created (or note if the file already existed) and remind the user to fill in the `TODO:` placeholders in `evals/eval.json` before running `/skill-eval-run`.
