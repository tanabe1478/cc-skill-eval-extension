# cc-skill-eval-extension

[日本語ドキュメント](README-ja.md)

Empirical skill evaluation harness for [Claude Code](https://docs.claude.com/en/docs/claude-code), ported from [pi-skill-eval-extension](https://github.com/tanabe1478/pi-skill-eval-extension) and inspired by mizchi/skills, `@mizchi/waxa`, and empirical-prompt-tuning.

It evaluates a skill by running fixed scenarios through a fresh blank-slate `claude -p` executor, collecting structured Self-reports, grading outputs, and persisting results / ledger files.

## Install

```bash
# Slash commands
mkdir -p ~/.claude/commands
cp commands/skill-eval-*.md ~/.claude/commands/

# Script (the slash commands call this)
mkdir -p ~/.claude/scripts
cp scripts/skill-eval.mjs ~/.claude/scripts/
chmod +x ~/.claude/scripts/skill-eval.mjs

# (Optional) Skill description so Claude can discover the harness automatically
mkdir -p ~/.claude/skills/skill-eval
cp skills/skill-eval/SKILL.md ~/.claude/skills/skill-eval/
```

Requirements: Node 18+ and the `claude` CLI on `$PATH`.

## Commands

### Scaffold

Run inside a skill directory, or pass the skill directory path:

```txt
/skill-eval-init path/to/my-skill
```

Creates `path/to/my-skill/evals/eval.json` with typical / edge / hold-out templates.

### Iteration 0 (static review)

```txt
/skill-eval-iter0 path/to/my-skill
```

Checks whether the frontmatter `description` matches what the body actually covers. Writes `evals/iter0-<timestamp>.md`.

### Run

```txt
/skill-eval-run path/to/my-skill/evals/eval.json --ledger
```

Options:

```txt
--task <id>      Run one scenario
--baseline       Also run without the skill body and report delta
--ledger         Append summary to evals/ledger.json
--holdout        Include hold-out tasks (use only near convergence)
```

You can also invoke the script directly without Claude:

```bash
node ~/.claude/scripts/skill-eval.mjs run path/to/my-skill/evals/eval.json --ledger
```

## Eval file format

`eval.json` is intentionally JSON rather than YAML so the harness has no runtime dependencies.

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
    {
      "name": "self_report_clean",
      "type": "selfReport",
      "requireAllPhasesOk": true,
      "maxRetries": 2
    }
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

Supported graders:

- `contains`
- `regex`
- `regexNot`
- `selfReport`
- `llm`

## Method

The harness follows these principles:

- keep scenarios fixed before iterating
- use typical + edge scenarios
- run fresh blank-slate executors, not self-rereads
- require at least one `[critical]` requirement per task
- collect `Unclear points`, `Discretionary fill-ins`, and `Retries`
- compare `with_skill` vs `without_skill` with `--baseline`
- treat two consecutive zero-unclear runs as convergence

## Output

Each run writes:

```txt
evals/results/<timestamp>/result.json
evals/results/<timestamp>/summary.md
```

With `--ledger`, it also appends:

```txt
evals/ledger.json
```

## Blank-slate caveat

Claude Code does not expose a single flag to suppress `CLAUDE.md`, project skills, MCP servers, and prompt templates the way `pi -p --no-*` does. To approximate a clean executor, run `/skill-eval-run` from a directory without an inherited `CLAUDE.md` (e.g., a temporary scratch directory), or set `config.model` to a small model so even an "impure" baseline is consistent across trials.

## License

MIT
