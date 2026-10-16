import type { ToolDef } from "./tools.ts";

export interface ToolCall {
  id: string;
  name: string;
  args: string;
}

/** One model response, normalised across APIs. */
export interface Turn {
  text: string;
  calls: ToolCall[];
  inputTokens: number;
  outputTokens: number;
  /** Router's usage.cost, USD, when the provider reports it. */
  cost?: number;
  finish?: string;
}

/** Holds the provider-native conversation; the loop only sees Turns. */
export interface ModelClient {
  next(): Promise<Turn>;
  addResults(results: { id: string; output: string }[]): void;
}

export interface ClientOpts {
  baseUrl: string;
  model: string;
  apiKey: string;
  system: string;
  prompt: string;
  tools: ToolDef[];
  maxTokens: number;
  retryDelayMs?: number;
}

/** POST with retries on network errors, 429 and 5xx. Error text never includes the key. */
async function post(o: ClientOpts, path: string, body: unknown): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await Bun.sleep((o.retryDelayMs ?? 2000) * 2 ** (attempt - 1));
    try {
      const res = await fetch(`${o.baseUrl.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${o.apiKey}` },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (res.ok) return JSON.parse(text);
      lastErr = new Error(`POST ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
      if (res.status !== 429 && res.status < 500) break;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

const num = (v: unknown) => (typeof v === "number" ? v : undefined);

/** OpenAI-compatible /chat/completions (DO). */
export class ChatClient implements ModelClient {
  private messages: any[];
  constructor(private o: ClientOpts) {
    this.messages = [
      { role: "system", content: o.system },
      { role: "user", content: o.prompt },
    ];
  }
  async next(): Promise<Turn> {
    const j = await post(this.o, "/chat/completions", {
      model: this.o.model,
      messages: this.messages,
      tools: this.o.tools.map((t) => ({ type: "function", function: t })),
      max_tokens: this.o.maxTokens,
    });
    const choice = j.choices?.[0];
    if (!choice?.message) throw new Error(`no choices in response: ${JSON.stringify(j).slice(0, 300)}`);
    const msg = choice.message;
    this.messages.push(msg); // as returned, so provider extras (e.g. reasoning_content) go back too
    const text = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.map((p: any) => p.text ?? "").join("") : "";
    return {
      text,
      calls: (msg.tool_calls ?? []).map((c: any) => ({ id: c.id, name: c.function?.name, args: c.function?.arguments ?? "{}" })),
      inputTokens: j.usage?.prompt_tokens ?? 0,
      outputTokens: j.usage?.completion_tokens ?? 0,
      cost: num(j.usage?.cost) ?? num(j.cost),
      finish: choice.finish_reason,
    };
  }
  addResults(results: { id: string; output: string }[]) {
    for (const r of results) this.messages.push({ role: "tool", tool_call_id: r.id, content: r.output });
  }
}

/** OpenAI Responses API (Ramp Router), stateless: the full input is resent each call. */
export class ResponsesClient implements ModelClient {
  private input: any[];
  constructor(private o: ClientOpts) {
    this.input = [{ role: "user", content: o.prompt }];
  }
  async next(): Promise<Turn> {
    const j = await post(this.o, "/responses", {
      model: this.o.model,
      instructions: this.o.system,
      input: this.input,
      tools: this.o.tools.map((t) => ({ type: "function", ...t })),
      max_output_tokens: this.o.maxTokens,
      store: false,
    });
    const output: any[] = j.output ?? [];
    this.input.push(...output);
    return {
      text: output
        .filter((it) => it.type === "message")
        .flatMap((it) => it.content ?? [])
        .filter((c: any) => c.type === "output_text")
        .map((c: any) => c.text ?? "")
        .join(""),
      calls: output.filter((it) => it.type === "function_call").map((it) => ({ id: it.call_id, name: it.name, args: it.arguments ?? "{}" })),
      inputTokens: j.usage?.input_tokens ?? 0,
      outputTokens: j.usage?.output_tokens ?? 0,
      cost: num(j.usage?.cost) ?? num(j.cost),
      finish: j.incomplete_details?.reason ?? j.status,
    };
  }
  addResults(results: { id: string; output: string }[]) {
    for (const r of results) this.input.push({ type: "function_call_output", call_id: r.id, output: r.output });
  }
}
