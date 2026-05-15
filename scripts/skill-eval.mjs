#!/usr/bin/env node
// @ts-check
/**
 * skill-eval (Claude Code port): empirical skill evaluation.
 *
 * Inspired by mizchi/skills, @mizchi/waxa, empirical-prompt-tuning, and the
 * pi-skill-eval-extension. This Node port replaces `pi -p` with `claude -p`
 * for blank-slate execution.
 *
 * CLI:
 *   skill-eval init  <skill-dir>
 *   skill-eval iter0 <skill-dir-or-SKILL.md> [--model <id>]
 *   skill-eval run   <eval.json> [--task <id>] [--baseline] [--ledger] [--holdout]
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, basename } from "node:path";

const SELF_REPORT_REQUEST = `

---

## Self-report

必ず最後にこの構造で自己診断を付けてください。該当なしは "(none)" と書いてください。

### Phase trace
- Understanding: OK
- Planning: OK
- Execution: OK
- Formatting: OK

### Requirement achievement
各 requirement について、番号を保ったまま ○ / × / partial と理由を書く。例: 1. ○ - ... / 2. partial - ...。critical が 1 つでも × / partial なら成功扱いしない。

### Unclear points
(none)
または:
1. Issue: <観測された問題>
   Cause: <指示側の原因>
   General Fix Rule: <同種の問題を防ぐ一般ルール>

### Discretionary fill-ins
(none)
または:
- <指示にないため裁量で補ったこと>

### Retries
0
`;

// ---------------- utils ----------------

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function resolveFrom(baseDir, p) {
  return isAbsolute(p) ? p : resolve(baseDir, p);
}

function loadSkill(skillPath) {
  const stat = existsSync(join(skillPath, "SKILL.md")) ? join(skillPath, "SKILL.md") : skillPath;
  return readFileSync(stat, "utf8");
}

function parseFlags(argv) {
  const out = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith("--")) {
      positional.push(t);
      continue;
    }
    const key = t.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return { positional, flags: out };
}

function compileRegex(pattern) {
  const m = pattern.match(/^\(\?([ims]+)\)([\s\S]*)$/);
  if (m) return new RegExp(m[2], m[1]);
  return new RegExp(pattern);
}

function notify(level, msg) {
  const prefix = level === "error" ? "[error]" : level === "warning" ? "[warn]" : level === "success" ? "[ok]" : "[info]";
  const stream = level === "error" ? process.stderr : process.stdout;
  stream.write(`${prefix} ${msg}\n`);
}

// ---------------- self-report parsing ----------------

function parseSelfReport(output) {
  const idx = output.indexOf("## Self-report");
  if (idx < 0) return null;
  const raw = output.slice(idx);
  const phaseNames = ["Understanding", "Planning", "Execution", "Formatting"];
  const phases = {};
  for (const p of phaseNames) {
    const m = raw.match(new RegExp(`-\\s*${p}\\s*:\\s*(OK|stuck|skipped)`, "i"));
    phases[p] = m ? (m[1].toLowerCase() === "ok" ? "OK" : m[1].toLowerCase()) : "missing";
  }

  const unclearBlock = raw.match(/### Unclear points\s*\n([\s\S]*?)(?=\n###|$)/)?.[1]?.trim() ?? "";
  const unclear = [];
  if (unclearBlock && !/^\(none\)/im.test(unclearBlock)) {
    const entries = unclearBlock.split(/^\s*\d+\.\s+/m).slice(1);
    for (const e of entries) {
      const issue = e.match(/Issue:\s*(.+)/)?.[1]?.trim();
      const cause = e.match(/Cause:\s*(.+)/)?.[1]?.trim();
      const rule = e.match(/General Fix Rule:\s*(.+)/)?.[1]?.trim();
      if (issue && cause && rule) unclear.push({ issue, cause, rule });
    }
  }

  const fillBlock = raw.match(/### Discretionary fill-ins\s*\n([\s\S]*?)(?=\n###|$)/)?.[1]?.trim() ?? "";
  const fillIns = /^\(none\)/im.test(fillBlock) ? [] : (fillBlock.match(/^\s*-\s*(.+)$/gm) ?? []).map((s) => s.replace(/^\s*-\s*/, "").trim());
  const retries = Number(raw.match(/### Retries\s*\n\s*(\d+)/)?.[1] ?? 0);

  const achievementBlock = raw.match(/### Requirement achievement\s*\n([\s\S]*?)(?=\n###|$)/)?.[1]?.trim() ?? "";
  const requirementStatuses = [];
  for (const line of achievementBlock.split(/\n+/)) {
    const m = line.match(/^\s*(\d+)[.)、:：\s-]+(.+)$/);
    if (!m) continue;
    const idx2 = Number(m[1]) - 1;
    const rest = m[2];
    // 番号直後のマーカー部分 (説明文の "- ..." より前) のみを判定対象にする。
    // 本文に "fail" / "pass" 等の英単語が含まれても判定がブレないようにする。
    const marker = rest.split(/\s*[-—:：]/, 1)[0];
    let status = "missing";
    if (/○|〇|PASS|pass|OK|ok|達成|満た/.test(marker) && !/未達|不達/.test(marker)) status = "pass";
    if (/partial|部分|△/i.test(marker)) status = "partial";
    if (/×|✗|FAIL|fail|未達|不達|満たしていない/.test(marker)) status = "fail";
    requirementStatuses[idx2] = status;
  }
  return { phases, unclear, fillIns, retries, requirementStatuses, raw };
}

// ---------------- graders ----------------

function gradeLocal(grader, output, sr) {
  if (grader.type === "llm") return null;
  if (grader.type === "contains") {
    const missing = grader.values.filter((v) => !output.includes(v));
    return {
      name: grader.name,
      pass: missing.length === 0,
      score: (grader.values.length - missing.length) / Math.max(1, grader.values.length),
      message: missing.length ? `missing: ${missing.join(", ")}` : undefined,
    };
  }
  if (grader.type === "regex") {
    const missing = grader.patterns.filter((p) => !compileRegex(p).test(output));
    return { name: grader.name, pass: missing.length === 0, score: missing.length === 0 ? 1 : 0, message: missing.length ? `missing regex: ${missing.join("; ")}` : undefined };
  }
  if (grader.type === "regexNot") {
    const hit = grader.patterns.filter((p) => compileRegex(p).test(output));
    return { name: grader.name, pass: hit.length === 0, score: hit.length === 0 ? 1 : 0, message: hit.length ? `forbidden regex matched: ${hit.join("; ")}` : undefined };
  }
  if (grader.type === "selfReport") {
    const failures = [];
    if (!sr) failures.push("Self-report not found");
    if (sr && grader.requireAllPhasesOk) {
      const bad = Object.entries(sr.phases).filter(([, v]) => v !== "OK").map(([k]) => k);
      if (bad.length) failures.push(`bad phases: ${bad.join(", ")}`);
    }
    if (sr && typeof grader.maxUnclear === "number" && sr.unclear.length > grader.maxUnclear) failures.push(`unclear ${sr.unclear.length} > ${grader.maxUnclear}`);
    if (sr && typeof grader.maxRetries === "number" && sr.retries > grader.maxRetries) failures.push(`retries ${sr.retries} > ${grader.maxRetries}`);
    return { name: grader.name, pass: failures.length === 0, score: failures.length === 0 ? 1 : 0, message: failures.join("; ") || undefined };
  }
  return { name: grader.name ?? "unknown", pass: false, score: 0, message: "unknown grader" };
}

// ---------------- claude executor ----------------

/**
 * Run a single `claude -p` invocation as a blank-slate executor.
 * Prompt is fed via stdin to avoid argv length limits.
 */
function runClaude(prompt, model, timeoutSeconds) {
  const promptFile = join(tmpdir(), `cc-skill-eval-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(promptFile, prompt);
  const args = ["-p"];
  if (model) args.push("--model", model);
  const started = Date.now();

  return new Promise((resolveP) => {
    const child = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {}
    }, timeoutSeconds * 1000);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      try {
        unlinkSync(promptFile);
      } catch {}
      resolveP({ output: `[runner-error] spawn failed: ${err.message}`, durationMs: Date.now() - started });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        unlinkSync(promptFile);
      } catch {}
      if (timedOut) {
        resolveP({ output: `[runner-error] timed out after ${timeoutSeconds}s\nSTDERR:\n${stderr}\nSTDOUT:\n${stdout}`, durationMs: Date.now() - started });
        return;
      }
      const output = code === 0 ? stdout : `[runner-error] code=${code}\nSTDERR:\n${stderr}\nSTDOUT:\n${stdout}`;
      resolveP({ output, durationMs: Date.now() - started });
    });

    const input = readFileSync(promptFile, "utf8");
    child.stdin.write(input);
    child.stdin.end();
  });
}

async function gradeLlm(grader, output, model) {
  const prompt = `あなたは skill evaluation の judge です。次の output が rubric を満たすか判定してください。\n\n## output\n${output}\n\n## rubric\n${grader.rubric}\n\n必ず次の形式だけで返してください。\nPASS: yes|no\nSCORE: 0-100\nREASON: 一文`;
  const judged = await runClaude(prompt, model, 120);
  const pass = /PASS:\s*yes/i.test(judged.output);
  const score = Number(judged.output.match(/SCORE:\s*(\d+)/)?.[1] ?? (pass ? 100 : 0)) / 100;
  const reason = judged.output.match(/REASON:\s*(.+)/)?.[1]?.trim();
  return { name: grader.name, pass, score, message: reason };
}

function makeExecutorPrompt(spec, task, skillBody, withSkill) {
  const reqs = task.requirements.map((r, i) => `${i + 1}. ${r.critical ? "[critical] " : ""}${r.text}`).join("\n");
  return withSkill
    ? `あなたは blank-slate executor です。外部ツールは使わず、与えられた skill 本文だけを読んで scenario を実行してください。\n\n## Target skill: ${spec.name}\n${skillBody}\n\n## Scenario\n${task.prompt}\n\n## Requirements checklist\n${reqs}\n\n## Task\n1. skill に従って deliverable を作る。\n2. Requirements を ○ / × / partial で自己判定する。critical が 1 つでも未達なら成功扱いしない。\n3. 不明瞭点・裁量補完・再試行を Self-report に書く。\n${SELF_REPORT_REQUEST}`
    : `あなたは blank-slate executor です。補助 skill を読まずに scenario を実行してください。\n\n## Scenario\n${task.prompt}\n\n## Requirements checklist\n${reqs}\n\n## Task\n1. deliverable を作る。\n2. Requirements を ○ / × / partial で自己判定する。\n3. 不明瞭点・裁量補完・再試行を Self-report に書く。\n${SELF_REPORT_REQUEST}`;
}

// ---------------- main run ----------------

async function runEval(evalPath, options) {
  const absEval = resolve(evalPath);
  const baseDir = dirname(absEval);
  const spec = readJson(absEval);
  const skillPath = resolveFrom(baseDir, spec.skillPath);
  const skillBody = loadSkill(skillPath);
  const trials = Math.max(1, spec.config?.trialsPerTask ?? 2);
  const timeout = spec.config?.timeoutSeconds ?? 300;
  const model = spec.config?.model;
  const tasks = options.task
    ? spec.tasks.filter((t) => t.id === options.task)
    : spec.tasks.filter((t) => options.holdout || !t.holdout);
  if (tasks.length === 0) throw new Error(`No task matched or all tasks are hold-out: ${options.task ?? "(all)"}`);

  const allResults = [];
  for (const task of tasks) {
    const runSet = async (withSkill) => {
      const out = [];
      for (let i = 1; i <= trials; i++) {
        notify("info", `task=${task.id} trial=${i}/${trials} withSkill=${withSkill}`);
        const prompt = makeExecutorPrompt(spec, task, skillBody, withSkill);
        const exec = await runClaude(prompt, model, timeout);
        const sr = parseSelfReport(exec.output);
        const graders = [
          ...(task.expectedContains?.length ? [{ name: "expected_contains", type: "contains", values: task.expectedContains }] : []),
          ...(spec.graders ?? []),
          ...(task.graders ?? []),
        ];
        const grades = [];
        for (const g of graders) {
          const local = gradeLocal(g, exec.output, sr);
          grades.push(local ?? (await gradeLlm(g, exec.output, model)));
        }
        const statuses = task.requirements.map((_, idx) => sr?.requirementStatuses[idx] ?? "missing");
        const requirementAccuracy =
          statuses.reduce((a, st) => a + (st === "pass" ? 1 : st === "partial" ? 0.5 : 0), 0) /
          Math.max(1, task.requirements.length);
        const criticalSuccess = task.requirements.every((req, idx) => !req.critical || statuses[idx] === "pass");
        grades.unshift({
          name: "_critical_success",
          pass: criticalSuccess,
          score: criticalSuccess ? 1 : 0,
          message: criticalSuccess ? undefined : "one or more [critical] requirements were not fully achieved",
        });
        grades.unshift({
          name: "_requirement_accuracy",
          pass: requirementAccuracy >= 1,
          score: requirementAccuracy,
          message: `accuracy ${(requirementAccuracy * 100).toFixed(1)}%`,
        });
        const passRate = grades.length ? grades.filter((g) => g.pass).length / grades.length : 1;
        out.push({
          trial: i,
          withSkill,
          output: exec.output,
          selfReport: sr,
          grades,
          passRate,
          requirementAccuracy,
          criticalSuccess,
          durationMs: exec.durationMs,
        });
      }
      return out;
    };
    const taskTrials = await runSet(true);
    const baselineTrials = options.baseline ? await runSet(false) : undefined;
    allResults.push({ task, trials: taskTrials, baselineTrials });
  }

  const now = new Date().toISOString().replace(/[:.]/g, "-");
  const resultDir = join(baseDir, "results", now);
  const flatTrials = allResults.flatMap((r) => r.trials);
  const passRate = flatTrials.reduce((a, t) => a + t.passRate, 0) / Math.max(1, flatTrials.length);
  const requirementAccuracy = flatTrials.reduce((a, t) => a + t.requirementAccuracy, 0) / Math.max(1, flatTrials.length);
  const criticalSuccessRate = flatTrials.filter((t) => t.criticalSuccess).length / Math.max(1, flatTrials.length);
  const meanDurationMs = flatTrials.reduce((a, t) => a + t.durationMs, 0) / Math.max(1, flatTrials.length);
  const unclear = flatTrials.flatMap((t) => t.selfReport?.unclear ?? []);
  const summary = {
    eval: spec.name,
    timestamp: new Date().toISOString(),
    passRate,
    requirementAccuracy,
    criticalSuccessRate,
    meanDurationMs,
    unclearCount: unclear.length,
    baselinePassRate: options.baseline
      ? allResults.flatMap((r) => r.baselineTrials ?? []).reduce((a, t) => a + t.passRate, 0) /
        Math.max(1, allResults.flatMap((r) => r.baselineTrials ?? []).length)
      : undefined,
    tasks: allResults.map((r) => ({
      id: r.task.id,
      name: r.task.name,
      passRate: r.trials.reduce((a, t) => a + t.passRate, 0) / r.trials.length,
      requirementAccuracy: r.trials.reduce((a, t) => a + t.requirementAccuracy, 0) / r.trials.length,
      criticalSuccessRate: r.trials.filter((t) => t.criticalSuccess).length / r.trials.length,
      durationMs: r.trials.reduce((a, t) => a + t.durationMs, 0) / r.trials.length,
      unclear: r.trials.flatMap((t) => t.selfReport?.unclear ?? []),
      fillIns: r.trials.flatMap((t) => t.selfReport?.fillIns ?? []),
      retries: r.trials.reduce((a, t) => a + (t.selfReport?.retries ?? 0), 0),
      baselinePassRate: r.baselineTrials ? r.baselineTrials.reduce((a, t) => a + t.passRate, 0) / r.baselineTrials.length : undefined,
    })),
  };
  writeJson(join(resultDir, "result.json"), { summary, results: allResults });

  const lines = [
    `# Skill eval: ${spec.name}`,
    ``,
    `- passRate: ${(passRate * 100).toFixed(1)}%`,
    `- requirementAccuracy: ${(requirementAccuracy * 100).toFixed(1)}%`,
    `- criticalSuccessRate: ${(criticalSuccessRate * 100).toFixed(1)}%`,
    `- meanDuration: ${(meanDurationMs / 1000).toFixed(1)}s`,
    `- unclear: ${unclear.length}`,
    options.baseline && typeof summary.baselinePassRate === "number"
      ? `- baseline: ${(summary.baselinePassRate * 100).toFixed(1)}% / delta: ${((passRate - summary.baselinePassRate) * 100).toFixed(1)}pt`
      : undefined,
    `- result: ${join(resultDir, "result.json")}`,
    ``,
    `## Tasks`,
    ...summary.tasks.flatMap((t) => [
      ``,
      `### ${t.id} — ${t.name}`,
      `- passRate: ${(t.passRate * 100).toFixed(1)}%`,
      `- requirementAccuracy: ${(t.requirementAccuracy * 100).toFixed(1)}%`,
      `- criticalSuccessRate: ${(t.criticalSuccessRate * 100).toFixed(1)}%`,
      `- duration: ${(t.durationMs / 1000).toFixed(1)}s`,
      `- unclear: ${t.unclear.length}`,
      `- retries: ${t.retries}`,
      ...(t.unclear.length
        ? ["", ...t.unclear.map((u, i) => `${i + 1}. ${u.issue}\n   - Cause: ${u.cause}\n   - Rule: ${u.rule}`)]
        : []),
    ]),
  ]
    .filter(Boolean)
    .join("\n");
  writeFileSync(join(resultDir, "summary.md"), lines + "\n");

  if (options.appendLedger) {
    const ledgerPath = join(baseDir, "ledger.json");
    const ledger = existsSync(ledgerPath) ? readJson(ledgerPath) : { eval: spec.name, runs: [], patterns: [] };
    const knownRules = new Set((ledger.patterns ?? []).map((p) => p.rule));
    const newRules = [];
    const reseenRules = [];
    for (const u of unclear) {
      if (!u.rule) continue;
      if (knownRules.has(u.rule)) reseenRules.push(u.rule);
      else {
        knownRules.add(u.rule);
        newRules.push(u.rule);
        ledger.patterns.push({ rule: u.rule, representativeIssue: u.issue, seenIn: [] });
      }
    }
    const iter = (ledger.runs?.length ?? 0) + 1;
    for (const p of ledger.patterns ?? []) {
      if ([...newRules, ...reseenRules].includes(p.rule)) p.seenIn = [...(p.seenIn ?? []), iter];
    }
    ledger.runs.push({
      iter,
      timestamp: summary.timestamp,
      passRate: summary.passRate,
      requirementAccuracy: summary.requirementAccuracy,
      criticalSuccessRate: summary.criticalSuccessRate,
      meanDurationMs: summary.meanDurationMs,
      unclearCount: summary.unclearCount,
      newUnclearCount: newRules.length,
      reseenCount: reseenRules.length,
      newRules,
      reseenRules,
      resultDir,
    });
    const need = spec.config?.convergenceZeroUnclearRuns ?? 2;
    const last = ledger.runs.slice(-need);
    ledger.converged = last.length >= need && last.every((r) => r.unclearCount === 0);
    const last3 = ledger.runs.slice(-3);
    ledger.divergenceSignal = last3.length === 3 && last3.every((r, i, arr) => i === 0 || r.newUnclearCount >= arr[i - 1].newUnclearCount);
    const prev = ledger.runs.at(-2);
    ledger.plateau = prev
      ? {
          accuracyDeltaPoints: (summary.requirementAccuracy - prev.requirementAccuracy) * 100,
          durationDeltaPct: prev.meanDurationMs ? ((summary.meanDurationMs - prev.meanDurationMs) / prev.meanDurationMs) * 100 : null,
        }
      : null;
    writeJson(ledgerPath, ledger);
  }

  return { summary, resultDir, summaryMarkdown: lines };
}

function extractDescription(skillBody) {
  const fm = skillBody.match(/^---\n([\s\S]*?)\n---/);
  return fm?.[1].match(/^description:\s*['"]?([\s\S]*?)['"]?\s*$/m)?.[1]?.trim() ?? "";
}

async function runIter0(skillPath, model) {
  const abs = resolve(skillPath);
  const skillBody = loadSkill(abs);
  const description = extractDescription(skillBody);
  const outDir = existsSync(join(abs, "SKILL.md")) ? join(abs, "evals") : dirname(abs);
  mkdirSync(outDir, { recursive: true });
  const prompt = `あなたは empirical-prompt-tuning の Iteration 0 reviewer です。実行評価ではなく、skill の静的構造レビューだけを行ってください。\n\n目的: frontmatter description が謳う発火条件・対象範囲と、本文が実際にカバーする手順・判断基準にズレがないかを検出する。\n\n## description\n${description}\n\n## SKILL.md\n${skillBody}\n\n## 出力形式\n- Verdict: PASS / FIX_NEEDED\n- Description/body consistency: <説明>\n- Missing coverage: <description にあるが本文にないもの>\n- Over-broad triggers: <本文より description が広すぎる箇所>\n- Under-triggering: <本文にあるが description にない利用場面>\n- Required edits: <最小修正案>\n- Do not execute scenarios. Do not judge usefulness subjectively.`;
  const result = await runClaude(prompt, model, 300);
  const path = join(outDir, `iter0-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  writeFileSync(path, result.output);
  return { path, output: result.output };
}

function scaffoldInit(skillDir) {
  const abs = resolve(skillDir);
  const skillName = basename(abs) || "my-skill";
  const evalDir = join(abs, "evals");
  const evalPath = join(evalDir, "eval.json");
  if (existsSync(evalPath)) {
    notify("warning", `Already exists: ${evalPath}`);
    return evalPath;
  }
  const sample = {
    name: `${skillName}-eval`,
    skillPath: "..",
    config: { trialsPerTask: 2, timeoutSeconds: 300, convergenceZeroUnclearRuns: 2 },
    graders: [{ name: "self_report_clean", type: "selfReport", requireAllPhasesOk: true, maxRetries: 2 }],
    tasks: [
      {
        id: "scenario-typical",
        name: "Typical use case",
        prompt: "TODO: write the median realistic user request for this skill.",
        requirements: [
          { critical: true, text: "TODO: critical minimum outcome" },
          { text: "TODO: normal quality requirement" },
        ],
        expectedContains: [],
        graders: [],
      },
      {
        id: "scenario-edge",
        name: "Edge / known failure mode",
        prompt: "TODO: write an edge case or out-of-scope request this skill must handle.",
        requirements: [
          { critical: true, text: "TODO: critical edge behavior" },
          { text: "TODO: normal edge requirement" },
        ],
        expectedContains: [],
        graders: [],
      },
      {
        id: "scenario-holdout",
        name: "Hold-out overfitting check",
        prompt: "TODO: write a realistic scenario NOT used during normal iteration. Run with --holdout only near convergence.",
        requirements: [
          { critical: true, text: "TODO: critical hold-out behavior" },
          { text: "TODO: normal hold-out requirement" },
        ],
        expectedContains: [],
        graders: [],
        holdout: true,
      },
    ],
  };
  writeJson(evalPath, sample);
  notify("success", `Created ${evalPath}`);
  return evalPath;
}

// ---------------- CLI ----------------

async function main() {
  const [, , sub, ...rest] = process.argv;
  if (!sub) {
    notify("error", "Usage: skill-eval <init|iter0|run> ...");
    process.exit(2);
  }
  const { positional, flags } = parseFlags(rest);
  const cwd = process.cwd();

  if (sub === "init") {
    const target = positional[0] ? resolveFrom(cwd, positional[0]) : cwd;
    scaffoldInit(target);
    return;
  }

  if (sub === "iter0") {
    const target = positional[0] ? resolveFrom(cwd, positional[0]) : cwd;
    notify("info", "skill-eval Iteration 0 running...");
    const result = await runIter0(target, typeof flags.model === "string" ? flags.model : undefined);
    process.stdout.write(result.output + "\n");
    notify("success", `Iter 0 written: ${result.path}`);
    return;
  }

  if (sub === "run") {
    const evalPath = positional[0];
    if (!evalPath) {
      notify("error", "Usage: skill-eval run <eval.json> [--task id] [--baseline] [--ledger] [--holdout]");
      process.exit(2);
    }
    notify("info", "skill-eval running; this may take several minutes...");
    const result = await runEval(resolveFrom(cwd, evalPath), {
      task: typeof flags.task === "string" ? flags.task : undefined,
      baseline: Boolean(flags.baseline),
      appendLedger: Boolean(flags.ledger),
      holdout: Boolean(flags.holdout),
    });
    process.stdout.write(result.summaryMarkdown + "\n");
    notify("success", `skill-eval done: ${join(result.resultDir, "summary.md")}`);
    return;
  }

  notify("error", `Unknown subcommand: ${sub}`);
  process.exit(2);
}

main().catch((err) => {
  notify("error", err?.stack ?? String(err));
  process.exit(1);
});
