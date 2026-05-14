# cc-skill-eval-extension 日本語ガイド

`cc-skill-eval-extension` は [Claude Code](https://docs.claude.com/en/docs/claude-code) 上で **agent skill を empirical-prompt-tuning 方式で評価・改善する**ためのハーネスです。[`pi-skill-eval-extension`](https://github.com/tanabe1478/pi-skill-eval-extension) の Claude Code 移植版で、`pi -p` を `claude -p` に置き換えています。

参考にしているもの:

- [mizchi/skills](https://github.com/mizchi/skills)
- [`@mizchi/waxa`](https://www.npmjs.com/package/@mizchi/waxa)
- [empirical-prompt-tuning](https://github.com/mizchi/skills/blob/main/empirical-prompt-tuning/SKILL.md)
- [Zenn: empirical-prompt-tuning](https://zenn.dev/mizchi/articles/empirical-prompt-tuning)

方針は「自分で読み直して良さそうと判断しない」です。skill を fresh な `claude -p` executor に実際に読ませ、固定した scenario を実行させ、詰まった点を Self-report として返させます。その結果を見て、skill を 1 iteration 1 テーマで直します。

---

## できること

- Iteration 0: `description` と本文の静的整合性チェック
- typical / edge / hold-out scenario の雛形生成
- fresh な `claude -p` executor による blank-slate 実行
- `with_skill` / `without_skill` baseline 比較
- requirements checklist の達成率集計
- `[critical]` requirement の成功率集計
- structured Self-report の収集
- `contains` / `regex` / `regexNot` / `selfReport` / `llm` grader
- unclear point と General Fix Rule の ledger 化
- 2 回連続 unclear 0 による convergence 判定
- 3 回連続で new unclear が減らない場合の divergence signal
- hold-out scenario による過適合チェック

---

## インストール

### user global として使う

```bash
# slash commands
mkdir -p ~/.claude/commands
cp commands/skill-eval-*.md ~/.claude/commands/

# 実体スクリプト (slash commands から呼ばれる)
mkdir -p ~/.claude/scripts
cp scripts/skill-eval.mjs ~/.claude/scripts/
chmod +x ~/.claude/scripts/skill-eval.mjs

# (任意) Claude が自動で気づけるよう skill としても置く
mkdir -p ~/.claude/skills/skill-eval
cp skills/skill-eval/SKILL.md ~/.claude/skills/skill-eval/
```

必要なもの: Node 18+ と `claude` CLI が `$PATH` 上にあること。

### project-local extension として使う

`./.claude/commands/` `./.claude/skills/skill-eval/` 配下にコピーしてもプロジェクト単位で使えます (スクリプトの参照パスはユーザー global の `~/.claude/scripts/skill-eval.mjs` を前提にしているので、ローカルに置く場合は commands の `node ~/.claude/scripts/skill-eval.mjs` を書き換えてください)。

---

## 使い方

### 1. Iteration 0: 静的整合性チェック

実行評価をする前に、まず description と本文がそろっているかを `claude -p` reviewer に確認させます。

```txt
/skill-eval-iter0 path/to/my-skill
```

出力は `evals/iter0-<timestamp>.md` に保存されます。

### 2. eval.json を作る

```txt
/skill-eval-init path/to/my-skill
```

`evals/eval.json` に typical / edge / hold-out 3 種のテンプレートが書き込まれます。`TODO:` を埋めてください。**少なくとも 1 つの requirement に `critical: true` を付ける**ことを忘れずに。

### 3. eval を実行する

```txt
/skill-eval-run path/to/my-skill/evals/eval.json --ledger
```

オプション:

| Flag | 効果 |
|------|------|
| `--task <id>` | 1 つの scenario だけ実行 |
| `--baseline` | skill 本文を渡さない baseline も実行し、delta を比較 |
| `--ledger` | `evals/ledger.json` に結果を追記し、convergence/divergence/plateau を判定 |
| `--holdout` | hold-out scenario を含める (convergence 直前のみ推奨) |

slash command を経由せず、シェルから直接叩くこともできます:

```bash
node ~/.claude/scripts/skill-eval.mjs run path/to/my-skill/evals/eval.json --ledger
```

---

## eval.json の形式

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
      "prompt": "...",
      "requirements": [
        { "critical": true, "text": "..." },
        { "text": "..." }
      ],
      "expectedContains": [],
      "graders": []
    }
  ]
}
```

### Grader

| Type | 用途 |
|------|------|
| `contains` | 出力に `values` の全要素が含まれていること |
| `regex` | 出力が `patterns` すべてに match すること |
| `regexNot` | 出力が `patterns` のどれにも match しないこと |
| `selfReport` | Self-report の phase / unclear / retries 条件を満たすこと |
| `llm` | もう一度 `claude -p` を呼び、`rubric` で PASS/SCORE/REASON を判定 |

---

## 出力

```
evals/results/<timestamp>/result.json   # 全 trial の詳細 + summary
evals/results/<timestamp>/summary.md    # 人間用ヘッドライン
evals/ledger.json                       # --ledger 指定時のみ追記
```

ledger には以下のシグナルが立ちます:

- `converged: true` — 直近 N runs (既定 2) すべてで `unclearCount === 0`
- `divergenceSignal: true` — 直近 3 runs で `newUnclearCount` が非減少
- `plateau` — 前回との `accuracyDeltaPoints` と `durationDeltaPct`

---

## blank-slate 実行の注意

Claude Code には `pi -p --no-extensions --no-skills --no-context-files --no-prompt-templates` のような「全部抑止」する単一フラグがありません。executor を可能な限りクリーンに保ちたい場合は、

- `CLAUDE.md` を持たない一時ディレクトリで `/skill-eval-run` を実行する、
- `config.model` を小さいモデル (例: `haiku-4-5`) に固定して trial 間の揺らぎを抑える、

といった運用で近似してください。

---

## License

MIT
