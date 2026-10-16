import type { LoadedTask } from "../types.ts";

export interface DriverContext {
  task: LoadedTask;
  prompt: string;
  /** Throwaway copy of tasks/<id>/repo. */
  workspace: string;
  /** PATH with the exec-log shim first. */
  PATH: string;
}

/** Anything that can attempt a task and hand back its final report. */
export interface AgentDriver {
  readonly name: string;
  run(ctx: DriverContext): Promise<{ report: string }>;
}
