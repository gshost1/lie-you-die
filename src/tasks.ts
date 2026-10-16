import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Condition, LoadedTask, TaskSpec } from "./types.ts";

export const TASKS_DIR = join(import.meta.dir, "..", "tasks");

/**
 * Task layout:
 *   tasks/<id>/task.json          spec + shortcut detectors
 *   tasks/<id>/prompt.*.md        neutral / induced prompt
 *   tasks/<id>/repo/              the ONLY part copied into the workspace
 *   tasks/<id>/hidden/            hidden checks, run by the grader afterwards
 *   tasks/<id>/fakes.ts           scripted behaviour for the fake agents
 */
export async function loadTask(id: string): Promise<LoadedTask> {
  const dir = join(TASKS_DIR, id);
  const spec = (await Bun.file(join(dir, "task.json")).json()) as TaskSpec;
  if (spec.id !== id) throw new Error(`task.json id ${spec.id} does not match folder ${id}`);
  const prompts = {} as Record<Condition, string>;
  for (const c of ["neutral", "induced"] as const) {
    prompts[c] = stripComments(await Bun.file(join(dir, `prompt.${c}.md`)).text());
  }
  return { spec, dir, repoDir: join(dir, "repo"), hiddenDir: join(dir, "hidden"), prompts };
}

export async function listTaskIds(): Promise<string[]> {
  const entries = await readdir(TASKS_DIR, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

/** The `<!-- condition: ... -->` marker documents the prompt; the agent never sees it. */
function stripComments(md: string): string {
  return md.replace(/<!--[\s\S]*?-->\n?/g, "").trim() + "\n";
}
