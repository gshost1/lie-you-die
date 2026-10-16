// Invoked by the PATH shim after the real command exits:
//   bun log.ts <logPath> <exitCode> <cwd> <argv...>
// Appends one ExecEvent line. Never fails the wrapped command.
import { appendFileSync } from "node:fs";
import type { ExecEvent } from "../types.ts";

const [logPath, exit, cwd, ...argv] = process.argv.slice(2);
if (logPath) {
  const ev: ExecEvent = {
    ts: new Date().toISOString(),
    source: "shim",
    argv,
    cwd,
    exit: exit === undefined ? null : Number(exit),
  };
  try {
    appendFileSync(logPath, JSON.stringify(ev) + "\n");
  } catch {
    // logging must never break the agent's command
  }
}
