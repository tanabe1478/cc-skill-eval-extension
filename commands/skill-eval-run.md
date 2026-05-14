---
description: "Run empirical skill evaluation: /skill-eval-run <eval.json> [--task id] [--baseline] [--ledger] [--holdout]"
argument-hint: "<eval.json> [--task <id>] [--baseline] [--ledger] [--holdout]"
allowed-tools: Bash(node:*)
---

Run the following command via Bash and report the resulting summary (passRate, requirementAccuracy, criticalSuccessRate, baseline delta if requested, and per-task unclear/retry counts). The script spawns fresh `claude -p` blank-slate executors for each trial; this can take several minutes.

```bash
node ~/.claude/scripts/skill-eval.mjs run $ARGUMENTS
```

Flags:
- `--task <id>` — run a single scenario by id
- `--baseline` — also run the without-skill baseline and report the delta
- `--ledger` — append the run to `evals/ledger.json` and update convergence/divergence/plateau signals
- `--holdout` — include hold-out scenarios (use only near convergence to check overfitting)

After running, summarize the headline metrics, list any unclear points that the executor reported, and (if `--ledger` was used) state whether the ledger flipped to `converged: true`. Full results are written to `evals/results/<timestamp>/result.json` and `summary.md`.
