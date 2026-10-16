#!/usr/bin/env bun
// Batch runner: agents × tasks × conditions × models × repeats on Freestyle,
// one fresh VM per run (vm/orchestrate.ts), several at a time, paid from the
// Router key pool with a hard budget stop (src/budget.ts, config/budget.json).
//
//   bun vm/batch.ts run --name <batch> [--agents lyd-agent,pi,omp] [--tasks all]
//       [--conditions neutral,induced] [--models kimi-k3,claude-sonnet-5-5]
//       [--repeats 1] [--concurrency 4] [--retry-failed] [--yes]
//   bun vm/batch.ts summary --name <batch>
//
// Without --yes it only prints the plan. State lives in runs/batch-<name>/jobs.jsonl
// (append-only), so re-running the same command resumes: done jobs are skipped,
// failed ones too unless --retry-failed. Ctrl-C stops scheduling new runs and
// waits for in-flight VMs to finish and be deleted; a second Ctrl-C exits at once
// (in-flight VMs then die at their ttlSeconds).
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadAgentsConfig, modelProfile } from "../src/agents/cli-adapter.ts";
import type { AgentUsage } from "../src/agents/output.ts";
import { KeyPool, loadBudget, readLedger, runCost, type BudgetConfig, type LedgerEntry } from "../src/budget.ts";
import { summaryTable } from "../src/summary.ts";
import { listTaskIds } from "../src/tasks.ts";
import type { Condition, RunRecord } from "../src/types.ts";

const ROOT = join(import.meta.dir, "..");
/** Freestyle free plan: 10 concurrent VMs; keep headroom. */
const MAX_CONCURRENCY = 8;
/** Stop scheduling after this many failures in a row (broken infra, bad key, ...). */
const MAX_CONSECUTIVE_FAILURES = 5;

export interface Job {
  id: string;
  agent: string;
  task: string;
  condition: Condition;
  model: string;
  repeat: number;
}

export interface JobState {
  id: string;
  status: "done" | "failed";
  ts: string;
  runId?: string;
  dir?: string;
  model?: string;
  keyEnv?: string;
  account?: string;
  usd?: number;
  costSource?: LedgerEntry["source"];
  error?: string;
}

/** Repeat outermost, so a batch stopped early (budget) is still balanced across cells. */
export function planJobs(o: { agents: string[]; tasks: string[]; conditions: Condition[]; models: string[]; repeats: number }): Job[] {
  const jobs: Job[] = [];
  for (let repeat = 1; repeat <= o.repeats; repeat++)
    for (const task of o.tasks)
      for (const condition of o.conditions)
        for (const model of o.models)
          for (const agent of o.agents) jobs.push({ id: `${task}.${condition}.${agent}.${model}.r${repeat}`, agent, task, condition, model, repeat });
  return jobs;
}

export async function readState(path: string): Promise<Map<string, JobState>> {
  const f = Bun.file(path);
  const m = new Map<string, JobState>();
  if (!(await f.exists())) return m;
  for (const line of (await f.text()).split("\n")) {
    if (!line.trim()) continue;
    try {
      const s = JSON.parse(line) as JobState;
      m.set(s.id, s); // last line per job wins
    } catch {
      // torn last line
    }
  }
  return m;
}

export interface RunOutcome {
  runId: string;
  dir: string;
  model: string;
  usage: AgentUsage | null;
}

export interface BatchDeps {
  pool: KeyPool;
  budget: BudgetConfig;
  statePath: string;
  concurrency: number;
  run: (job: Job, keyEnv: string) => Promise<RunOutcome>;
  log?: (msg: string) => void;
  /** Checked before each new job; true = stop scheduling (Ctrl-C). */
  stopping?: () => boolean;
  /** Free models (profile `free: true`) → their key env. They skip the key pool and cost $0. */
  freeKeyEnv?: Record<string, string>;
}

export interface BatchResult {
  done: number;
  failed: number;
  notStarted: number;
  stopReason: "complete" | "budget" | "failures" | "interrupted";
}

/** Error text safe to store: first line, no bearer tokens, capped. */
function cleanError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split("\n")[0]!.replace(/Bearer\s+\S+/gi, "Bearer ***").slice(0, 300);
}

/** Usage was parsed and every token count is zero. Null usage = unknown, not zero. */
export function noTokens(u: AgentUsage | null): boolean {
  if (!u || (u.cost ?? 0) > 0) return false;
  return (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0) === 0;
}

export async function runBatch(jobs: Job[], deps: BatchDeps): Promise<BatchResult> {
  const log = deps.log ?? console.error;
  const queue = [...jobs];
  let done = 0;
  let failed = 0;
  let consecutiveFailures = 0;
  let stopReason: BatchResult["stopReason"] = "complete";
  const record = (s: JobState) => appendFile(deps.statePath, JSON.stringify(s) + "\n");

  const worker = async () => {
    while (queue.length) {
      if (stopReason !== "complete") return;
      if (deps.stopping?.()) {
        stopReason = "interrupted";
        return;
      }
      const freeEnv = deps.freeKeyEnv?.[queue[0]!.model];
      const lease = freeEnv ? { id: 0, account: "free", keyEnv: freeEnv } : deps.pool.acquire();
      if (!lease) {
        stopReason = "budget";
        return;
      }
      const job = queue.shift()!;
      // Free runs never touch the ledger or the budget.
      const settle: typeof deps.pool.settle = freeEnv
        ? async (l, e) => ({ ...e, ts: new Date().toISOString(), keyEnv: l.keyEnv, account: l.account, usd: 0, source: "estimate" })
        : (l, e) => deps.pool.settle(l, e);
      log(`[start] ${job.id} (account ${lease.account}, ${lease.keyEnv})`);
      try {
        const r = await deps.run(job, lease.keyEnv);
        if (noTokens(r.usage)) {
          // The agent ran but no model call ever succeeded (e.g. Router stream
          // timeouts): an infrastructure failure, not agent behaviour. Nothing
          // was billed; keep the run dir for inspection and leave it retryable.
          const entry = await settle(lease, { kind: "agent", ref: r.runId, model: r.model, usd: 0, source: "estimate" });
          await record({ id: job.id, status: "failed", ts: entry.ts, runId: r.runId, dir: r.dir, model: r.model, keyEnv: lease.keyEnv, account: lease.account, usd: 0, costSource: entry.source, error: "no model tokens: every model call failed (infra)" });
          failed++;
          consecutiveFailures++;
          log(`[FAIL]  ${job.id}: no model tokens (infra); run kept at ${r.dir}`);
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) stopReason = "failures";
          continue;
        }
        const cost = runCost(r.model, r.usage, deps.budget.prices);
        const entry = await settle(lease, { kind: "agent", ref: r.runId, model: r.model, usd: cost?.usd ?? null, source: cost?.source });
        await record({ id: job.id, status: "done", ts: entry.ts, runId: r.runId, dir: r.dir, model: r.model, keyEnv: lease.keyEnv, account: lease.account, usd: entry.usd, costSource: entry.source });
        done++;
        consecutiveFailures = 0;
        log(`[done]  ${job.id} $${entry.usd.toFixed(4)} (${entry.source}); ${freeEnv ? "free model" : `account ${lease.account} spent $${deps.pool.spentBy(lease.account).toFixed(2)}`}`);
      } catch (err) {
        // Failed before the agent started (VM setup): no model call, $0.
        // Otherwise spend is unknown: charge the margin (conservative).
        const beforeAgent = (err as { beforeAgent?: unknown } | null)?.beforeAgent === true;
        const entry = await settle(lease, { kind: "agent", ref: job.id, model: job.model, usd: beforeAgent ? 0 : null, ...(beforeAgent ? { source: "estimate" as const } : {}) });
        await record({ id: job.id, status: "failed", ts: entry.ts, model: job.model, keyEnv: lease.keyEnv, account: lease.account, usd: entry.usd, costSource: entry.source, error: cleanError(err) });
        failed++;
        consecutiveFailures++;
        log(`[FAIL]  ${job.id}: ${cleanError(err)}`);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) stopReason = "failures";
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, deps.concurrency) }, worker));
  return { done, failed, notStarted: queue.length, stopReason: queue.length ? stopReason : "complete" };
}

const list = (s: string | undefined, all: string[]) => (!s || s === "all" ? all : s.split(",").map((x) => x.trim()).filter(Boolean));

async function main() {
  const [cmd, ...rest] = Bun.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      name: { type: "string" },
      agents: { type: "string", default: "lyd-agent,pi,omp" },
      tasks: { type: "string", default: "all" },
      conditions: { type: "string", default: "neutral,induced" },
      models: { type: "string", default: "kimi-k3,claude-sonnet-5-5" },
      repeats: { type: "string", default: "1" },
      concurrency: { type: "string", default: "4" },
      "retry-failed": { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
    },
  });
  if (!values.name || !/^[\w.-]+$/.test(values.name)) throw new Error("--name <batch> is required (letters, digits, . _ -)");
  const dir = join(ROOT, "runs", `batch-${values.name}`);
  const statePath = join(dir, "jobs.jsonl");
  if (cmd === "summary") return summarize(dir, statePath);
  if (cmd !== "run") throw new Error("usage: bun vm/batch.ts run|summary --name <batch> ...");

  const cfg = await loadAgentsConfig();
  const agents = list(values.agents, Object.keys(cfg.agents));
  const tasks = list(values.tasks, await listTaskIds());
  const conditions = list(values.conditions, ["neutral", "induced"]) as Condition[];
  const models = list(values.models, [cfg.defaultModel]);
  for (const a of agents) if (!cfg.agents[a]) throw new Error(`unknown agent ${a}`);
  const freeKeyEnv: Record<string, string> = {};
  for (const m of models) {
    const p = modelProfile(cfg, m);
    if (p.free) freeKeyEnv[m] = p.apiKeyEnv;
    else if (new URL(p.baseUrl).host !== "api.router.com") throw new Error(`model ${m} is not on Router and not marked free; the key pool only covers Router accounts`);
  }
  const repeats = Number(values.repeats);
  const concurrency = Math.min(Number(values.concurrency), MAX_CONCURRENCY);

  const all = planJobs({ agents, tasks, conditions, models, repeats });
  const state = await readState(statePath);
  const jobs = all.filter((j) => {
    const s = state.get(j.id);
    return !s || (s.status === "failed" && values["retry-failed"]);
  });
  const budget = await loadBudget();
  const pool = new KeyPool(budget, await readLedger());

  console.log(`batch ${values.name}: ${all.length} jobs (${agents.length} agents × ${tasks.length} tasks × ${conditions.length} conditions × ${models.length} models × ${repeats} repeats)`);
  console.log(`already done: ${[...state.values()].filter((s) => s.status === "done").length}, failed: ${[...state.values()].filter((s) => s.status === "failed").length}, to run now: ${jobs.length}`);
  console.log(`concurrency ${concurrency}; margin $${budget.marginUsd}/run in flight`);
  for (const a of Object.keys(budget.accounts)) {
    const set = pool.accounts().includes(a);
    console.log(`  account ${a}: limit $${budget.accounts[a]!.limitUsd}, spent $${pool.spentBy(a).toFixed(2)}, left $${pool.remaining(a).toFixed(2)}${set ? "" : " (NO KEY SET: unused)"}`);
  }
  if (!values.yes) {
    console.log("\nDRY RUN; pass --yes to execute. Nothing was sent anywhere.");
    return;
  }
  if (!budget.confirmed) throw new Error("config/budget.json confirmed is false: confirm the key→account mapping first");
  if (!jobs.length) return console.log("nothing to run");

  await mkdir(dir, { recursive: true });
  const { loadFreestyleConfig, runOnVm } = await import("./orchestrate.ts");
  const fcfg = await loadFreestyleConfig();
  let interrupts = 0;
  process.on("SIGINT", () => {
    if (++interrupts > 1) process.exit(130);
    console.error("\n[batch] stopping: no new runs; waiting for in-flight VMs (Ctrl-C again to exit now)");
  });
  const result = await runBatch(jobs, {
    pool,
    budget,
    statePath,
    concurrency,
    stopping: () => interrupts > 0,
    freeKeyEnv,
    run: async (job, keyEnv) => {
      const r = await runOnVm(fcfg, { agent: job.agent, task: job.task, condition: job.condition, model: job.model, keyEnv, yes: true });
      if (!r) throw new Error("runOnVm returned no result");
      return { runId: r.runId, dir: r.dir, model: r.meta.model, usage: r.meta.usage as AgentUsage | null };
    },
  });
  console.log(`\n[batch] ${result.stopReason}: ${result.done} done, ${result.failed} failed, ${result.notStarted} not started`);
  await summarize(dir, statePath);
}

/** Writes runs.jsonl + summary.md for the batch; agent column = agent@model. Prefers judged records. */
export async function summarize(dir: string, statePath: string) {
  const state = await readState(statePath);
  const records: RunRecord[] = [];
  for (const s of state.values()) {
    if (s.status !== "done" || !s.dir) continue;
    const judged = Bun.file(join(s.dir, "record.judged.json"));
    const r = (await ((await judged.exists()) ? judged : Bun.file(join(s.dir, "record.json"))).json()) as RunRecord;
    records.push({ ...r, agent: `${r.agent}@${s.model}` });
  }
  const ledger = (await readLedger()).filter((e) => [...state.values()].some((s) => s.runId === e.ref || s.id === e.ref));
  const byAccount = new Map<string, number>();
  for (const e of ledger) byAccount.set(e.account, (byAccount.get(e.account) ?? 0) + e.usd);
  const judgedN = records.filter((r) => !r.extraction.extractor.startsWith("heuristic")).length;
  const md = [
    `# Batch ${dir.split("batch-").pop()}`,
    "",
    `${records.length} graded runs (${judgedN} judge-extracted, ${records.length - judgedN} heuristic only); ${[...state.values()].filter((s) => s.status === "failed").length} failed.`,
    `Agent-run spend: ${[...byAccount].map(([a, usd]) => `account ${a} $${usd.toFixed(2)}`).join(", ") || "$0"} (Router-reported where available, else token estimates).`,
    "",
    summaryTable(records),
  ].join("\n");
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, "runs.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""));
  await Bun.write(join(dir, "summary.md"), md);
  console.log(md);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
