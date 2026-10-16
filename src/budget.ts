/**
 * Spend control across Ramp Router accounts (config/budget.json).
 *
 * - Ledger: runs/ledger.jsonl, append-only, one line per paid thing (an agent
 *   run or a judge call): key NAME, account, model, USD, and whether the USD
 *   came from Router (`router`) or a token estimate (`estimate`). Never a key value.
 * - KeyPool: before a paid step, `acquire()` picks the account with the most
 *   budget left after in-flight reservations and returns one of its key env
 *   names; `settle()` releases the reservation and appends the real cost.
 *   An account is skipped once spent + reserved + margin would pass its limit,
 *   so the batch stops cleanly instead of overspending.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentUsage } from "./agents/output.ts";

export const BUDGET_CONFIG = join(import.meta.dir, "..", "config", "budget.json");
export const LEDGER = join(import.meta.dir, "..", "runs", "ledger.jsonl");

export interface Prices {
  /** USD per million tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface BudgetConfig {
  /** false until the user confirms which key belongs to which account; paid batches refuse to start. */
  confirmed: boolean;
  /** Reserved per in-flight paid step (worst-case single run). */
  marginUsd: number;
  accounts: Record<string, { limitUsd: number; keys: string[] }>;
  /** Fallback prices for runs whose agent does not report Router's cost. */
  prices: Record<string, Prices>;
}

export interface LedgerEntry {
  ts: string;
  kind: "agent" | "judge" | "probe";
  ref: string;
  keyEnv: string;
  account: string;
  model: string;
  usd: number;
  source: "router" | "estimate";
}

export async function loadBudget(path = BUDGET_CONFIG): Promise<BudgetConfig> {
  return (await Bun.file(path).json()) as BudgetConfig;
}

export async function readLedger(path = LEDGER): Promise<LedgerEntry[]> {
  const f = Bun.file(path);
  if (!(await f.exists())) return [];
  const out: LedgerEntry[] = [];
  for (const line of (await f.text()).split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LedgerEntry);
    } catch {
      // torn last line
    }
  }
  return out;
}

/**
 * USD for one run: Router's own cost when the agent reported it, else tokens
 * × the configured prices (UNVERIFIED tables), else null (unknown).
 */
export function runCost(model: string, usage: AgentUsage | null | undefined, prices: Record<string, Prices>): { usd: number; source: "router" | "estimate" } | null {
  if (!usage) return null;
  if (typeof usage.cost === "number" && usage.cost > 0) return { usd: usage.cost, source: "router" };
  const p = prices[model];
  if (!p) return null;
  const usd = (usage.inputTokens * p.input + usage.outputTokens * p.output + (usage.cacheReadTokens ?? 0) * p.cacheRead + (usage.cacheWriteTokens ?? 0) * p.cacheWrite) / 1e6;
  return { usd, source: "estimate" };
}

export interface Lease {
  id: number;
  account: string;
  keyEnv: string;
}

export class KeyPool {
  private spent = new Map<string, number>();
  private reserved = new Map<number, Lease>();
  private nextId = 1;
  private turn = new Map<string, number>();

  constructor(
    private readonly cfg: BudgetConfig,
    ledger: LedgerEntry[],
    private readonly env: Record<string, string | undefined> = process.env,
    private readonly ledgerPath = LEDGER,
  ) {
    for (const e of ledger) this.spent.set(e.account, (this.spent.get(e.account) ?? 0) + e.usd);
  }

  /** Accounts in this pool with at least one key set in the environment. */
  accounts(): string[] {
    return Object.entries(this.cfg.accounts)
      .filter(([, a]) => a.keys.some((k) => this.env[k]?.trim()))
      .map(([name]) => name);
  }

  remaining(account: string): number {
    const limit = this.cfg.accounts[account]?.limitUsd ?? 0;
    const inFlight = [...this.reserved.values()].filter((l) => l.account === account).length * this.cfg.marginUsd;
    return limit - (this.spent.get(account) ?? 0) - inFlight;
  }

  spentBy(account: string): number {
    return this.spent.get(account) ?? 0;
  }

  /** Null when every account is at its limit (or has no key set). */
  acquire(only?: string[]): Lease | null {
    const candidates = this.accounts()
      .filter((a) => !only || only.includes(a))
      .filter((a) => this.remaining(a) - this.cfg.marginUsd >= 0)
      .sort((a, b) => this.remaining(b) - this.remaining(a));
    const account = candidates[0];
    if (!account) return null;
    const keys = this.cfg.accounts[account]!.keys.filter((k) => this.env[k]?.trim());
    const t = this.turn.get(account) ?? 0;
    this.turn.set(account, t + 1);
    const lease = { id: this.nextId++, account, keyEnv: keys[t % keys.length]! };
    this.reserved.set(lease.id, lease);
    return lease;
  }

  /** Release the reservation and record what it actually cost (null = unknown: the margin is charged). */
  async settle(lease: Lease, e: Omit<LedgerEntry, "ts" | "keyEnv" | "account" | "usd" | "source"> & { usd: number | null; source?: LedgerEntry["source"] }): Promise<LedgerEntry> {
    this.reserved.delete(lease.id);
    const usd = e.usd ?? this.cfg.marginUsd;
    const entry: LedgerEntry = {
      ts: new Date().toISOString(),
      kind: e.kind,
      ref: e.ref,
      keyEnv: lease.keyEnv,
      account: lease.account,
      model: e.model,
      usd,
      source: e.usd === null ? "estimate" : (e.source ?? "router"),
    };
    this.spent.set(lease.account, (this.spent.get(lease.account) ?? 0) + usd);
    await mkdir(dirname(this.ledgerPath), { recursive: true });
    await appendFile(this.ledgerPath, JSON.stringify(entry) + "\n");
    return entry;
  }
}
