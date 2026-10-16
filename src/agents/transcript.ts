/**
 * Exec evidence from an agent's own stdout transcript: every shell tool call it
 * logged, split into simple commands with lyd-agent's shell splitter. Source
 * "transcript". This is the agent CLI's account of what it ran (the model's bash
 * output sits escaped inside tool results, so it cannot forge a top-level
 * tool-call line), kept alongside the root-side tracer/poller, which misses
 * short processes on Freestyle's tracepoint-less kernel.
 *
 * Shapes seen on 2026-10-14 smoke runs:
 *   pi / omp   tool_execution_start {toolCallId, toolName:"bash", args.command}
 *              tool_execution_end   {toolCallId, isError, result.structuredContent?.exit_code}
 *   opencode   tool_use {timestamp, part:{tool:"bash", state:{status, input.command, metadata.exit}}}
 *   droid      stream-json: tool_call {id, toolName:"Execute", parameters.command, timestamp}
 *              tool_result {id, toolId, isError} (no exit code). Unknown shapes
 *              fall back to a lenient walk for any shell-tool object with a command.
 */
import { execEvents } from "../../agents/lyd-agent/src/tools.ts";
import type { ExecEvent } from "../types.ts";
import type { OutputKind } from "./output.ts";

type Rec = Record<string, any>;

interface ShellCall {
  command: string;
  exit: number | null;
  ts: string;
}

function jsonLines(stdout: string): Rec[] {
  const out: Rec[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // partial line
    }
  }
  return out;
}

/** "exit code 2" / "exited with 2" in a tool result's text, if present. */
function exitFromText(v: unknown): number | null {
  const m = JSON.stringify(v ?? "").match(/exit(?:ed with| code|Code)?[\s:=]*(\d{1,3})\b/i);
  return m ? Number(m[1]) : null;
}

function piCalls(recs: Rec[]): ShellCall[] {
  const calls = new Map<string, ShellCall>();
  for (const r of recs) {
    if (r.type === "tool_execution_start" && r.toolName === "bash" && typeof r.args?.command === "string") {
      calls.set(r.toolCallId, { command: r.args.command, exit: null, ts: "" });
    } else if (r.type === "tool_execution_end" && calls.has(r.toolCallId)) {
      const c = calls.get(r.toolCallId)!;
      const code = r.result?.structuredContent?.exit_code ?? r.result?.details?.exitCode;
      // No numeric code: isError false → 0; isError true → the text's code, else 1 (failed, code unknown).
      c.exit = typeof code === "number" ? code : r.isError ? (exitFromText(r.result) ?? 1) : 0;
    }
  }
  return [...calls.values()];
}

function opencodeCalls(recs: Rec[]): ShellCall[] {
  const out: ShellCall[] = [];
  for (const r of recs) {
    const p = r.part;
    if (p?.type !== "tool" || p.tool !== "bash" || typeof p.state?.input?.command !== "string") continue;
    const exit = p.state.metadata?.exit;
    out.push({
      command: p.state.input.command,
      exit: typeof exit === "number" ? exit : null,
      ts: typeof r.timestamp === "number" ? new Date(r.timestamp).toISOString() : "",
    });
  }
  return out;
}

function droidCalls(recs: Rec[]): ShellCall[] {
  const calls = new Map<string, ShellCall>();
  for (const r of recs) {
    if (r.type === "tool_call" && r.toolName === "Execute" && typeof r.parameters?.command === "string") {
      const ts = typeof r.timestamp === "number" ? new Date(r.timestamp).toISOString() : "";
      calls.set(r.id, { command: r.parameters.command, exit: null, ts });
    } else if (r.type === "tool_result" && calls.has(r.id)) {
      calls.get(r.id)!.exit = r.isError ? (exitFromText(r.value) ?? 1) : 0;
    }
  }
  return calls.size ? [...calls.values()] : genericCalls(recs);
}

const SHELL_TOOLS = /^(execute|bash|shell|run_shell_command|run_command)$/i;

/** Lenient walk for agents whose stream shape is unverified (droid). */
function genericCalls(recs: Rec[]): ShellCall[] {
  const out: ShellCall[] = [];
  const seen = new Set<string>();
  const visit = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    const o = v as Rec;
    const name = o.toolName ?? o.tool_name ?? o.name ?? o.tool;
    if (typeof name === "string" && SHELL_TOOLS.test(name)) {
      for (const k of ["parameters", "arguments", "args", "input"]) {
        let a = o[k];
        if (typeof a === "string") {
          try {
            a = JSON.parse(a);
          } catch {
            a = null;
          }
        }
        if (typeof a?.command === "string") {
          const id = String(o.id ?? o.toolCallId ?? o.toolUseId ?? `${out.length}:${a.command}`);
          if (!seen.has(id)) {
            seen.add(id);
            out.push({ command: a.command, exit: null, ts: "" });
          }
          return;
        }
      }
    }
    for (const x of Object.values(o)) visit(x);
  };
  recs.forEach(visit);
  return out;
}

export function transcriptExecEvents(kind: OutputKind | undefined, stdout: string, cwd: string): ExecEvent[] {
  const recs = jsonLines(stdout);
  const calls = kind === "pi-json" ? piCalls(recs) : kind === "opencode-json" ? opencodeCalls(recs) : kind === "droid-stream-json" ? droidCalls(recs) : [];
  return calls.flatMap((c, i) =>
    execEvents(c.command, cwd, c.exit, c.ts || `call:${i}`).map((e) => ({ ...e, source: "transcript" as const })),
  );
}
