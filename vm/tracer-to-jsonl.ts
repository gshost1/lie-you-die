// Convert root-side tracer output into ExecEvent JSONL. Handles all three
// tracer variants from vm/start-tracer.sh plus the /proc poller backstop.
//   A {"type":"printf","data":"E\t<pid>\t<ppid>\t<ns>\t"} then {"type":"join","data":"bun\x1ftest"}
//   B {"type":"printf","data":"E\t<pid>\t<ppid>\t<ns>\tbun\\x00test\\x00\n"}   (%r buffer)
//   C {"type":"printf","data":"F\t<pid>\t<ns>\t/usr/local/bin/bun\n"}         (no argv)
//   X {"type":"printf","data":"X\t<pid>\t<exit>\t<ns>\n"}                       (A and B)
//   procpoll.tsv: <pid>\t<epoch-ns>\t<argv joined by \x1f>
import type { ExecEvent } from "../src/types.ts";

export function traceToEvents(raw: string, procpoll = ""): ExecEvent[] {
  const events: ExecEvent[] = [];
  const lastByPid = new Map<number, ExecEvent>();
  let pending: { pid: number; ns: string } | null = null;
  const push = (pid: number, ns: string, argv: string[]) => {
    const ev: ExecEvent = { ts: ns.startsWith("epoch:") ? ns : `boot+${ns}ns`, source: "tracer", pid, argv, exit: null };
    events.push(ev);
    lastByPid.set(pid, ev);
  };

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let rec: { type?: string; data?: unknown };
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type === "printf" && typeof rec.data === "string") {
      const f = rec.data.replace(/\n$/, "").split("\t");
      const [tag, pid] = f;
      if (tag === "E") {
        const buf = f.slice(4).join("\t");
        if (buf) push(Number(pid), f[3] ?? "", splitArgv(buf)); // variant B
        else pending = { pid: Number(pid), ns: f[3] ?? "" }; // variant A: join follows
      } else if (tag === "F") {
        push(Number(pid), f[2] ?? "", [f[3] ?? ""]); // variant C: path only
      } else if (tag === "X") {
        const ev = lastByPid.get(Number(pid));
        if (ev) ev.exit = Number(f[2]);
      }
    } else if (rec.type === "join" && pending) {
      push(pending.pid, pending.ns, String(rec.data).split("\x1f").filter((s) => s !== ""));
      pending = null;
    }
  }

  // /proc poller: fill in argv for path-only events, add processes the tracer missed.
  for (const line of procpoll.split("\n")) {
    const [pidS, ns, cmd] = line.split("\t");
    if (!pidS || !cmd) continue;
    const pid = Number(pidS);
    const argv = cmd.split("\x1f").filter((s) => s !== "");
    const ev = lastByPid.get(pid);
    if (ev && ev.argv.length <= 1) ev.argv = argv;
    else if (!ev) push(pid, `epoch:${ns}`, argv);
  }
  return events;
}

/** %r renders NUL separators as the text "\x00". */
function splitArgv(buf: string): string[] {
  return buf.split(/\\x00|\x00/).filter((s) => s !== "");
}

if (import.meta.main) {
  const [file, poll] = Bun.argv.slice(2);
  const raw = file ? await Bun.file(file).text() : await new Response(Bun.stdin.stream()).text();
  const pp = poll ? await Bun.file(poll).text() : "";
  for (const ev of traceToEvents(raw, pp)) console.log(JSON.stringify(ev));
}
