# lyd-agent

Minimal baseline coding agent for lie-you-die. One loop, four tools, fixed prompt, so differences from pi/omp/opencode/droid can be pinned on their prompts, tools and loops.

## Build

    ./build.sh            # dist/lyd-agent-linux-x64, dist/lyd-agent-linux-arm64 (standalone, ~95 MB)
    bun test              # mock-server tests, no network
    ../../node_modules/.bin/tsc -p .

## Invoke

    lyd-agent --base-url https://inference.do-ai.run/v1 --model kimi-k3 --api chat \
      --api-key-env MODEL_API_KEY --workdir /path/to/repo --prompt-file task.md \
      --report out/report.md --log out/lyd.jsonl --exec-log out/exec.jsonl

    # Ramp Router: only /v1/responses exists (chat/completions is 404, checked 2026-10-14)
    lyd-agent --base-url https://api.router.com/v1 --model claude-sonnet-5-5 --api responses --api-key-env ROUTER_API_KEY ...

| flag | default | |
|---|---|---|
| `--prompt` / `--prompt-file` | required | task prompt |
| `--workdir` | cwd | bash cwd; relative file paths resolve here |
| `--api` | `chat` | `chat` (/chat/completions) or `responses` (/responses, stateless, `store:false`) |
| `--api-key-env` | `MODEL_API_KEY` | env var holding the key; unset → placeholder (Freestyle injects the real key) |
| `--max-steps` | 50 | model calls |
| `--max-tokens` | 16384 | per response |
| `--bash-timeout` | 120 | seconds; the process group is SIGKILLed |
| `--max-output` | 30000 | chars of tool output kept (head + tail, with marker) |
| `--report` / `--log` / `--exec-log` | off | output files |
| `--system-prompt-file` | embedded `system-prompt.txt` | override |
| `--honesty-clause` | off | appends the honesty sentence to the system prompt |
| `--test-tool` + `--test-cmd` | off | adds `run_tests`, which runs `--test-cmd` |

Add a switch: one entry in `SWITCHES` in `src/main.ts`.

Exit codes: 0 done, 2 max steps hit, 1 model/API error (4 attempts on 429/5xx/network), 64 bad usage.
Stdout is the report only; progress and the summary go to stderr.

## Outputs

- **report**: the final assistant message (no tool calls). On max steps or error, the last non-empty assistant text.
- **`--log`** JSONL: `start` (version, model, switches, tools, sha256 of system prompt and task prompt), then per model call `model` (latencyMs, inputTokens, outputTokens, cost, finish, toolCalls, text), per tool call `tool` (name, args, result truncated to 2000, exit, timedOut, durationMs, execEvents), and a final `summary` (stop, steps, tokens, cost, durationMs, error).
- **`--exec-log`** JSONL: ExecEvent lines only (`{ts, source:"agent", argv, cwd, exit}`), readable by `readExecLog`. One event per simple command in a bash line (split on `; && || | &` and newlines, quotes respected; `VAR=x` prefixes, unquoted redirections like `2>/dev/null` or `> out`, here-strings and heredoc bodies dropped). Exit codes are filled in only where known: every command in the final pipeline gets its own exit from bash's `PIPESTATUS` (so `bun test | tail` logs bun's real exit) when that pipeline surely ran (nothing before it, only `;` before it, or an `&&` chain that exited 0). Otherwise only the last command gets the line's exit. Commands before the final pipeline get 0 when they form an `&&` chain that exited 0, else null. `run_tests` emits events for `--test-cmd` too.

Put `--log` and `--exec-log` outside `--workdir`: the model's bash can write anywhere the process can.

Bash runs `bash -c` in its own process group, with stderr merged into stdout. No `pipefail`: exit codes the model sees are plain bash. A hidden trailer saves `PIPESTATUS` to a temp file through an unexported variable, then exits with the command's own status. The trailer is skipped when the command leaves a quote or heredoc open, and never runs if the command calls `exit` itself. When bash exits, leftover background children are killed, so a server started with `&` doesn't outlive its tool call.
