---
name: skill-eval
description: Empirical evaluation of Claude Code skills using a fresh `claude -p` blank-slate executor. Use when iterating on a SKILL.md and you want fixed-scenario evals (typical / edge / hold-out), structured Self-report (phase trace, unclear points, fill-ins, retries), grading (contains / regex / regexNot / selfReport / llm), with_skill vs without_skill baseline, and a ledger that tracks convergence (two zero-unclear runs in a row), divergence (three consecutive runs of non-decreasing new unclear), and plateau (accuracy delta < threshold) signals. Inspired by mizchi/skills, @mizchi/waxa, and empirical-prompt-tuning.
---

# skill-eval (Claude Code)

Empirical skill evaluation harness for Claude Code skills, ported from [pi-skill-eval-extension](https://github.com/tanabe1478/pi-skill-eval-extension).

The harness deliberately does **not** rely on re-reading the skill yourself and judging it "looks good." It feeds the skill into a fresh `claude -p` executor, runs a fixed scenario, and asks the executor to self-report what was unclear.

## Slash commands

- `/skill-eval-init [skill-dir]` — scaffold `evals/eval.json` with typical / edge / hold-out templates.
- `/skill-eval-iter0 [skill-dir] [--model <id>]` — static review: does the frontmatter `description` match what the body actually covers?
- `/skill-eval-run <eval.json> [--task id] [--baseline] [--ledger] [--holdout]` — run fixed scenarios in a fresh `claude -p` executor.

All three call `node ~/.claude/scripts/skill-eval.mjs <subcommand>` under the hood.

## Method

1. **Iteration 0**: static check that `description` and body agree. Run `/skill-eval-iter0` before any execution evals.
2. **Fix scenarios first, iterate later.** Edit `eval.json` to include realistic typical and edge requests. Mark at least one requirement per task as `critical: true`.
3. **Run blank-slate execution.** `/skill-eval-run` spawns a fresh `claude -p` for every trial so the executor cannot rely on prior session state.
4. **Read the Self-report.** Each trial returns Phase trace, Requirement achievement, Unclear points (with general fix rule), Discretionary fill-ins, and Retries.
5. **One iteration = one theme.** Pick a single recurring `General Fix Rule` from the unclear list, edit the SKILL.md, re-run.
6. **Compare against baseline.** Use `--baseline` periodically to confirm the skill actually beats no-skill.
7. **Convergence**: two consecutive zero-unclear runs (configurable via `convergenceZeroUnclearRuns`).
8. **Divergence signal**: three consecutive runs where new-unclear count does not decrease — your edits are introducing as many problems as they fix.
9. **Hold-out**: keep one or more `holdout: true` scenarios out of normal iteration. Run `--holdout` only near convergence to detect overfitting.

## Eval file format

`evals/eval.json` (no YAML, no runtime deps):

```json
{
  "name": "my-skill-eval",
  "skillPath": "..",
  "config": {
    "model": "sonnet",
    "trialsPerTask": 2,
    "timeoutSeconds": 300,
    "convergenceZeroUnclearRuns": 2
  },
  "graders": [
    { "name": "self_report_clean", "type": "selfReport", "requireAllPhasesOk": true, "maxRetries": 2 }
  ],
  "tasks": [
    {
      "id": "scenario-typical",
      "name": "Typical use case",
      "prompt": "A realistic median user request.",
      "requirements": [
        { "critical": true, "text": "Minimum critical outcome" },
        { "text": "Normal quality requirement" }
      ],
      "expectedContains": [],
      "graders": []
    }
  ]
}
```

### Grader types

| Type | Purpose |
|------|---------|
| `contains` | Output must include every string in `values`. |
| `regex` | Output must match every pattern in `patterns`. |
| `regexNot` | Output must NOT match any pattern in `patterns`. |
| `selfReport` | Self-report must satisfy `requireAllPhasesOk` / `maxUnclear` / `maxRetries`. |
| `llm` | A second `claude -p` call judges the output against `rubric` and returns PASS/SCORE/REASON. |

## Output

```
evals/results/<timestamp>/result.json   # full per-trial detail + summary
evals/results/<timestamp>/summary.md    # human-readable headline metrics
evals/ledger.json                       # appended only with --ledger
```

Headline metrics:

- `passRate` — fraction of graders that passed across all trials
- `requirementAccuracy` — average of pass=1.0 / partial=0.5 / else=0 over requirements
- `criticalSuccessRate` — fraction of trials where every `[critical]` requirement passed
- `meanDurationMs` — average trial wall time
- `unclearCount` — total unclear points reported by executors

Ledger signals:

- `converged: true` — last N (default 2) runs all had `unclearCount === 0`
- `divergenceSignal: true` — last 3 runs all had non-decreasing `newUnclearCount`
- `plateau` — `{ accuracyDeltaPoints, durationDeltaPct }` vs previous run

## Notes on blank-slate execution

Claude Code does not provide a single flag to suppress all of `CLAUDE.md`, project skills, MCP servers, and prompt templates in one go. To approximate the pi `--no-extensions --no-skills --no-context-files` flags, run `/skill-eval-run` from a directory that:

- has no `CLAUDE.md` at any ancestor level, or
- is a temporary scratch directory you `cd` into before invoking the command,

so the spawned `claude -p` cannot inherit unrelated project context. Adding `--model haiku-4-5` (or another small model) via `config.model` keeps the cost of multiple trials reasonable.
