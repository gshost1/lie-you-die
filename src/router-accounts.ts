#!/usr/bin/env bun
// `bun run router-accounts [--call]`: for each Ramp Router key (ROUTER_API_KEY,
// ROUTER_API_KEY_2 … ROUTER_API_KEY_4), list which models the benchmark needs
// are available (free GET /v1/models). With --call, also make one tiny real
// call per key (kimi-k3, ≤16 output tokens, well under $0.001) to prove the key
// can spend, and print Router's reported cost. Prints key NAMES, HTTP status,
// model ids and costs only: never key values. Duplicate keys are reported by
// name. Bun loads the env file automatically.
const BASE = "https://api.router.com/v1";
const KEYS = ["ROUTER_API_KEY", "ROUTER_API_KEY_2", "ROUTER_API_KEY_3", "ROUTER_API_KEY_4"];
/** Models we use (agent, judges), plus open-weight candidates to replace DO. */
const NEEDED = ["claude-sonnet-5-5", "gpt-6-sol", "jev-1.13.0"];
const OPEN = /kimi|moonshot|deepseek|qwen|mimo|glm|minimax/i;
const CALL = Bun.argv.includes("--call");
export {};

const seen = new Map<string, string>(); // key value → first env name holding it
for (const name of KEYS) {
  const key = process.env[name]?.trim();
  if (!key) {
    console.log(`--    ${name.padEnd(17)} not set`);
    continue;
  }
  const dup = seen.get(key);
  if (dup) {
    console.log(`DUP   ${name.padEnd(17)} same key as ${dup}`);
    continue;
  }
  seen.set(key, name);
  const auth = { authorization: `Bearer ${key}` };
  try {
    const res = await fetch(`${BASE}/models`, { headers: auth });
    if (!res.ok) {
      console.log(`FAIL  ${name.padEnd(17)} GET /v1/models → HTTP ${res.status}`);
      continue;
    }
    const ids = (((await res.json()) as { data?: { id: string }[] }).data ?? []).map((m) => m.id);
    const have = NEEDED.filter((m) => ids.includes(m));
    const missing = NEEDED.filter((m) => !ids.includes(m));
    console.log(`ok    ${name.padEnd(17)} ${ids.length} models; needed: ${have.join(", ") || "none"}${missing.length ? `; MISSING: ${missing.join(", ")}` : ""}`);
    if (!CALL) {
      console.log(`      ${"".padEnd(17)} open-weight: ${ids.filter((i) => OPEN.test(i)).join(", ") || "none"}`);
      continue;
    }
    const call = await fetch(`${BASE}/responses`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ model: "kimi-k3", input: "Reply with the single word: ok", max_output_tokens: 16 }),
    });
    const body = (await call.json().catch(() => ({}))) as { usage?: { input_tokens?: number; output_tokens?: number; cost?: number }; error?: { type?: string; code?: string } };
    if (!call.ok) {
      // Error type/code only; messages could echo request details.
      console.log(`FAIL  ${"".padEnd(17)} kimi-k3 call → HTTP ${call.status} ${body.error?.type ?? ""} ${body.error?.code ?? ""}`);
      continue;
    }
    const u = body.usage;
    console.log(`ok    ${"".padEnd(17)} kimi-k3 call → tokens ${u?.input_tokens ?? "?"}/${u?.output_tokens ?? "?"}, cost $${u?.cost ?? "?"}`);
  } catch (err) {
    console.log(`FAIL  ${name.padEnd(17)} ${(err as Error).name ?? "error"}`);
  }
}
