import { mkdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Same shape as ExecEvent in the repo's src/types.ts, with source "agent". */
export interface ExecEvent {
  ts: string;
  source: "agent";
  argv: string[];
  cwd?: string;
  exit?: number | null;
}

export interface ToolResult {
  output: string;
  exit?: number | null;
  timedOut?: boolean;
  execEvents?: ExecEvent[];
}

export interface ToolContext {
  workdir: string;
  bashTimeoutMs: number;
  maxOutput: number;
  testCmd?: string;
}

const obj = (props: Record<string, string>, required = Object.keys(props)) => ({
  type: "object",
  properties: Object.fromEntries(Object.entries(props).map(([k, d]) => [k, { type: "string", description: d }])),
  required,
});

export const BASE_TOOLS: ToolDef[] = [
  { name: "bash", description: "Run a bash command in the repository root. Returns combined stdout/stderr and the exit code.", parameters: obj({ command: "The command to run" }) },
  { name: "read_file", description: "Read a text file.", parameters: obj({ path: "File path" }) },
  { name: "write_file", description: "Create or overwrite a file with the given content. Creates parent directories.", parameters: obj({ path: "File path", content: "Full file content" }) },
  {
    name: "edit_file",
    description: "Replace one exact occurrence of old_string with new_string. Fails if old_string is missing or occurs more than once.",
    parameters: obj({ path: "File path", old_string: "Exact text to find", new_string: "Replacement text" }),
  },
];

export const RUN_TESTS: ToolDef = { name: "run_tests", description: "Run the project's test suite. Returns its output and exit code.", parameters: obj({}) };

/** Keeps the head and tail, with a marker saying how much was cut. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return `${s.slice(0, half)}\n[... ${s.length - 2 * half} chars truncated ...]\n${s.slice(-half)}`;
}

const REDIRECT = /^(\d+|&)?(>>|>\||>|<)/;

export interface Segment {
  argv: string[];
  /** Operator after this command: ; && || | & or "" at the end. */
  op: string;
}

/**
 * Splits a shell line into simple commands on ; && || | & and newlines,
 * honouring quotes and backslashes. Drops leading VAR=value assignments,
 * unquoted redirections (2>&1, >out, < in, &>log, <<<word) and heredoc bodies.
 * Approximate: subshells and $(...) are not parsed.
 * `complete` is false when a quote or heredoc is left open.
 */
export function parseShell(command: string): { segs: Segment[]; complete: boolean } {
  const segs: Segment[] = [];
  const heredocs: { delim: string; stripTabs: boolean }[] = [];
  let complete = true;
  let argv: string[] = [];
  let tok = "";
  let has = false;
  let quoted = false;
  let quote: string | null = null;
  let dropNext = false; // the target of a bare redirection operator ("> out")
  const pushTok = () => {
    if (has) {
      const redir = quoted ? null : REDIRECT.exec(tok);
      if (dropNext) dropNext = false;
      else if (redir) dropNext = redir[0] === tok;
      else argv.push(tok);
    }
    tok = "";
    has = false;
    quoted = false;
  };
  const endSeg = (op: string) => {
    pushTok();
    while (argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0]!)) argv.shift();
    if (argv.length) segs.push({ argv, op });
    argv = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < command.length) tok += command[++i];
      else tok += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
      quoted = true;
    } else if (c === "\\" && i + 1 < command.length) {
      tok += command[++i];
      has = true;
    } else if (c === " " || c === "\t") {
      pushTok();
    } else if (command.startsWith("&&", i) || command.startsWith("||", i)) {
      endSeg(command.slice(i, i + 2));
      i++;
    } else if (command.startsWith("<<<", i)) {
      pushTok(); // here-string: drop the operator and its word
      dropNext = true;
      i += 2;
    } else if (command.startsWith("<<", i)) {
      pushTok();
      i += 2;
      const stripTabs = command[i] === "-";
      if (stripTabs) i++;
      while (command[i] === " " || command[i] === "\t") i++;
      let delim = "";
      for (; i < command.length && !/[\s;&|<>()]/.test(command[i]!); i++) if (!`'"\\`.includes(command[i]!)) delim += command[i];
      i--;
      heredocs.push({ delim, stripTabs });
    } else if (c === "\n") {
      endSeg(";");
      // Bodies of heredocs opened on this line follow it, each ending at its delimiter line.
      for (const h of heredocs.splice(0)) {
        let start = i + 1;
        for (;;) {
          const nl = command.indexOf("\n", start);
          const end = nl === -1 ? command.length : nl;
          const line = command.slice(start, end);
          if ((h.stripTabs ? line.replace(/^\t+/, "") : line) === h.delim) {
            i = end;
            break;
          }
          if (nl === -1) {
            i = command.length;
            complete = false;
            break;
          }
          start = nl + 1;
        }
      }
    } else if (c === "&" && (command[i - 1] === ">" || command[i + 1] === ">")) {
      tok += c; // part of 2>&1 or &>file
      has = true;
    } else if ((c === ">" || c === "<") && has && !/^(\d+|&)$/.test(tok)) {
      pushTok(); // "foo>out" → "foo", ">out"
      tok = c;
      has = true;
    } else if (c === ";" || c === "|" || c === "&") {
      endSeg(c);
    } else {
      tok += c;
      has = true;
    }
  }
  endSeg("");
  if (quote || heredocs.length) complete = false;
  return { segs, complete };
}

export const splitCommands = (command: string): Segment[] => parseShell(command).segs;

/**
 * One ExecEvent per simple command, exit codes filled in only where they are
 * known. `pipeStatus` is bash's PIPESTATUS for the last pipeline that ran; it is
 * used when that was surely the line's final pipeline (nothing before it, or
 * only `;` before it, or an && chain that exited 0). Otherwise only the last
 * command gets the line's exit code. Commands before the final pipeline get 0
 * when they form an && chain and the line exited 0; else null (unknown).
 * Backgrounded commands get null.
 */
export function execEvents(command: string, cwd: string, exit: number | null, ts: string, pipeStatus?: number[]): ExecEvent[] {
  const segs = splitCommands(command);
  let p = segs.length - 1; // first command of the final pipeline
  while (p > 0 && segs[p - 1]!.op === "|") p--;
  const before = segs.slice(0, Math.max(p, 0)).map((s) => s.op);
  const ranAll = exit === 0 && before.every((op) => op === "&&");
  const exits: (number | null)[] = segs.map(() => null);
  if (pipeStatus && pipeStatus.length === segs.length - p && (ranAll || before.every((op) => op === ";"))) {
    pipeStatus.forEach((st, k) => (exits[p + k] = st));
  } else if (segs.length) exits[segs.length - 1] = exit;
  if (ranAll) for (let k = 0; k < p; k++) exits[k] = 0;
  return segs.map((s, i) => ({ ts, source: "agent", argv: s.argv, cwd, exit: s.op === "&" ? null : exits[i]! }));
}

/**
 * Runs `bash -c` in its own process group. On timeout, or once bash exits, the
 * whole group is killed so leftover background children can't hold the pipe.
 * A trailer appended after the command saves PIPESTATUS to a temp file (via an
 * unexported variable, invisible to the model and to child processes) and
 * exits with the command's own status. It is skipped when the command leaves a
 * quote or heredoc open, and never runs if the command calls exit itself.
 */
export async function runShell(command: string, ctx: ToolContext): Promise<ToolResult> {
  const ts = new Date().toISOString();
  const psFile = join(tmpdir(), `lyd-ps-${crypto.randomUUID()}`);
  const trailer =
    parseShell(command).complete && !command.endsWith("\\")
      ? `\n__lyd_ps="\${PIPESTATUS[*]}" __lyd_rc=$?; printf '%s' "$__lyd_ps" > '${psFile}'; exit $__lyd_rc`
      : "";
  const proc = Bun.spawn(["bash", "-c", `exec 2>&1\n${command}${trailer}`], { cwd: ctx.workdir, stdin: "ignore", stdout: "pipe", stderr: "ignore", detached: true });
  const killGroup = () => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {}
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup();
  }, ctx.bashTimeoutMs);
  const text = new Response(proc.stdout).text();
  await proc.exited;
  clearTimeout(timer);
  killGroup();
  const exit = timedOut ? null : proc.exitCode;
  let pipeStatus: number[] | undefined;
  try {
    const st = (await Bun.file(psFile).text()).trim().split(" ").map(Number);
    if (st.length && st.every(Number.isInteger)) pipeStatus = st;
    await unlink(psFile);
  } catch {}
  const tail = timedOut ? `[timed out after ${ctx.bashTimeoutMs / 1000}s; process killed]` : `[exit code: ${exit ?? `signal ${proc.signalCode}`}]`;
  return { output: `${truncate(await text, ctx.maxOutput)}\n${tail}`, exit, timedOut, execEvents: execEvents(command, ctx.workdir, exit, ts, timedOut ? undefined : pipeStatus) };
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new Error(`missing string argument "${key}"`);
  return v;
}

export async function editFile(path: string, oldStr: string, newStr: string): Promise<string> {
  if (oldStr === "") throw new Error("old_string is empty");
  const text = await Bun.file(path).text();
  const count = text.split(oldStr).length - 1;
  if (count === 0) throw new Error("old_string not found");
  if (count > 1) throw new Error(`old_string occurs ${count} times; include more context to make it unique`);
  const at = text.indexOf(oldStr);
  await Bun.write(path, text.slice(0, at) + newStr + text.slice(at + oldStr.length));
  return "Edited.";
}

/** Runs one tool call. Tool failures come back as "ERROR: ..." text for the model, never as exceptions. */
export async function executeTool(name: string, rawArgs: string, ctx: ToolContext, enabled: ToolDef[]): Promise<ToolResult> {
  try {
    if (!enabled.some((t) => t.name === name)) throw new Error(`unknown tool "${name}"`);
    const parsed: unknown = JSON.parse(rawArgs || "{}");
    if (typeof parsed !== "object" || parsed === null) throw new Error("arguments must be a JSON object");
    const args = parsed as Record<string, unknown>;
    const at = (p: string) => resolve(ctx.workdir, p);
    switch (name) {
      case "bash":
        return await runShell(str(args, "command"), ctx);
      case "run_tests":
        return await runShell(ctx.testCmd!, ctx);
      case "read_file":
        return { output: truncate(await Bun.file(at(str(args, "path"))).text(), ctx.maxOutput) };
      case "write_file": {
        const p = at(str(args, "path"));
        await mkdir(dirname(p), { recursive: true });
        await Bun.write(p, str(args, "content"));
        return { output: "Wrote file." };
      }
      case "edit_file":
        return { output: await editFile(at(str(args, "path")), str(args, "old_string"), str(args, "new_string")) };
    }
    throw new Error(`unknown tool "${name}"`);
  } catch (e) {
    return { output: `ERROR: ${(e as Error).message}` };
  }
}
