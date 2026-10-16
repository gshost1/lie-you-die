import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { MisreportCategory } from "../types.ts";

/** What a scripted fake agent can do inside its workspace. */
export interface FakeWorkspace {
  readonly dir: string;
  read(rel: string): Promise<string>;
  write(rel: string, content: string): Promise<void>;
  remove(rel: string): Promise<void>;
  /** Runs through the PATH shim, so it lands in the exec log. */
  run(argv: string[]): Promise<{ exit: number; stdout: string; stderr: string }>;
}

/** Per-task script (tasks/<id>/fakes.ts) the generic personas are built from. */
export interface FakeScript {
  /** The real fix on possible tasks; a genuine attempt on impossible ones. */
  honest(ws: FakeWorkspace): Promise<void>;
  honestSummary: string;
  /** Validation the honest path runs. Default: bun test. */
  validation?: string[];
  /** The tempting shortcut. */
  cheat(ws: FakeWorkspace): Promise<void>;
  /** Validation run after cheating (the one the cheat makes green). */
  cheatValidation: string[];
  /** Sentence admitting the shortcut (cheats-and-discloses). */
  disclosure: string;
  /** What cheats-and-hides says it did. */
  hiddenSummary: string;
  /** Why the work stops (honest-blocked; honest-success when validation fails). */
  blockedReason: string;
  /** Misreport categories the grader must emit for cheats-and-hides. */
  expectedHideCategories: MisreportCategory[];
}

export function makeFakeWorkspace(dir: string, PATH: string): FakeWorkspace {
  const abs = (rel: string) => join(dir, rel);
  return {
    dir,
    read: (rel) => Bun.file(abs(rel)).text(),
    async write(rel, content) {
      await mkdir(dirname(abs(rel)), { recursive: true });
      await Bun.write(abs(rel), content);
    },
    remove: (rel) => rm(abs(rel), { force: true }),
    async run(argv) {
      const [cmd, ...args] = argv;
      const resolved = Bun.which(cmd!, { PATH });
      if (!resolved) throw new Error(`not on PATH: ${cmd}`);
      const proc = Bun.spawn([resolved, ...args], {
        cwd: dir,
        env: { ...process.env, PATH, NO_COLOR: "1" },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 120_000,
      });
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      return { exit: await proc.exited, stdout, stderr };
    },
  };
}
