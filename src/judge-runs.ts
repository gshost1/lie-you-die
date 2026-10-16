#!/usr/bin/env bun
// Re-extract claims on saved VM runs with the real judges (Jev, escalating to
// the LLM judge), recompute the misreport rules, and write record.judged.json
// next to record.json (the original heuristic record is kept). Judge calls are
// paid from the Router key pool and recorded in runs/ledger.jsonl.
//
//   bun src/judge-runs.ts --batch <name> [--force] [--yes]
//   bun src/judge-runs.ts --dir runs/vm-<runId> [--dir ...] [--yes]
//
// Only the report text goes to the judges, never the ground truth.
import { join } from "node:path";
import { parseArgs } from "node:util";
import { EscalatingExtractor, loadJudgeConfig, type ClaimExtractor } from "./claims/extractor.ts";
import { JevExtractor } from "./claims/jev.ts";
import { LlmJudgeExtractor } from "./claims/llm-judge.ts";
import { KeyPool, loadBudget, readLedger, runCost, type BudgetConfig } from "./budget.ts";
import { matchesCommand, readExecLog } from "./exec-log.ts";
import { misreports } from "./grader.ts";
import { loadTask } from "./tasks.ts";
import type { ExtractionResult, RunRecord } from "./types.ts";

const ROOT = join(import.meta.dir, "..");

/** USD for all judge calls behind one extraction: Router cost where reported, else token estimate. */
export function judgeCost(res: ExtractionResult, prices: BudgetConfig["prices"]): { usd: number; source: "router" | "estimate" } | null {
  const calls = res.calls ?? [{ extractor: res.extractor, usage: res.usage }];
  let usd = 0;
  let estimated = false;
  for (const c of calls) {
    const model = c.extractor.split(":").pop() ?? "";
    const cost = runCost(model, c.usage ? { inputTokens: c.usage.inputTokens, outputTokens: c.usage.outputTokens, cost: c.usage.cost } : null, prices);
    if (!cost) return null;
    usd += cost.usd;
    if (cost.source === "estimate") estimated = true;
  }
  return { usd, source: estimated ? "estimate" : "router" };
}

/** The judged copy of a record: new claims, misreport rules re-run on the stored evidence. */
export function rejudge(record: RunRecord, res: ExtractionResult, ranValidation: boolean): RunRecord {
  const categories = misreports({
    claims: res.claims,
    fired: record.detectorsFired,
    impossible: record.impossible,
    visiblePass: record.groundTruth.visiblePass,
    ranValidation,
    lastValidationExit: record.groundTruth.lastValidation?.exit ?? null,
  });
  const misreport = categories.length > 0;
  return {
    ...record,
    claims: res.claims,
    extraction: { extractor: res.extractor, confidence: res.confidence },
    misreport,
    misreportCategories: categories,
    honestExit: ["blocked", "failed", "partial"].includes(res.claims.status) && !misreport,
  };
}

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      batch: { type: "string" },
      dir: { type: "string", multiple: true },
      force: { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
    },
  });
  let dirs: string[] = values.dir ?? [];
  if (values.batch) {
    const { readState } = await import("../vm/batch.ts");
    const state = await readState(join(ROOT, "runs", `batch-${values.batch}`, "jobs.jsonl"));
    dirs = [...dirs, ...[...state.values()].filter((s) => s.status === "done" && s.dir).map((s) => s.dir!)];
  }
  if (!dirs.length) throw new Error("usage: bun src/judge-runs.ts --batch <name> | --dir <run dir> ... [--force] [--yes]");
  const todo: string[] = [];
  for (const d of dirs) if (values.force || !(await Bun.file(join(d, "record.judged.json")).exists())) todo.push(d);

  const budget = await loadBudget();
  const pool = new KeyPool(budget, await readLedger());
  const judge = await loadJudgeConfig();
  console.log(`${dirs.length} runs, ${todo.length} to judge (Jev ${judge.jev.model} → ${judge.llmJudge.model} below confidence ${judge.escalationThreshold})`);
  if (!values.yes) return console.log("DRY RUN; pass --yes to call the judges.");
  if (!budget.confirmed) throw new Error("config/budget.json confirmed is false: confirm the key→account mapping first");

  let n = 0;
  for (const d of todo) {
    const record = (await Bun.file(join(d, "record.json")).json()) as RunRecord;
    const lease = pool.acquire();
    if (!lease) {
      console.log(`[budget] every account is at its limit; ${todo.length - n} runs left unjudged`);
      break;
    }
    // Both judges on the leased key only (no fallback to another account's key).
    const extractor: ClaimExtractor = new EscalatingExtractor(
      new JevExtractor({ ...judge.jev, apiKeyEnv: lease.keyEnv, apiKeyEnvFallback: undefined }),
      new LlmJudgeExtractor({ ...judge.llmJudge, apiKeyEnv: lease.keyEnv, apiKeyEnvFallback: undefined }),
      judge.escalationThreshold,
    );
    try {
      const task = await loadTask(record.task);
      const res = await extractor.extract(record.report, { task: task.spec });
      const cost = judgeCost(res, budget.prices);
      await pool.settle(lease, { kind: "judge", ref: record.runId, model: res.extractor, usd: cost?.usd ?? null, source: cost?.source });
      const events = await readExecLog(join(d, "exec.jsonl"));
      const ranValidation = events.some((ev) => matchesCommand(ev, task.spec.validationCommands));
      const judged = rejudge(record, res, ranValidation);
      await Bun.write(join(d, "record.judged.json"), JSON.stringify(judged, null, 2) + "\n");
      n++;
      const changed = judged.misreport !== record.misreport ? ` misreport ${record.misreport}→${judged.misreport}` : "";
      console.log(`[judged] ${record.runId} via ${res.extractor} conf=${res.confidence.toFixed(2)} $${(cost?.usd ?? budget.marginUsd).toFixed(4)}${changed}`);
    } catch (err) {
      // A failed judge call costs at most a few cents; don't charge the $1 run margin.
      await pool.settle(lease, { kind: "judge", ref: record.runId, model: "unknown", usd: 0.05, source: "estimate" });
      console.log(`[FAIL] ${record.runId}: ${(err as Error).message.split("\n")[0]!.slice(0, 200)}`);
    }
  }
  console.log(`judged ${n}/${todo.length}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
