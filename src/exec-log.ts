import { basename } from "node:path";
import type { ExecEvent } from "./types.ts";

/**
 * Command log contract: one JSON ExecEvent per line. Locally it comes from the
 * PATH shim (src/shim); on a VM it comes from the root-side tracer
 * (vm/exec-tracer.sh + vm/tracer-to-jsonl.ts), which the agent cannot touch,
 * plus, for agents that log their own commands (lyd-agent), source "agent".
 */
export async function readExecLog(path: string): Promise<ExecEvent[]> {
  const f = Bun.file(path);
  return (await f.exists()) ? parseExecLog(await f.text()) : [];
}

/** Lines without an argv array (e.g. a full agent log fed in by mistake) are skipped. */
export function parseExecLog(text: string): ExecEvent[] {
  const events: ExecEvent[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const ev = JSON.parse(line) as ExecEvent;
      if (Array.isArray(ev?.argv)) events.push(ev);
    } catch {
      // A torn final line (agent killed mid-write) is dropped, not fatal.
    }
  }
  return events;
}

/** Shell keywords and wrapper commands that run the rest of the line as the real command. */
const PREFIX_WORDS = new Set(["time", "do", "then", "else", "nohup", "command", "exec", "builtin", "!"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * argv minus leading wrappers (`time`, `timeout [-opts] 120`, `env [-opts] A=b`,
 * `nice [-n N]`, VAR=x assignments, `do`/`then` from loops and ifs), so
 * `time timeout 60 bun run report` matches the prefix `bun run report`.
 */
export function stripWrappers(argv: string[]): string[] {
  let i = 0;
  const flags = () => {
    while (i < argv.length && argv[i]!.startsWith("-")) i++;
  };
  while (i < argv.length) {
    const w = basename(argv[i]!);
    if (PREFIX_WORDS.has(w) || ASSIGNMENT.test(argv[i]!)) i++;
    else if (w === "timeout") {
      i++;
      while (i < argv.length && argv[i]!.startsWith("-")) i += /^-[ks]$/.test(argv[i]!) ? 2 : 1;
      i++; // duration
    } else if (w === "env") {
      i++;
      flags();
    } else if (w === "nice") {
      i++;
      if (argv[i] === "-n") i += 2;
      else flags();
    } else break;
  }
  return argv.slice(i);
}

/** argv without wrappers, with argv[0] reduced to its basename, joined by spaces. */
export function commandLine(ev: ExecEvent): string {
  const [first = "", ...rest] = stripWrappers(ev.argv);
  return [basename(first), ...rest].join(" ");
}

/** Does the event's command start with any prefix, on a word boundary? */
export function matchesCommand(ev: ExecEvent, prefixes: string[]): boolean {
  const line = commandLine(ev);
  return prefixes.some((p) => line === p || line.startsWith(p + " "));
}

export function lastMatching(events: ExecEvent[], prefixes: string[]): ExecEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (matchesCommand(ev, prefixes)) return ev;
  }
  return null;
}

export function ranSuccessfully(events: ExecEvent[], prefixes: string[]): boolean {
  return events.some((ev) => ev.exit === 0 && matchesCommand(ev, prefixes));
}

/** Ran at all: exit 0, or exit unknown (null). A known non-zero exit does not count. */
export function ranMaybeSuccessfully(events: ExecEvent[], prefixes: string[]): boolean {
  return events.some((ev) => (ev.exit === 0 || ev.exit == null) && matchesCommand(ev, prefixes));
}
