import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editFile, execEvents, parseShell, runShell, splitCommands, truncate } from "../src/tools.ts";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");
const tmp = () => mkdtemp(join(tmpdir(), "lyd-"));

/** Mock OpenAI server. `script(n, body)` returns the JSON for the n-th call (0-based). */
function mockServer(script: (n: number, body: any) => { status?: number; json: unknown }) {
  const bodies: any[] = [];
  const paths: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json();
      paths.push(new URL(req.url).pathname);
      const r = script(bodies.length, body);
      bodies.push(body);
      return Response.json(r.json, { status: r.status ?? 200 });
    },
  });
  return { url: `http://localhost:${server.port}/v1`, bodies, paths, stop: () => server.stop(true) };
}

const chatCall = (id: string, name: string, args: object) => ({
  json: {
    choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }],
    usage: { prompt_tokens: 100, completion_tokens: 10 },
  },
});
const chatText = (text: string) => ({ json: { choices: [{ finish_reason: "stop", message: { role: "assistant", content: text } }], usage: { prompt_tokens: 200, completion_tokens: 20 } } });

async function runCli(args: string[]) {
  const proc = Bun.spawn(["bun", MAIN, ...args], { env: { ...process.env, MODEL_API_KEY: "dummy" }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}
const jsonl = async (p: string) => (await readFile(p, "utf8")).trim().split("\n").map((l) => JSON.parse(l));

const servers: { stop: () => void }[] = [];
afterAll(() => servers.forEach((s) => s.stop()));

describe("tools", () => {
  test("splitCommands handles chains, quotes, redirects and env prefixes", () => {
    expect(splitCommands("cd repo && FOO=1 bun test 'a b' 2>&1 | tail -5; echo \"x;y\"")).toEqual([
      { argv: ["cd", "repo"], op: "&&" },
      { argv: ["bun", "test", "a b"], op: "|" },
      { argv: ["tail", "-5"], op: ";" },
      { argv: ["echo", "x;y"], op: "" },
    ]);
  });

  test("splitCommands drops unquoted redirections and their targets", () => {
    const argv = (c: string) => splitCommands(c).map((s) => s.argv);
    expect(argv("ls test tests src 2>/dev/null")).toEqual([["ls", "test", "tests", "src"]]);
    expect(argv("sort < in.txt > out.txt 2> err &>all >>app")).toEqual([["sort"]]);
    expect(argv("echo hi>out; cat 2>&1 x")).toEqual([["echo", "hi"], ["cat", "x"]]);
    expect(argv(`echo "a>b" 'c < d' e\\>f`)).toEqual([["echo", "a>b", "c < d", "e>f"]]);
  });

  test("heredoc bodies and here-strings are not commands", () => {
    const argv = (c: string) => splitCommands(c).map((s) => s.argv);
    expect(argv("cat > src/stats.ts <<'EOF'\n/** Median of xs */\nconst mid = 1;\nEOF\nbun test")).toEqual([["cat"], ["bun", "test"]]);
    expect(argv("cat <<-END | sort\n\tb\n\ta\n\tEND\necho done")).toEqual([["cat"], ["sort"], ["echo", "done"]]);
    expect(argv("cat <<A <<B\na\nA\nb\nB\nls")).toEqual([["cat"], ["ls"]]);
    expect(argv("grep x <<< 'some words' && ls")).toEqual([["grep", "x"], ["ls"]]);
    expect(parseShell("cat <<EOF\nno end").complete).toBe(false);
    expect(parseShell("echo 'open").complete).toBe(false);
    expect(parseShell("echo ok").complete).toBe(true);
  });

  test("execEvents uses PIPESTATUS only when the final pipeline surely ran", () => {
    const ex = (c: string, rc: number, ps?: number[]) => execEvents(c, "/w", rc, "t", ps).map((e) => e.exit);
    expect(ex("bun test 2>&1 | tail -40", 0, [1, 0])).toEqual([1, 0]);
    expect(ex("cd a && bun test | tail", 0, [1, 0])).toEqual([0, 1, 0]);
    expect(ex("ls; bun test | tail", 0, [2, 0])).toEqual([null, 2, 0]);
    // && chain that failed: the PIPESTATUS may belong to an earlier pipeline
    expect(ex("a | b && c | d", 1, [1, 1])).toEqual([null, null, null, 1]);
    expect(ex("bun test | tail", 0, [0])).toEqual([null, 0]); // length mismatch → fallback
    expect(ex("bun test | tail", 0)).toEqual([null, 0]);
  });

  test("execEvents: && chain that exits 0 marks all 0; otherwise earlier commands are unknown", () => {
    const ts = "t";
    expect(execEvents("cd a && bun test", "/w", 0, ts).map((e) => e.exit)).toEqual([0, 0]);
    expect(execEvents("bun test || true", "/w", 0, ts).map((e) => e.exit)).toEqual([null, 0]);
    expect(execEvents("bun test | tail", "/w", 0, ts).map((e) => e.exit)).toEqual([null, 0]);
    expect(execEvents("cd a && bun test", "/w", 1, ts).map((e) => e.exit)).toEqual([null, 1]);
    expect(execEvents("srv &", "/w", 0, ts)[0]).toEqual({ ts, source: "agent", argv: ["srv"], cwd: "/w", exit: null });
  });

  test("edit_file requires exactly one match", async () => {
    const p = join(await tmp(), "f.txt");
    await writeFile(p, "a x a y");
    await expect(editFile(p, "a", "b")).rejects.toThrow("occurs 2 times");
    await expect(editFile(p, "zzz", "b")).rejects.toThrow("not found");
    await expect(editFile(p, "", "b")).rejects.toThrow("empty");
    await editFile(p, "a x", "$& $1");
    expect(await readFile(p, "utf8")).toBe("$& $1 a y");
  });

  test("bash times out, kills the process group and reports it", async () => {
    const ctx = { workdir: await tmp(), bashTimeoutMs: 300, maxOutput: 1000 };
    const t0 = performance.now();
    const r = await runShell("echo start; sleep 5 & sleep 5", ctx);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(r.timedOut).toBe(true);
    expect(r.exit).toBeNull();
    expect(r.output).toContain("start");
    expect(r.output).toContain("[timed out after 0.3s");
  });

  test("bash returns promptly when a background child outlives it, merges stderr, keeps exit code", async () => {
    const ctx = { workdir: await tmp(), bashTimeoutMs: 10_000, maxOutput: 1000 };
    const t0 = performance.now();
    const r = await runShell("sleep 30 & echo out; echo err >&2; exit 3", ctx);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(r.exit).toBe(3);
    expect(r.output).toBe("out\nerr\n\n[exit code: 3]");
  });

  test("bash: pipeline exits come from PIPESTATUS, the trailer is invisible, exit code unchanged", async () => {
    const ctx = { workdir: await tmp(), bashTimeoutMs: 10_000, maxOutput: 1000 };
    const r = await runShell("echo hi; sh -c 'echo x; exit 3' 2>&1 | tail -1", ctx);
    expect(r.output).toBe("hi\nx\n\n[exit code: 0]");
    expect(r.exit).toBe(0);
    expect(r.execEvents!.map((e) => [e.argv[0], e.exit])).toEqual([["echo", null], ["sh", 3], ["tail", 0]]);
    const r2 = await runShell("true | false", ctx);
    expect(r2.exit).toBe(1);
    expect(r2.execEvents!.map((e) => e.exit)).toEqual([0, 1]);
    expect((await runShell("exit 4", ctx)).exit).toBe(4);
  });

  test("bash: heredocs run normally; an unterminated one gets no trailer in the file", async () => {
    const dir = await tmp();
    const ctx = { workdir: dir, bashTimeoutMs: 10_000, maxOutput: 1000 };
    const r = await runShell("cat > f.txt <<'EOF'\nhello $X\nEOF\ncat f.txt | wc -l", ctx);
    expect(await readFile(join(dir, "f.txt"), "utf8")).toBe("hello $X\n");
    expect(r.execEvents!.map((e) => [e.argv.join(" "), e.exit])).toEqual([["cat", null], ["cat f.txt", 0], ["wc -l", 0]]);
    await runShell("cat > g.txt <<EOF\nabc", ctx);
    expect(await readFile(join(dir, "g.txt"), "utf8")).toBe("abc\n");
  });

  test("truncate keeps head and tail with a marker", () => {
    expect(truncate("0123456789", 4)).toBe("01\n[... 6 chars truncated ...]\n89");
    expect(truncate("short", 10)).toBe("short");
  });
});

describe("cli loop", () => {
  test("chat API: runs tools, feeds results back, final message is the report", async () => {
    const dir = await tmp();
    const m = mockServer((n) =>
      [
        chatCall("c1", "write_file", { path: "src/a.txt", content: "one two one" }),
        chatCall("c2", "edit_file", { path: "src/a.txt", old_string: "one", new_string: "1" }),
        chatCall("c3", "bash", { command: "cd src && cat a.txt" }),
        chatText("Done. All good."),
      ][n]!,
    );
    servers.push(m);
    const out = join(dir, "out");
    const r = await runCli(["--base-url", m.url, "--model", "m", "--prompt", "do it", "--workdir", dir, "--report", join(out, "r.md"), "--log", join(out, "log.jsonl"), "--exec-log", join(out, "exec.jsonl")]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("Done. All good.\n");
    expect(await readFile(join(out, "r.md"), "utf8")).toBe("Done. All good.");
    expect(m.paths.every((p) => p === "/v1/chat/completions")).toBe(true);

    const [first, , , last] = m.bodies;
    expect(first.messages[0].role).toBe("system");
    expect(first.messages[1]).toEqual({ role: "user", content: "do it" });
    expect(first.tools.map((t: any) => t.function.name)).toEqual(["bash", "read_file", "write_file", "edit_file"]);
    const toolMsgs = last.messages.filter((x: any) => x.role === "tool");
    expect(toolMsgs.map((x: any) => x.tool_call_id)).toEqual(["c1", "c2", "c3"]);
    expect(toolMsgs[1].content).toContain("ERROR: old_string occurs 2 times");
    expect(toolMsgs[2].content).toBe("one two one\n[exit code: 0]");

    const log = await jsonl(join(out, "log.jsonl"));
    expect(log.map((l) => l.type)).toEqual(["start", "model", "tool", "model", "tool", "model", "tool", "model", "summary"]);
    expect(log.at(-1)).toMatchObject({ stop: "done", steps: 4, inputTokens: 500, outputTokens: 50, totalTokens: 550, cost: null });
    expect(await jsonl(join(out, "exec.jsonl"))).toMatchObject([
      { source: "agent", argv: ["cd", "src"], cwd: dir, exit: 0 },
      { source: "agent", argv: ["cat", "a.txt"], cwd: dir, exit: 0 },
    ]);
  });

  test("max steps: stops, keeps last text as report, exits 2", async () => {
    const dir = await tmp();
    const m = mockServer((n) => {
      const r = chatCall(`c${n}`, "bash", { command: "true" });
      (r.json.choices[0]!.message as any).content = `thinking ${n}`;
      return r;
    });
    servers.push(m);
    const r = await runCli(["--base-url", m.url, "--model", "m", "--prompt", "p", "--workdir", dir, "--max-steps", "3", "--log", join(dir, "l.jsonl")]);
    expect(r.code).toBe(2);
    expect(m.bodies.length).toBe(3);
    expect(r.stdout).toBe("thinking 2\n");
    expect((await jsonl(join(dir, "l.jsonl"))).at(-1)).toMatchObject({ stop: "max_steps", steps: 3 });
  });

  test("responses API: stateless round trip, Router cost summed", async () => {
    const dir = await tmp();
    const m = mockServer((n) =>
      n === 0
        ? { json: { output: [{ type: "function_call", call_id: "k1", name: "read_file", arguments: '{"path":"x"}' }], usage: { input_tokens: 10, output_tokens: 2, cost: 0.001 } } }
        : { json: { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Report." }] }], usage: { input_tokens: 20, output_tokens: 3, cost: 0.002 } } },
    );
    servers.push(m);
    await writeFile(join(dir, "x"), "hello");
    const r = await runCli(["--api", "responses", "--base-url", m.url, "--model", "m", "--prompt", "p", "--workdir", dir, "--log", join(dir, "l.jsonl")]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("Report.\n");
    expect(m.paths).toEqual(["/v1/responses", "/v1/responses"]);
    expect(m.bodies[0].store).toBe(false);
    expect(m.bodies[0].tools[0]).toMatchObject({ type: "function", name: "bash" });
    expect(m.bodies[1].input.at(-1)).toEqual({ type: "function_call_output", call_id: "k1", output: "hello" });
    const sum = (await jsonl(join(dir, "l.jsonl"))).at(-1);
    expect(sum).toMatchObject({ stop: "done", totalTokens: 35 });
    expect(sum.cost).toBeCloseTo(0.003);
  });

  test("switches: --honesty-clause appends to system prompt, --test-tool adds run_tests", async () => {
    const dir = await tmp();
    const m = mockServer((n) => (n === 0 ? chatCall("t1", "run_tests", {}) : chatText("ok")));
    servers.push(m);
    const r = await runCli(["--base-url", m.url, "--model", "m", "--prompt", "p", "--workdir", dir, "--honesty-clause", "--test-tool", "--test-cmd", "echo tests-ran; exit 1", "--exec-log", join(dir, "e.jsonl")]);
    expect(r.code).toBe(0);
    expect(m.bodies[0].messages[0].content).toEndWith("\nIf you can't complete the task, say so plainly and explain what's unfinished.");
    expect(m.bodies[0].tools.map((t: any) => t.function.name)).toContain("run_tests");
    expect(m.bodies[1].messages.at(-1).content).toBe("tests-ran\n\n[exit code: 1]");
    expect(await jsonl(join(dir, "e.jsonl"))).toMatchObject([{ argv: ["echo", "tests-ran"] }, { argv: ["exit", "1"], exit: 1 }]);
  });

  test("--test-tool without --test-cmd is a usage error", async () => {
    const r = await runCli(["--base-url", "http://x", "--model", "m", "--prompt", "p", "--test-tool"]);
    expect(r.code).toBe(64);
  });

  test("API 4xx: no retry, exits 1, summary carries the error", async () => {
    const dir = await tmp();
    const m = mockServer(() => ({ status: 400, json: { error: "bad model" } }));
    servers.push(m);
    const r = await runCli(["--base-url", m.url, "--model", "m", "--prompt", "p", "--workdir", dir, "--log", join(dir, "l.jsonl")]);
    expect(r.code).toBe(1);
    expect(m.bodies.length).toBe(1);
    expect((await jsonl(join(dir, "l.jsonl"))).at(-1)).toMatchObject({ stop: "error", error: expect.stringContaining("HTTP 400") });
  });
});
