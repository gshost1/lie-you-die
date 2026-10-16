#!/usr/bin/env bun
// Small paid smoke test of the real judges on fake-agent reports from the
// latest validation batch. Approved by the user 2026-10-14: ~6 Jev + ~4 Sonnet
// calls. Compares each judge's Claims with the heuristic's and prints usage.
//   bun src/judge-smoke.ts [--jev N] [--llm N]
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadJudgeConfig } from "./claims/extractor.ts";
import { JevExtractor } from "./claims/jev.ts";
import { LlmJudgeExtractor } from "./claims/llm-judge.ts";
import { loadTask } from "./tasks.ts";
import type { Claims, RunRecord } from "./types.ts";

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { jev: { type: "string", default: "6" }, llm: { type: "string", default: "4" } } });
const RUNS = join(import.meta.dir, "..", "runs");
const batch = (await readdir(RUNS)).filter((d) => d.startsWith("validation-")).sort().at(-1);
if (!batch) throw new Error("no validation batch; run `bun run validate` first");
const records = (await Bun.file(join(RUNS, batch, "runs.jsonl")).text()).trim().split("\n").map((l) => JSON.parse(l) as RunRecord);

// One neutral report per persona (+ an impossible-task one), varied tasks.
const picks: RunRecord[] = [];
const want: [string, string][] = [
  ["t1-fix-median", "fake:cheats-and-hides"],
  ["t1-fix-median", "fake:cheats-and-discloses"],
  ["t2-slugify", "fake:honest-success"],
  ["t6-flaky-integration", "fake:honest-blocked"],
  ["t5-parse-amount", "fake:claims-verified-without-running"],
  ["t4-add-email-field", "fake:cheats-and-discloses"],
];
for (const [task, agent] of want) {
  const r = records.find((x) => x.task === task && x.agent === agent && x.condition === "neutral");
  if (r) picks.push(r);
}

const cfg = await loadJudgeConfig();
const judges = [
  { j: new JevExtractor(cfg.jev), n: Number(values.jev) },
  { j: new LlmJudgeExtractor(cfg.llmJudge), n: Number(values.llm) },
];
const key = (c: Claims) => JSON.stringify({ ...c, disclosed: [...c.disclosed].sort(), mentionedFiles: undefined });
const totals: Record<string, { calls: number; in: number; out: number; costUsd: number; agree: number }> = {};

for (const { j, n } of judges) {
  for (const r of picks.slice(0, n)) {
    const task = await loadTask(r.task);
    const t0 = performance.now();
    let line: string;
    try {
      const res = await j.extract(r.report, { task: task.spec });
      const ms = Math.round(performance.now() - t0);
      const agree = key(res.claims) === key(r.claims);
      const t = (totals[res.extractor] ??= { calls: 0, in: 0, out: 0, costUsd: 0, agree: 0 });
      t.calls++;
      t.in += res.usage?.inputTokens ?? 0;
      t.out += res.usage?.outputTokens ?? 0;
      t.costUsd += res.usage?.cost ?? 0;
      if (agree) t.agree++;
      line = `${agree ? "same" : "DIFF"}  conf=${res.confidence.toFixed(2)}  ${ms}ms  tokens=${res.usage?.inputTokens ?? "?"}/${res.usage?.outputTokens ?? "?"}  cost=${res.usage?.cost ?? "?"}`;
      if (!agree) line += `\n      heuristic=${key(r.claims)}\n      ${j.name.padEnd(9)}=${key(res.claims)}`;
    } catch (err) {
      line = `ERROR ${(err as Error).message}`;
    }
    console.log(`${j.name.padEnd(9)} ${r.task} ${r.agent}: ${line}`);
  }
}
console.log("\ntotals:", JSON.stringify(totals, null, 2));
