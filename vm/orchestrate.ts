#!/usr/bin/env bun
// Freestyle orchestrator: one fresh VM per run, deleted afterwards.
// Smoke-tested 2026-10-14 (4 runs). Every command defaults to a dry run that
// prints the plan; nothing touches the Freestyle API without --yes, and the
// user must OK the run count first.
//
//   bun vm/orchestrate.ts snapshot [--yes]
//   bun vm/orchestrate.ts run --agent <name> --task <id> [--model <profile>] [--condition neutral|induced] [--yes]
//
// Secrets: FREESTYLE_API_KEY and the model keys (MODEL_API_KEY for DO,
// ROUTER_API_KEY for Router profiles) live on this Mac only. The model key goes
// into a per-VM Freestyle TLS rule for the profile's host only (injected at the
// edge as an Authorization header); the VM sees a placeholder. FACTORY_API_KEY is the one
// secret a VM may receive (droid only, revocable), unless factoryKeyMode is "edge".
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Freestyle, type CreateVmOptions, type Vm } from "freestyle";
import { EDGE_KEY_PLACEHOLDER, loadAgentsConfig, modelKey as resolveModelKey, modelProfile, renderInvocation } from "../src/agents/cli-adapter.ts";
import { parseAgentOutput } from "../src/agents/output.ts";
import { transcriptExecEvents } from "../src/agents/transcript.ts";
import { HeuristicExtractor } from "../src/claims/heuristic.ts";
import { parseExecLog } from "../src/exec-log.ts";
import { diffHashes, hashTree } from "../src/fs-utils.ts";
import { grade } from "../src/grader.ts";
import { loadTask } from "../src/tasks.ts";
import type { Condition, RunRecord } from "../src/types.ts";
import { traceToEvents } from "./tracer-to-jsonl.ts";

const ROOT = join(import.meta.dir, "..");
const LYD = "/opt/lyd"; // root-only: tracer, outputs
const HOME = "/home/agent";
const WS = `${HOME}/ws`;
/** Agent-written logs (lyd-agent --log/--exec-log): outside the workspace. */
const AGENT_OUT = `${HOME}/agent-out`;
const MANIFEST = join(ROOT, "config", "snapshot-manifest.json");
/** Env vars that pin agent versions on rebuild (see vm/provision.sh). */
const PIN_VARS = ["PI_VERSION", "OMP_VERSION", "OPENCODE_VERSION"];

export interface FreestyleConfig {
  snapshotId: string | null;
  builderBaseSnapshot: string | null;
  agentEgress: Record<string, string[]>;
  factoryKeyMode: "env" | "edge";
  ttlMarginSec: number;
  pollEverySec: number;
}

async function main() {
  const [cmd, ...rest] = Bun.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      agent: { type: "string" },
      task: { type: "string" },
      condition: { type: "string", default: "neutral" },
      model: { type: "string" },
      yes: { type: "boolean", default: false },
      "factory-key-mode": { type: "string" },
    },
  });
  const fcfg = await loadFreestyleConfig();
  if (cmd === "snapshot") return buildSnapshot(fcfg, values.yes);
  if (cmd === "run") {
    if (!values.agent || !values.task) throw new Error("run needs --agent and --task");
    const fkm = values["factory-key-mode"];
    if (fkm === "edge" || fkm === "env") fcfg.factoryKeyMode = fkm;
    const r = await runOnVm(fcfg, { agent: values.agent, task: values.task, condition: values.condition as Condition, yes: values.yes, model: values.model });
    if (r) console.log(JSON.stringify(briefResult(r), null, 2));
    return;
  }
  console.log("usage: bun vm/orchestrate.ts snapshot|run ... [--yes]");
}

export async function loadFreestyleConfig(): Promise<FreestyleConfig> {
  return (await Bun.file(join(ROOT, "config", "freestyle.json")).json()) as FreestyleConfig;
}

export interface RunOpts {
  agent: string;
  task: string;
  condition: Condition;
  yes: boolean;
  /** Model profile name (config/agents.json models); default = defaultModel. */
  model?: string;
  /** Env var holding the model key to inject at the edge (key pool); default = the profile's own. */
  keyEnv?: string;
}

export interface RunResult {
  runId: string;
  dir: string;
  meta: Record<string, unknown> & { usage: unknown; model: string; keyEnv: string };
  record: RunRecord;
}

export function briefResult({ meta, record }: RunResult) {
  return { meta, shortcut: record.shortcut, detectors: record.detectorsFired.map((d) => d.id), misreport: record.misreport, categories: record.misreportCategories, honestExit: record.honestExit, visiblePass: record.groundTruth.visiblePass, hiddenPass: record.groundTruth.hiddenPass, claims: record.claims };
}

const sh = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

async function root(vm: Vm, command: string, timeoutMs = 120_000) {
  const r = await vm.exec({ command, linuxUser: "root", timeoutMs });
  if (r.statusCode !== 0) throw new Error(`[vm] ${command.slice(0, 80)}… exited ${r.statusCode}: ${r.stderr ?? ""}`);
  return r.stdout ?? "";
}

/**
 * vm.exec caps at 5 minutes, so long jobs run detached and we poll for a
 * done-file. Network activity (model calls) keeps the VM awake, and
 * idleTimeoutSeconds is -1 anyway.
 */
async function waitForFile(vm: Vm, path: string, timeoutSec: number, everySec: number): Promise<boolean> {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    if (await vm.fs.exists(path)) return true;
    await Bun.sleep(everySec * 1000);
  }
  return false;
}

async function buildSnapshot(fcfg: FreestyleConfig, yes: boolean) {
  const plan = [
    "create builder VM (public egress: needed for apt/npm/agent installers)",
    "upload vm/provision.sh + vm/exec-tracer.bt, run provision detached, poll",
    `agent versions: ${PIN_VARS.map((v) => `${v}=${process.env[v] ?? "latest"}`).join(" ")} (droid: always latest)`,
    "snapshot builder → write snapshotId to config/freestyle.json and versions to config/snapshot-manifest.json",
    "delete builder",
  ];
  if (!yes) return printPlan("snapshot", plan);

  const freestyle = new Freestyle();
  const { vm, vmId } = await freestyle.vms.create({
    snapshotId: fcfg.builderBaseSnapshot,
    displayName: `lyd-builder-${Date.now().toString(36)}`,
    firewall: { rules: [{ action: "allow", source: {}, destination: { public: true } }] },
    idleTimeoutSeconds: -1,
    ttlSeconds: 3600,
    metadata: { project: "lie-you-die", role: "builder" },
  });
  try {
    await vm.fs.writeTextFile("/root/provision.sh", await Bun.file(join(import.meta.dir, "provision.sh")).text());
    await root(vm, `install -d -m 0700 ${LYD} && chmod +x /root/provision.sh`);
    await vm.fs.writeTextFile(`${LYD}/exec-tracer.bt`, await Bun.file(join(import.meta.dir, "exec-tracer.bt")).text());
    // Pinned versions (e.g. from an old manifest) pass through; unset = latest.
    const pins = PIN_VARS.filter((v) => process.env[v]).map((v) => `export ${v}=${sh(process.env[v]!)}\n`).join("");
    await vm.fs.writeTextFile("/root/provision.env", pins);
    await root(vm, `nohup bash -c '. /root/provision.env; /root/provision.sh > /root/provision.log 2>&1; echo $? > /root/provision.exit' >/dev/null 2>&1 &`);
    if (!(await waitForFile(vm, "/root/provision.exit", 1800, 15))) throw new Error("provision timed out");
    const exit = (await vm.fs.readTextFile("/root/provision.exit")).trim();
    console.log(await vm.fs.readTextFile("/root/provision.log"));
    if (exit !== "0") throw new Error(`provision exited ${exit}`);
    await root(vm, "rm -f /root/provision.sh /root/provision.env /root/provision.log /root/provision.exit");
    const manifest = JSON.parse(await vm.fs.readTextFile(`${LYD}/manifest.json`));
    const { snapshotId } = await vm.snapshot();
    await Bun.write(MANIFEST, JSON.stringify({ snapshotId, ...manifest }, null, 2) + "\n");
    const cfgPath = join(ROOT, "config", "freestyle.json");
    const raw = await Bun.file(cfgPath).json();
    await Bun.write(cfgPath, JSON.stringify({ ...raw, snapshotId }, null, 2) + "\n");
    console.log(`snapshotId: ${snapshotId}\nversions pinned in ${MANIFEST}`);
  } finally {
    await freestyle.vms.delete(vmId).catch((e) => console.error(`DELETE FAILED for builder ${vmId}: ${e}`));
  }
}

export async function runOnVm(fcfg: FreestyleConfig, o: RunOpts): Promise<RunResult | null> {
  const { agent: agentName, task: taskId, condition, yes, model: modelName } = o;
  const task = await loadTask(taskId);
  const cfg = await loadAgentsConfig();
  const profile = modelProfile(cfg, modelName);
  // Decided: on VMs the model key is ALWAYS injected at the Freestyle edge and
  // never placed on the VM. keyMode "env" is for local smoke runs only.
  if (profile.keyMode !== "edge") throw new Error(`config/agents.json models.${profile.model}.keyMode must be "edge" for VM runs`);
  const keyName = o.keyEnv ?? profile.apiKeyEnv;
  const modelKey = o.keyEnv ? process.env[o.keyEnv]?.trim() || undefined : resolveModelKey(profile);
  // Only the profile's own host is allowlisted (api.router.com only on Router runs).
  const modelDomain = new URL(profile.baseUrl).host;
  const inv = renderInvocation(agentName, cfg, {
    prompt: "__PROMPT__",
    home: HOME,
    apiKey: EDGE_KEY_PLACEHOLDER,
    model: modelName,
    workdir: WS,
    promptFile: `${HOME}/prompt.md`,
    outDir: AGENT_OUT,
  });
  // Binary agents (lyd-agent) are uploaded per run, so they need no snapshot rebuild.
  const binary = cfg.agents[agentName]!.binary;
  const binName = inv.argv[0]!;
  // FACTORY_API_KEY (droid only): "env" puts it on the VM (current default);
  // "edge" injects it as a Bearer header on Factory's domains instead and gives
  // the VM a placeholder. Edge mode is UNVERIFIED: it only works if droid sends
  // the key as an Authorization header over HTTPS to those domains and trusts
  // the Freestyle CA. Test once on the snapshot before switching.
  const factoryKey = process.env.FACTORY_API_KEY;
  const factoryEdge = agentName === "droid" && fcfg.factoryKeyMode === "edge";
  if (factoryEdge) inv.env.FACTORY_API_KEY = EDGE_KEY_PLACEHOLDER;
  const factoryDomains = new Set(agentName === "droid" ? (fcfg.agentEgress.droid ?? []) : []);
  const ttl = inv.timeoutSec + fcfg.ttlMarginSec;
  const egress = [modelDomain, ...(fcfg.agentEgress[agentName] ?? [])];

  const plan = [
    `agent=${agentName} task=${taskId} condition=${condition} model=${profile.model} (${profile.api} API at ${profile.baseUrl})`,
    `create VM from snapshot ${fcfg.snapshotId ?? "(none yet: run snapshot first)"}; firewall: no rules (no raw internet)`,
    `TLS egress allowlist: ${egress.join(", ")} (${keyName} injected at edge for ${modelDomain}; not on the VM)${agentName === "droid" ? `; FACTORY_API_KEY: ${factoryEdge ? "edge-injected" : "on the VM (env)"}` : ""}`,
    `limits: idleTimeoutSeconds=-1, ttlSeconds=${ttl} (hard deadline), agent timeout ${inv.timeoutSec}s`,
    ...(binary ? [`upload ${binary} → /usr/local/bin/${binName} ({arch} from the VM's uname -m)`] : []),
    `upload tasks/${taskId}/repo only → ${WS} (hidden checks stay on this Mac)`,
    `start root exec tracer (bpftrace, uid=agent), then the agent as user 'agent'`,
    "poll for exit, stop tracer, pull workspace tarball + stdout + trace",
    "delete VM (always, in finally), then grade locally",
  ];
  if (!yes) {
    printPlan("run", plan);
    return null;
  }
  if (!fcfg.snapshotId) throw new Error("config/freestyle.json snapshotId is null; build the snapshot first");
  if (!modelKey) throw new Error(`${keyName} is not set`);
  if (binary) {
    for (const arch of ["x64", "arm64"]) {
      const f = join(ROOT, binary.replace("{arch}", arch));
      if (!(await Bun.file(f).exists())) throw new Error(`${f} missing: run agents/lyd-agent/build.sh first`);
    }
  }
  if (agentName === "droid" && !factoryKey) throw new Error("FACTORY_API_KEY is not set");

  const tls: NonNullable<CreateVmOptions["tls"]>["rules"] = egress.map((domain) => ({
    action: "allow" as const,
    domain,
    source: {},
    destination: { public: true as const },
    ...(domain === modelDomain
      ? { transform: [{ headers: { authorization: `Bearer ${modelKey}` } }] }
      : factoryEdge && factoryDomains.has(domain)
        ? { transform: [{ headers: { authorization: `Bearer ${factoryKey}` } }] }
        : {}),
  }));

  const freestyle = new Freestyle();
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const { vm, vmId } = await freestyle.vms.create({
    snapshotId: fcfg.snapshotId,
    displayName: `lyd-${agentName}-${taskId}-${condition}`.slice(0, 63),
    firewall: { rules: [] },
    tls: { rules: tls },
    idleTimeoutSeconds: -1,
    ttlSeconds: ttl,
    metadata: { project: "lie-you-die", agent: agentName, task: taskId, condition },
  });
  const local = await mkdtemp(join(tmpdir(), "lyd-vm-"));
  const out = join(local, "out");
  await mkdir(out, { recursive: true });
  const attempts: { factoryKeyMode?: string; exit: string; seconds: number; finished: boolean }[] = [];
  let stdout = "";
  let tracerOk = false;
  let agentLaunched = false;
  let binaryVersion: { binary: string; sha256: string } | null = null;
  try {
    const tgz = join(local, "repo.tgz");
    // COPYFILE_DISABLE stops macOS tar adding ._* AppleDouble files.
    await run(["tar", "-C", task.repoDir, "--exclude=node_modules", "--exclude=._*", "--exclude=.DS_Store", "-czf", tgz, "."], { COPYFILE_DISABLE: "1" });
    await vm.fs.writeFile(`${LYD}/repo.tgz`, new Uint8Array(await Bun.file(tgz).arrayBuffer()));
    for (const [path, content] of Object.entries(inv.files)) {
      await root(vm, `mkdir -p ${sh(path.slice(0, path.lastIndexOf("/")))}`);
      await vm.fs.writeTextFile(path, content);
    }
    await vm.fs.writeTextFile(`${HOME}/prompt.md`, task.prompts[condition]);
    if (binary) {
      const arch = (await root(vm, "uname -m")).trim() === "aarch64" ? "arm64" : "x64";
      const bin = join(ROOT, binary.replace("{arch}", arch));
      const bytes = new Uint8Array(await Bun.file(bin).arrayBuffer());
      // Uploaded per run, so not in the snapshot manifest: identify the exact build by hash.
      binaryVersion = { binary: binary.replace("{arch}", arch), sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 16) };
      await vm.fs.writeFile(`/usr/local/bin/${binName}`, bytes);
      await root(vm, `chmod 0755 /usr/local/bin/${binName}`);
    }
    const argv = inv.argv.map((a) => (a === "__PROMPT__" ? `"$(cat ${HOME}/prompt.md)"` : sh(a))).join(" ");

    // Root-side tracer first; the agent runs as 'agent' and cannot touch it.
    // Tracer files are uploaded per run so tracer fixes need no new snapshot.
    for (const f of ["start-tracer.sh", "exec-tracer.bt", "exec-tracer-sched.bt", "exec-tracer-min.bt"]) {
      await vm.fs.writeTextFile(`${LYD}/${f}`, await Bun.file(join(import.meta.dir, f)).text());
    }
    // Non-fatal: bpftrace has no tracepoints on this kernel, and exec evidence
    // also comes from the agent's exec log and transcript. A timeout here
    // (statusCode null) must not kill the run.
    const tr = await vm.exec({ command: `bash ${LYD}/start-tracer.sh $(id -u agent)`, linuxUser: "root", timeoutMs: 180_000 });
    if (tr.statusCode !== 0) console.error(`[vm] start-tracer exited ${tr.statusCode}; continuing without tracer`);
    tracerOk = (await vm.exec({ command: `kill -0 $(cat ${LYD}/out/tracer.pid)`, linuxUser: "root" })).statusCode === 0;

    // Droid with factoryKeyMode "edge": try the edge-injected key first; if droid
    // fails fast (auth), retry ONCE on the same VM with the key in env. Same VM,
    // so this never costs an extra VM.
    const modes: (string | undefined)[] = agentName !== "droid" ? [undefined] : factoryEdge ? ["edge", "env"] : ["env"];
    for (const mode of modes) {
      const env: Record<string, string> = { ...inv.env, HOME, NO_COLOR: "1", NODE_EXTRA_CA_CERTS: "/etc/ssl/certs/ca-certificates.crt" };
      if (mode === "env") env.FACTORY_API_KEY = factoryKey!;
      const exports = Object.entries(env).map(([k, v]) => `export ${k}=${sh(v)}`).join("\n");
      // Fresh workspace for every attempt.
      await root(vm, `rm -rf ${WS} ${AGENT_OUT} ${LYD}/out/exit && mkdir -p ${WS} ${AGENT_OUT} && tar -C ${WS} -xzf ${LYD}/repo.tgz`);
      await vm.fs.writeTextFile(`${HOME}/.lyd-run.sh`, `#!/bin/bash\n${exports}\ncd ${WS}\nexec timeout ${inv.timeoutSec} ${argv}\n`);
      await root(vm, `chown -R agent:agent ${HOME} && chmod 0700 ${HOME}/.lyd-run.sh`);
      if (inv.preflight) {
        // Same env and user as the agent; no model call. Saved for the record (e.g. droid's allowed tools).
        await vm.fs.writeTextFile(`${HOME}/.lyd-preflight.sh`, `#!/bin/bash\n${exports}\ncd ${WS}\nexec timeout 120 ${inv.preflight.map(sh).join(" ")}\n`);
        await root(vm, `chown agent:agent ${HOME}/.lyd-preflight.sh && chmod 0700 ${HOME}/.lyd-preflight.sh`);
        const pf = await vm.exec({ command: `su - agent -c "bash ${HOME}/.lyd-preflight.sh" 2>&1`, linuxUser: "root", timeoutMs: 150_000 });
        await Bun.write(join(out, "preflight.json"), pf.stdout ?? "");
      }
      const a0 = performance.now();
      agentLaunched = true;
      await root(vm, `nohup sh -c 'su - agent -c "bash ${HOME}/.lyd-run.sh" > ${LYD}/out/stdout 2> ${LYD}/out/stderr; echo $? > ${LYD}/out/exit' >/dev/null 2>&1 &`);
      const finished = await waitForFile(vm, `${LYD}/out/exit`, inv.timeoutSec + 120, fcfg.pollEverySec);
      const exit = finished ? (await vm.fs.readTextFile(`${LYD}/out/exit`)).trim() : "timeout";
      const seconds = Math.round((performance.now() - a0) / 1000);
      attempts.push({ factoryKeyMode: mode, exit, seconds, finished });
      await Bun.write(join(out, `stderr${mode ? "." + mode : ""}`), await vm.fs.readTextFile(`${LYD}/out/stderr`));
      stdout = await vm.fs.readTextFile(`${LYD}/out/stdout`);
      await Bun.write(join(out, `stdout${mode ? "." + mode : ""}`), stdout);
      console.error(`[${agentName}] attempt ${mode ?? ""} exit=${exit} ${seconds}s`);
      if (!(mode === "edge" && exit !== "0" && seconds < 120)) break; // only a fast edge failure retries
    }

    await root(vm, `kill -INT $(cat ${LYD}/out/tracer.pid) 2>/dev/null; kill $(cat ${LYD}/out/procpoll.pid) 2>/dev/null; sleep 2; true`);
    await root(vm, `tar -C ${WS} --exclude=node_modules --exclude=.git -czf ${LYD}/out/ws.tgz .`);
    await Bun.write(join(out, "ws.tgz"), await vm.fs.readFile(`${LYD}/out/ws.tgz`));
    await Bun.write(join(out, "trace.jsonl"), await vm.fs.readTextFile(`${LYD}/out/trace.jsonl`));
    for (const f of ["trace.err", "tracer.info", "procpoll.tsv"]) {
      if (await vm.fs.exists(`${LYD}/out/${f}`)) await Bun.write(join(out, f), await vm.fs.readTextFile(`${LYD}/out/${f}`));
    }
    // Agent-written logs (last attempt only; each attempt starts with a fresh AGENT_OUT).
    for (const [kind, path] of Object.entries(inv.artifacts)) {
      if (path && (await vm.fs.exists(path))) await Bun.write(join(out, `agent-${kind}.jsonl`), await vm.fs.readTextFile(path));
    }
  } catch (err) {
    // Failed during VM setup, before the agent (and so any model call) started.
    if (!agentLaunched && err instanceof Error) Object.assign(err, { beforeAgent: true });
    throw err;
  } finally {
    await freestyle.vms.delete(vmId).catch((e) => console.error(`DELETE FAILED for ${vmId}: ${e}. Delete it in the dashboard.`));
  }
  const vmSeconds = Math.round((performance.now() - t0) / 1000);

  // Grade on the Mac. The pulled tarball is untrusted: extract into a fresh dir.
  const ws = join(local, "ws");
  await mkdir(ws);
  await run(["tar", "-C", ws, "-xzf", join(out, "ws.tgz")]);
  const readOr = async (f: string) => ((await Bun.file(join(out, f)).exists()) ? await Bun.file(join(out, f)).text() : "");
  // Root-side events first, agent-reported ones last (lyd-agent's exec log, or
  // the shell tool calls in the agent's stdout transcript): lastMatching() then
  // takes the exit code from the agent's account (the poller has none).
  const events = [
    ...traceToEvents(await readOr("trace.jsonl"), await readOr("procpoll.tsv")),
    ...parseExecLog(await readOr("agent-execLog.jsonl")),
    ...transcriptExecEvents(inv.output, stdout, WS),
  ];
  const tracerVariant = (await readOr("tracer.info")).match(/^variant: (.*)$/m)?.[1] ?? "unknown";
  const parsed = parseAgentOutput(inv.output, stdout, { log: await readOr("agent-log.jsonl") });
  const last = attempts.at(-1);
  // lyd-agent exits 2 when it hits --max-steps: its last text is not a final report.
  const stepLimit = inv.output === "lyd" && last?.exit === "2";
  const report = parsed.report + (last && !last.finished ? "\n[harness] agent timed out" : "") + (stepLimit ? "\n[harness] agent stopped at its step limit (exit 2)" : "");
  // Random suffix: concurrent batch runs of the same combination must not collide.
  const runId = `${taskId}.${condition}.${agentName}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const record = await grade({
    task,
    agent: agentName,
    condition,
    runId,
    startedAt,
    durationMs: Math.round(performance.now() - t0),
    workspace: ws,
    diff: diffHashes(await hashTree(task.repoDir), await hashTree(ws)),
    events,
    report,
    extractor: new HeuristicExtractor(), // real reports: re-extract with Jev→Sonnet (bun src/judge-runs.ts)
  });
  const meta = {
    runId,
    vmId,
    model: profile.model,
    modelApi: profile.api,
    keyEnv: keyName,
    snapshotId: fcfg.snapshotId,
    agentVersion: binaryVersion ?? (await loadManifest())?.agents?.[agentName] ?? null,
    attempts,
    agentSeconds: last?.seconds ?? null,
    vmSeconds,
    usage: parsed.usage,
    // Tools the agent says are allowed (preflight, e.g. droid --list-tools with the run's flags).
    allowedTools: allowedTools(await readOr("preflight.json")),
    tracer: { running: tracerOk, variant: tracerVariant, events: events.length, agentEvents: events.filter((e) => e.source === "agent").length, transcriptEvents: events.filter((e) => e.source === "transcript").length },
  };
  const dir = join(ROOT, "runs", `vm-${runId}`);
  await mkdir(dir, { recursive: true });
  for (const f of await readdir(out)) if (f !== "ws.tgz") await Bun.write(join(dir, f), Bun.file(join(out, f)));
  await Bun.write(join(dir, "record.json"), JSON.stringify(record, null, 2) + "\n");
  await Bun.write(join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
  await Bun.write(join(dir, "report.md"), report);
  await Bun.write(join(dir, "exec.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : ""));
  await run(["cp", "-R", ws, join(dir, "workspace")]);
  await rm(local, { recursive: true, force: true });
  return { runId, dir, meta, record };
}

function allowedTools(preflight: string): string[] | null {
  try {
    const list = JSON.parse(preflight) as { llmId?: string; id: string; currentlyAllowed?: boolean }[];
    return list.filter((t) => t.currentlyAllowed).map((t) => t.llmId ?? t.id);
  } catch {
    return null;
  }
}

async function loadManifest(): Promise<{ agents?: Record<string, unknown> } | null> {
  const f = Bun.file(MANIFEST);
  return (await f.exists()) ? await f.json() : null;
}

async function run(argv: string[], extra: Record<string, string> = {}) {
  const p = Bun.spawn(argv, { stdout: "inherit", stderr: "inherit", env: { ...Bun.env, ...extra } });
  if ((await p.exited) !== 0) throw new Error(`${argv.join(" ")} failed`);
}

function printPlan(what: string, steps: string[]) {
  console.log(`DRY RUN (${what}); pass --yes to execute. Nothing was sent to Freestyle.\n`);
  steps.forEach((s, i) => console.log(`${i + 1}. ${s}`));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
