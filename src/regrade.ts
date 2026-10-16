// Re-grade finished runs offline after a grader/detector change: no VMs, no
// model calls. Re-runs detectors and ground truth on each run's saved
// workspace and exec log, and re-applies the misreport rules to the claims the
// judges already extracted (record.judged.json). The previous verdict is kept
// once as record.judged.v1.json.
//   bun src/regrade.ts --batch <name> | --dir <run dir> ...
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { ClaimExtractor } from "./claims/extractor.ts";
import { readExecLog } from "./exec-log.ts";
import { diffHashes, hashTree } from "./fs-utils.ts";
import { grade } from "./grader.ts";
import { loadTask } from "./tasks.ts";
import type { ExtractionResult, RunRecord } from "./types.ts";

const ROOT = join(import.meta.dir, "..");

/** Hands back claims already extracted, so re-grading never calls a judge. */
class StoredClaims implements ClaimExtractor {
  readonly name = "stored";
  constructor(private res: ExtractionResult) {}
  async extract() {
    return this.res;
  }
}

export async function regradeRun(dir: string): Promise<{ before: RunRecord; after: RunRecord }> {
  const judgedPath = join(dir, "record.judged.json");
  const hasJudged = await Bun.file(judgedPath).exists();
  const before = (await Bun.file(hasJudged ? judgedPath : join(dir, "record.json")).json()) as RunRecord;
  const task = await loadTask(before.task);
  const workspace = join(dir, "workspace");
  const after = await grade({
    task,
    agent: before.agent,
    condition: before.condition,
    runId: before.runId,
    startedAt: before.startedAt,
    durationMs: before.durationMs,
    workspace,
    diff: diffHashes(await hashTree(task.repoDir), await hashTree(workspace)),
    events: await readExecLog(join(dir, "exec.jsonl")),
    report: before.report,
    extractor: new StoredClaims({ claims: before.claims, ...before.extraction }),
  });
  return { before, after };
}

async function main() {
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: { batch: { type: "string" }, dir: { type: "string", multiple: true } } });
  let dirs: string[] = values.dir ?? [];
  if (values.batch) {
    const { readState } = await import("../vm/batch.ts");
    const state = await readState(join(ROOT, "runs", `batch-${values.batch}`, "jobs.jsonl"));
    dirs = [...dirs, ...[...state.values()].filter((s) => s.status === "done" && s.dir).map((s) => s.dir!)];
  }
  if (!dirs.length) throw new Error("usage: bun src/regrade.ts --batch <name> | --dir <run dir> ...");
  let changed = 0;
  for (const d of dirs) {
    const { before, after } = await regradeRun(d);
    const judgedPath = join(d, "record.judged.json");
    const v1 = join(d, "record.judged.v1.json");
    if ((await Bun.file(judgedPath).exists()) && !(await Bun.file(v1).exists())) await copyFile(judgedPath, v1);
    await Bun.write(judgedPath, JSON.stringify(after, null, 2) + "\n");
    const ids = (r: RunRecord) => r.detectorsFired.map((f) => f.id).join(",") || "-";
    const diff: string[] = [];
    if (before.shortcut !== after.shortcut || ids(before) !== ids(after)) diff.push(`shortcut ${ids(before)} → ${ids(after)}`);
    if (before.misreport !== after.misreport || before.misreportCategories.join() !== after.misreportCategories.join())
      diff.push(`misreport [${before.misreportCategories.join(",")}] → [${after.misreportCategories.join(",")}]`);
    if (before.groundTruth.visiblePass !== after.groundTruth.visiblePass) diff.push(`visiblePass ${before.groundTruth.visiblePass} → ${after.groundTruth.visiblePass}`);
    if (diff.length) {
      changed++;
      console.log(`${after.runId}: ${diff.join("; ")}`);
    }
  }
  console.log(`regraded ${dirs.length} runs, ${changed} changed`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
