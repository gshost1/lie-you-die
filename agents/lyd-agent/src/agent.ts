import type { ModelClient } from "./api.ts";
import { executeTool, truncate, type ExecEvent, type ToolContext, type ToolDef } from "./tools.ts";

export interface AgentOpts {
  client: ModelClient;
  tools: ToolDef[];
  ctx: ToolContext;
  maxSteps: number;
  log: (entry: Record<string, unknown>) => void;
  execLog?: (ev: ExecEvent) => void;
  progress?: (line: string) => void;
}

export type StopReason = "done" | "max_steps" | "error";

export interface AgentResult {
  /** The final assistant message; on max_steps/error, the last non-empty one. */
  report: string;
  stop: StopReason;
  steps: number;
  inputTokens: number;
  outputTokens: number;
  /** Summed provider-reported cost; null if no call reported one. */
  cost: number | null;
  error?: string;
}

/** model → tools → model ... until a reply has no tool calls or maxSteps model calls are spent. */
export async function runAgent(o: AgentOpts): Promise<AgentResult> {
  const r: AgentResult = { report: "", stop: "max_steps", steps: 0, inputTokens: 0, outputTokens: 0, cost: null };
  try {
    while (r.steps < o.maxSteps) {
      const step = ++r.steps;
      const t0 = performance.now();
      const turn = await o.client.next();
      r.inputTokens += turn.inputTokens;
      r.outputTokens += turn.outputTokens;
      if (turn.cost !== undefined) r.cost = (r.cost ?? 0) + turn.cost;
      o.log({
        type: "model",
        ts: new Date().toISOString(),
        step,
        latencyMs: Math.round(performance.now() - t0),
        inputTokens: turn.inputTokens,
        outputTokens: turn.outputTokens,
        cost: turn.cost ?? null,
        finish: turn.finish ?? null,
        toolCalls: turn.calls.length,
        text: truncate(turn.text, 2000),
      });
      if (turn.text.trim()) r.report = turn.text;
      if (turn.calls.length === 0) {
        r.report = turn.text;
        r.stop = "done";
        break;
      }
      const results: { id: string; output: string }[] = [];
      for (const call of turn.calls) {
        const t1 = performance.now();
        const res = await executeTool(call.name, call.args, o.ctx, o.tools);
        const durationMs = Math.round(performance.now() - t1);
        let args: unknown = call.args;
        try {
          args = JSON.parse(call.args);
        } catch {}
        o.log({
          type: "tool",
          ts: new Date().toISOString(),
          step,
          name: call.name,
          args,
          result: truncate(res.output, 2000),
          exit: res.exit ?? null,
          timedOut: res.timedOut ?? false,
          durationMs,
          ...(res.execEvents ? { execEvents: res.execEvents } : {}),
        });
        for (const ev of res.execEvents ?? []) o.execLog?.(ev);
        o.progress?.(`[step ${step}] ${call.name} ${truncate(call.args, 120).replace(/\s+/g, " ")} (${res.exit === undefined ? "" : `exit ${res.exit}, `}${durationMs}ms)`);
        results.push({ id: call.id, output: res.output });
      }
      o.client.addResults(results);
    }
  } catch (e) {
    r.stop = "error";
    r.error = (e as Error).message;
  }
  return r;
}
