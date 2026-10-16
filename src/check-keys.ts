#!/usr/bin/env bun
// `bun run check-keys`: test each key against its API and print ok/fail per key.
// Prints key NAMES and HTTP status codes only: never values, never response
// bodies. Bun loads .env automatically. Every probe is free (list/models calls
// or a deliberately invalid request that fails validation before any work).
import { Freestyle } from "freestyle";
import { loadAgentsConfig } from "./agents/cli-adapter.ts";
import { loadJudgeConfig, resolveKey } from "./claims/extractor.ts";

type Result = { ok: boolean; note: string };

const checks: Record<string, (key: string) => Promise<Result>> = {
  async FREESTYLE_API_KEY(key) {
    // Read-only list call; creates nothing.
    await new Freestyle({ apiKey: key }).vms.list();
    return { ok: true, note: "listed VMs" };
  },

  async MODEL_API_KEY(key) {
    // DigitalOcean inference model list: no tokens spent.
    const res = await fetch("https://inference.do-ai.run/v1/models", { headers: { authorization: `Bearer ${key}` } });
    if (!res.ok) return { ok: false, note: `GET /v1/models → HTTP ${res.status}` };
    const ids = ((await res.json()) as { data?: { id: string }[] }).data?.map((m) => m.id) ?? [];
    const { models } = await loadAgentsConfig();
    const want = Object.values(models).filter((m) => m.apiKeyEnv === "MODEL_API_KEY").map((m) => m.model);
    const missing = want.filter((m) => !ids.includes(m));
    return { ok: true, note: missing.length ? `models missing: ${missing.join(", ")}` : `models present: ${want.join(", ")}` };
  },

  async ROUTER_API_KEY(key) {
    // A Router (router.com) key. Two free probes: the model list must include
    // the configured Jev model, and an empty POST to systemone must fail
    // validation (400) rather than auth (401/403).
    const { jev } = await loadJudgeConfig();
    const auth = { authorization: `Bearer ${key}` };
    const models = await fetch(`${jev.baseUrl}/v1/models`, { headers: auth });
    if (!models.ok) return { ok: false, note: `GET /v1/models → HTTP ${models.status}` };
    const ids = ((await models.json()) as { data?: { id: string }[] }).data?.map((m) => m.id) ?? [];
    if (!ids.includes(jev.model)) return { ok: false, note: `auth ok, but ${jev.model} not in /v1/models` };
    // Router-served agent models and the LLM judge must be listed too (still free).
    const { models: profiles } = await loadAgentsConfig();
    const { llmJudge } = await loadJudgeConfig();
    const routerIds = [...Object.values(profiles).filter((m) => m.apiKeyEnv === "ROUTER_API_KEY").map((m) => m.model), llmJudge.model];
    const unlisted = routerIds.filter((m) => !ids.includes(m));
    const res = await fetch(`${jev.baseUrl}/v1/systemone`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: "{}",
    });
    if (res.status === 401 || res.status === 403) return { ok: false, note: `POST /v1/systemone → HTTP ${res.status} (rejected)` };
    const extra = unlisted.length ? `; NOT listed: ${unlisted.join(", ")}` : `; ${routerIds.join(", ")} listed`;
    if (res.status === 400 || res.status === 422) return { ok: true, note: `${jev.model} listed; systemone auth accepted (empty request → ${res.status})${extra}` };
    return { ok: false, note: `POST /v1/systemone → HTTP ${res.status} (inconclusive)` };
  },

  async FACTORY_API_KEY() {
    // No verified Factory endpoint for a free auth check yet. Presence only;
    // droid's first run on the snapshot is the real test.
    return { ok: true, note: "set (presence only: no verified check endpoint)" };
  },
};

let failed = 0;
for (const [name, check] of Object.entries(checks)) {
  const key = process.env[name]?.trim();
  let r: Result;
  // The Router key falls back to its older name; report which one was used.
  const router = name === "ROUTER_API_KEY" ? resolveKey((await loadJudgeConfig()).jev) : null;
  const useKey = router?.key ?? key;
  if (!useKey) r = { ok: false, note: name === "ROUTER_API_KEY" ? "not set (nor JEV_API_KEY)" : "not set" };
  else {
    try {
      r = await check(useKey);
      if (router && router.name !== name) r.note += ` [via ${router.name}]`;
    } catch (err) {
      // Error names/statuses only; messages could echo request details.
      const status = (err as { status?: number }).status;
      r = { ok: false, note: status ? `HTTP ${status}` : `${(err as Error).name ?? "error"}` };
    }
  }
  if (!r.ok) failed++;
  console.log(`${r.ok ? "ok  " : "FAIL"}  ${name.padEnd(18)} ${r.note}`);
}
process.exit(failed ? 1 : 0);
