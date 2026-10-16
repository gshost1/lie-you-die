import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentDriver, DriverContext } from "./driver.ts";
import { parseAgentOutput, type OutputKind } from "./output.ts";

export const AGENTS_CONFIG = join(import.meta.dir, "..", "..", "config", "agents.json");
export const EDGE_KEY_PLACEHOLDER = "injected-at-freestyle-edge";

/** Wire API of a model profile. */
export type ModelApi = "chat" | "responses";

export interface ModelConfig {
  baseUrl: string;
  model: string;
  api: ModelApi;
  apiKeyEnv: string;
  apiKeyEnvFallback?: string;
  keyMode: "edge" | "env";
  /** No per-token charge (e.g. a free beta): batches run it outside the Router key pool and budget. */
  free?: boolean;
}

export interface AgentConfig {
  verified: boolean;
  install: string;
  command: string[];
  /** Values starting with "$" are read from the harness env at run time. */
  env: Record<string, string>;
  /** "~/..." path → JSON document, written under the run's HOME. */
  files: Record<string, unknown>;
  timeoutSec: number;
  output?: OutputKind;
  /** The agent's own name for each wire API ({providerApi}); missing = unsupported. */
  apis: Partial<Record<ModelApi, string>>;
  /** Local binary (relative to the repo root, {arch} = x64|arm64) uploaded to each VM. */
  binary?: string;
  /** Optional no-model command run before the agent on the same VM; stdout saved as preflight.json. */
  preflight?: string[];
  /** Files the agent writes besides stdout, pulled after the run. */
  artifacts?: { log?: string; execLog?: string };
  modelRoute?: "customModels" | "factory-native";
  factoryNativeModel?: string;
}

export interface AgentsConfig {
  defaultModel: string;
  models: Record<string, ModelConfig>;
  agents: Record<string, AgentConfig>;
}

export async function loadAgentsConfig(path = AGENTS_CONFIG): Promise<AgentsConfig> {
  return (await Bun.file(path).json()) as AgentsConfig;
}

export function modelProfile(cfg: AgentsConfig, name = cfg.defaultModel): ModelConfig {
  const m = cfg.models[name];
  if (!m) throw new Error(`unknown model "${name}"; known: ${Object.keys(cfg.models).join(", ")}`);
  return m;
}

/** The profile's key from the harness env (primary var, then fallback). */
export function modelKey(m: ModelConfig, env: Record<string, string | undefined> = process.env): string | undefined {
  return env[m.apiKeyEnv] || (m.apiKeyEnvFallback ? env[m.apiKeyEnvFallback] : undefined) || undefined;
}

export interface Invocation {
  argv: string[];
  output?: OutputKind;
  env: Record<string, string>;
  /** Absolute path → file contents. */
  files: Record<string, string>;
  timeoutSec: number;
  artifacts: { log?: string; execLog?: string };
  preflight?: string[];
}

/**
 * Pure rendering of one agent invocation, shared by local runs and the
 * Freestyle orchestrator, so the adapter is location-agnostic.
 */
export function renderInvocation(
  name: string,
  cfg: AgentsConfig,
  o: {
    prompt: string;
    home: string;
    apiKey: string;
    model?: string;
    workdir?: string;
    promptFile?: string;
    outDir?: string;
    harnessEnv?: Record<string, string | undefined>;
  },
): Invocation {
  const agent = cfg.agents[name];
  if (!agent) throw new Error(`unknown agent "${name}"; known: ${Object.keys(cfg.agents).join(", ")}`);
  const profile = modelProfile(cfg, o.model);
  const providerApi = agent.apis?.[profile.api];
  if (!providerApi) throw new Error(`agent "${name}" has no config for the ${profile.api} API (model ${profile.model})`);
  const model = agent.modelRoute === "factory-native" ? (agent.factoryNativeModel ?? "") : profile.model;
  const vars: Record<string, string> = {
    prompt: o.prompt,
    model,
    baseUrl: profile.baseUrl,
    apiKey: o.apiKey,
    providerApi,
    workdir: o.workdir ?? "",
    promptFile: o.promptFile ?? "",
    outDir: o.outDir ?? "",
  };
  const sub = (s: string) => s.replace(/\{(prompt|model|baseUrl|apiKey|providerApi|workdir|promptFile|outDir)\}/g, (_, k: string) => vars[k]!);
  const deep = (v: unknown): unknown =>
    typeof v === "string"
      ? sub(v)
      : Array.isArray(v)
        ? v.map(deep)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [sub(k), deep(x)]))
          : v;

  const env: Record<string, string> = {};
  const harnessEnv = o.harnessEnv ?? process.env;
  for (const [k, v] of Object.entries(agent.env)) {
    env[k] = v.startsWith("$") ? (harnessEnv[v.slice(1)] ?? "") : sub(v);
  }
  const files: Record<string, string> = {};
  for (const [p, doc] of Object.entries(agent.files)) {
    files[p.replace(/^~(?=\/)/, o.home)] = JSON.stringify(deep(doc), null, 2) + "\n";
  }
  const artifacts = Object.fromEntries(Object.entries(agent.artifacts ?? {}).map(([k, v]) => [k, sub(v)]));
  return { argv: agent.command.map(sub), env, files, timeoutSec: agent.timeoutSec, output: agent.output, artifacts, preflight: agent.preflight?.map(sub) };
}

/**
 * Local smoke-run driver for a real agent CLI. Gives the agent a private HOME
 * inside the run dir, so its config files never touch the user's real home.
 * The final report is the agent's stdout. Not used on Day 1 (needs the user's
 * OK, a model key and the agent installed).
 */
export class CliAgent implements AgentDriver {
  constructor(
    readonly name: string,
    private readonly cfg: AgentsConfig,
    private readonly model?: string,
  ) {}

  async run(ctx: DriverContext): Promise<{ report: string }> {
    const base = dirname(ctx.workspace);
    const home = join(base, "home");
    const profile = modelProfile(this.cfg, this.model);
    const apiKey = modelKey(profile);
    if (!apiKey) throw new Error(`${profile.apiKeyEnv} is not set`);
    const promptFile = join(base, "prompt.md");
    const outDir = join(base, "agent-out"); // outside the workspace
    await Bun.write(promptFile, ctx.prompt);
    await mkdir(outDir, { recursive: true });
    const inv = renderInvocation(this.name, this.cfg, { prompt: ctx.prompt, home, apiKey, model: this.model, workdir: ctx.workspace, promptFile, outDir });
    for (const [path, content] of Object.entries(inv.files)) {
      await mkdir(dirname(path), { recursive: true });
      await Bun.write(path, content);
    }
    const proc = Bun.spawn(inv.argv, {
      cwd: ctx.workspace,
      env: { PATH: ctx.PATH, HOME: home, TERM: "dumb", NO_COLOR: "1", ...inv.env },
      stdout: "pipe",
      stderr: "pipe",
      timeout: inv.timeoutSec * 1000,
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const exit = await proc.exited;
    await Bun.write(join(dirname(ctx.workspace), "agent.stderr"), stderr);
    return { report: parseAgentOutput(inv.output, stdout).report || `[harness] no stdout; exit ${exit}` };
  }
}
