import type { ExtractionResult, TaskSpec } from "../types.ts";

export interface ExtractionContext {
  task: TaskSpec;
}

/**
 * Turns an agent's free-text final report into typed Claims. Implementations:
 * - HeuristicExtractor: regexes, free, tuned to the fake agents' phrasing.
 * - JevExtractor: TypeSafe Jev typed decisions via Router (stub, no calls).
 * - LlmJudgeExtractor: LLM judge fallback via Router (stub, no calls).
 * - EscalatingExtractor: Jev first, LLM when Jev's confidence is low.
 */
export interface ClaimExtractor {
  readonly name: string;
  extract(report: string, ctx: ExtractionContext): Promise<ExtractionResult>;
}

export interface JudgeConfig {
  jev: import("./jev.ts").JevConfig;
  llmJudge: import("./llm-judge.ts").LlmJudgeConfig;
  escalationThreshold: number;
}

export const JUDGE_CONFIG = new URL("../../config/judge.json", import.meta.url).pathname;

/** Router key: ROUTER_API_KEY, else the fallback (JEV_API_KEY). Returns the var name used, never logs the value. */
export function resolveKey(c: { apiKeyEnv: string; apiKeyEnvFallback?: string }, env = process.env): { name: string; key: string } | null {
  for (const name of [c.apiKeyEnv, c.apiKeyEnvFallback]) {
    const key = name ? env[name]?.trim() : undefined;
    if (name && key) return { name, key };
  }
  return null;
}

export async function loadJudgeConfig(path = JUDGE_CONFIG): Promise<JudgeConfig> {
  return (await Bun.file(path).json()) as JudgeConfig;
}

/** Jev answers first; below `threshold` confidence the LLM judge decides. */
export class EscalatingExtractor implements ClaimExtractor {
  readonly name: string;
  constructor(
    private readonly primary: ClaimExtractor,
    private readonly fallback: ClaimExtractor,
    private readonly threshold = 0.8,
  ) {
    this.name = `${primary.name}->${fallback.name}@${threshold}`;
  }

  async extract(report: string, ctx: ExtractionContext): Promise<ExtractionResult> {
    const first = await this.primary.extract(report, ctx);
    const firstCall = { extractor: first.extractor, usage: first.usage };
    if (first.confidence >= this.threshold) return { ...first, calls: [firstCall] };
    const second = await this.fallback.extract(report, ctx);
    return { ...second, calls: [firstCall, { extractor: second.extractor, usage: second.usage }] };
  }
}
