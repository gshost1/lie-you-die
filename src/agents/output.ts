/**
 * Parse an agent's stdout into its final report and token usage.
 * Shapes are from each agent's docs (2026-10-14) and are lenient: on anything
 * unexpected, fall back to the raw stdout tail and unknown usage rather than
 * failing the run.
 */
export type OutputKind = "text" | "pi-json" | "opencode-json" | "droid-json" | "droid-stream-json" | "lyd";

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  /** Cache reads/writes where reported; not included in inputTokens. With
   * prompt caching (Sonnet via Router) nearly all input lands here. */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Provider-reported cost in USD (Ramp Router's usage.cost); null/absent when not reported. */
  cost?: number | null;
}

export interface ParsedOutput {
  report: string;
  usage: AgentUsage | null;
}

function jsonLines(stdout: string): unknown[] {
  const out: unknown[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.replace(/\r$/, "").trim();
    if (!t.startsWith("{")) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // partial or non-JSON line
    }
  }
  return out;
}

type Rec = Record<string, any>;
const tail = (s: string) => s.slice(-20_000);

/** pi / omp `--mode json`: sum usage over assistant message_end; report = last assistant text. */
function parsePi(stdout: string): ParsedOutput {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let seen = false;
  let report = "";
  for (const r of jsonLines(stdout) as Rec[]) {
    if (r.type !== "message_end" || r.message?.role !== "assistant") continue;
    const u = r.message.usage;
    if (u) {
      seen = true;
      input += u.input ?? 0;
      output += u.output ?? 0;
      cacheRead += u.cacheRead ?? 0;
      cacheWrite += u.cacheWrite ?? 0;
    }
    const text = (Array.isArray(r.message.content) ? r.message.content : [])
      .filter((c: Rec) => c.type === "text")
      .map((c: Rec) => c.text ?? "")
      .join("");
    if (text.trim()) report = text;
  }
  return { report: report || tail(stdout), usage: seen ? { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite } : null };
}

/**
 * opencode `run --format json`: event stream. Usage is taken from any
 * `tokens: {input, output}` object on step-finish style events; the report is
 * the last text part. Event schema UNVERIFIED (docs only say "raw JSON events").
 */
function parseOpencode(stdout: string): ParsedOutput {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let seen = false;
  let report = "";
  const visit = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    const o = v as Rec;
    if (o.tokens && typeof o.tokens === "object" && typeof o.tokens.input === "number") {
      seen = true;
      input += o.tokens.input;
      output += o.tokens.output ?? 0;
      cacheRead += o.tokens.cache?.read ?? 0;
      cacheWrite += o.tokens.cache?.write ?? 0;
      return;
    }
    if (o.type === "text" && typeof o.text === "string" && o.text.trim()) report = o.text;
    for (const x of Object.values(o)) visit(x);
  };
  for (const r of jsonLines(stdout)) visit(r);
  return {
    report: report || tail(stdout),
    usage: seen ? { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite } : null,
  };
}

/**
 * lyd-agent: stdout is the report only; usage comes from the `summary` line at
 * the end of its --log (cost is Router's usage.cost, null on DO).
 */
function parseLyd(stdout: string, log = ""): ParsedOutput {
  const summary = (jsonLines(log) as Rec[]).reverse().find((r) => r.type === "summary");
  const usage =
    summary && typeof summary.inputTokens === "number"
      ? { inputTokens: summary.inputTokens, outputTokens: summary.outputTokens ?? 0, cost: typeof summary.cost === "number" ? summary.cost : null }
      : null;
  return { report: stdout.trim() ? stdout : "", usage };
}

/** droid `exec --output-format json`: one result object. No usage in it (documented). */
function parseDroid(stdout: string): ParsedOutput {
  const objs = jsonLines(stdout) as Rec[];
  const res = objs.reverse().find((o) => o.type === "result");
  const u = res?.usage;
  return {
    report: typeof res?.result === "string" ? res.result : tail(stdout),
    usage:
      u && typeof u.input_tokens === "number"
        ? {
            inputTokens: u.input_tokens,
            outputTokens: u.output_tokens ?? 0,
            cacheReadTokens: u.cache_read_input_tokens ?? 0,
            cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
          }
        : null,
  };
}

/** `extra.log`: the agent's own log file, for agents that report usage there (lyd). */
/**
 * droid `exec --output-format stream-json`: event shape UNVERIFIED. Report =
 * the final result/completion text, else the last assistant text; usage = the
 * last object carrying input_tokens (same fields as the json result).
 */
function parseDroidStream(stdout: string): ParsedOutput {
  let report = "";
  let lastAssistant = "";
  let u: Rec | null = null;
  for (const r of jsonLines(stdout) as Rec[]) {
    for (const k of ["result", "finalText", "final_text"]) {
      if (typeof r[k] === "string" && r[k].trim() && ["result", "completion", "final"].includes(r.type)) report = r[k];
    }
    if (r.role === "assistant" && typeof r.text === "string" && r.text.trim()) lastAssistant = r.text;
    const usage = r.usage ?? r.session?.usage;
    if (usage && typeof usage.input_tokens === "number") u = usage;
  }
  return {
    report: report || lastAssistant || tail(stdout),
    usage: u
      ? { inputTokens: u.input_tokens, outputTokens: u.output_tokens ?? 0, cacheReadTokens: u.cache_read_input_tokens ?? 0, cacheWriteTokens: u.cache_creation_input_tokens ?? 0 }
      : null,
  };
}

export function parseAgentOutput(kind: OutputKind | undefined, stdout: string, extra: { log?: string } = {}): ParsedOutput {
  switch (kind) {
    case "lyd":
      return parseLyd(stdout, extra.log);
    case "pi-json":
      return parsePi(stdout);
    case "opencode-json":
      return parseOpencode(stdout);
    case "droid-json":
      return parseDroid(stdout);
    case "droid-stream-json":
      return parseDroidStream(stdout);
    default:
      return { report: tail(stdout), usage: null };
  }
}
