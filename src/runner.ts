import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDriver } from "./agents/driver.ts";
import type { ClaimExtractor } from "./claims/extractor.ts";
import { readExecLog } from "./exec-log.ts";
import { copyTree, diffHashes, hashTree } from "./fs-utils.ts";
import { grade } from "./grader.ts";
import { installShim } from "./shim/install.ts";
import type { Condition, LoadedTask, RunRecord } from "./types.ts";

export interface LocalRunOptions {
  task: LoadedTask;
  condition: Condition;
  agent: AgentDriver;
  extractor: ClaimExtractor;
  /** Where report, exec log and record are saved (inside runs/, gitignored). */
  outDir: string;
  keepWorkspace?: boolean;
}

/**
 * One local run. Layout under a fresh temp dir (never a real repo):
 *   <tmp>/ws/         copy of tasks/<id>/repo — the agent's whole world
 *   <tmp>/shim/bin/   PATH wrappers that log commands
 *   <tmp>/exec.jsonl  command log, outside the workspace
 * Hidden checks are never copied into ws/; the grader runs them afterwards on
 * a separate copy.
 */
export async function runLocal(o: LocalRunOptions): Promise<RunRecord> {
  const runId = `${o.task.spec.id}.${o.condition}.${o.agent.name.replace(/[^\w.-]/g, "_")}.${Date.now().toString(36)}`;
  const root = await mkdtemp(join(tmpdir(), "lyd-run-"));
  const ws = join(root, "ws");
  const execLog = join(root, "exec.jsonl");
  try {
    await copyTree(o.task.repoDir, ws);
    const before = await hashTree(ws);
    const PATH = await installShim(join(root, "shim", "bin"), execLog);

    const startedAt = new Date().toISOString();
    const t0 = performance.now();
    let report: string;
    try {
      ({ report } = await o.agent.run({ task: o.task, prompt: o.task.prompts[o.condition], workspace: ws, PATH }));
    } catch (err) {
      report = `[harness] agent crashed: ${err instanceof Error ? err.message : String(err)}`;
    }
    const durationMs = Math.round(performance.now() - t0);

    const after = await hashTree(ws);
    const events = await readExecLog(execLog);
    const record = await grade({
      task: o.task,
      agent: o.agent.name,
      condition: o.condition,
      runId,
      startedAt,
      durationMs,
      workspace: ws,
      diff: diffHashes(before, after),
      events,
      report,
      extractor: o.extractor,
    });

    const dir = join(o.outDir, runId);
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, "report.md"), report);
    await Bun.write(join(dir, "exec.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : ""));
    await Bun.write(join(dir, "record.json"), JSON.stringify(record, null, 2) + "\n");
    return record;
  } finally {
    if (!o.keepWorkspace) await rm(root, { recursive: true, force: true });
  }
}
