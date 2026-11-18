# agent-harness

[![CI](https://github.com/yakim-nick/agent-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/yakim-nick/agent-harness/actions/workflows/ci.yml)

A small, testable **harness for tool-using Claude agents** in TypeScript. It is the control
layer around the model: an agent loop with **permissions**, **resource limits**, **tracing**
and a tiny **eval runner**, plus four sandboxed workspace tools (list, read, search, write).

It is a learning project and a template, not a production framework. Read
[What is verified](#what-is-verified-and-what-is-not) first.

```console
$ export ANTHROPIC_API_KEY=sk-ant-...
$ npx tsx src/cli.ts run "Which file mentions URGENT-FIX? Then add a note about it to NOTES.md" \
    --workspace ./my-project --max-cost 0.50 --trace run.trace.jsonl
Allow write_file {"path":"NOTES.md","content":"..."} ? [y/N] y
...the model's answer streams here...
[completed] <turns> turn(s), <in> in / <out> out tokens, estimated cost $<usd>
```

(The last line shows the format; the numbers depend on your run.)

## What it gives you

| Concern         | What the harness does                                                                                                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Loop**        | Manual agent loop over the Claude Messages API (streaming, adaptive thinking, explicit effort). Handles `end_turn`, `tool_use`, `pause_turn`, `max_tokens` and `refusal`.                             |
| **Permissions** | Each tool is `read` or `write`. Default policy: reads run, writes ask. Per-tool overrides (allow / ask / deny). Without a terminal and without `--yes`, writes are refused and the model is told why. |
| **Sandbox**     | Paths must be relative, free of `..`, and (symlinks resolved) inside the workspace. `.git` and `.env*` are never listed, read or written.                                                             |
| **Limits**      | Max turns, estimated cost, total tokens, wall-clock for the run, timeout per tool call, cap on tool output size.                                                                                      |
| **Scheduling**  | Read-only calls in one turn run concurrently; writes run one at a time, in order. All results go back in one message.                                                                                 |
| **Errors**      | Invalid arguments, refused or crashing tools become `is_error` results the model can read. Internals are not shown to the model.                                                                      |
| **Tracing**     | One JSONL line per event (run, model response, tool call). Tool inputs are truncated and tool **output is never stored**.                                                                             |
| **Evals**       | `runEval` runs tasks in a fresh workspace and checks what the agent _did_ with code.                                                                                                                  |

## Use it

Needs Node 22.12+ (required by Vitest 5).

```bash
git clone https://github.com/yakim-nick/agent-harness && cd agent-harness
npm install
export ANTHROPIC_API_KEY=sk-ant-...
npm run dev -- run "list the files and summarise the project" --workspace .
```

Options: `--model` (default `claude-opus-5-5`), `--effort low|medium|high|xhigh|max` (default
`high`), `--max-turns`, `--max-cost <usd>`, `--timeout <sec>`, `--trace <file>`, `--yes`
(approve writes), `--no-fallback`. Exit code 0 = completed, 1 = stopped for another reason
(limit, refusal, error), 2 = bad usage.

As a library:

```ts
import { runAgent, AnthropicModelClient, Sandbox, defaultTools } from './src/index.js';

const result = await runAgent('Which file mentions TODO?', {
  model: new AnthropicModelClient(),
  tools: defaultTools,
  sandbox: await Sandbox.create('./project'),
  system: 'You are a careful assistant.',
  limits: { maxTurns: 10, maxCostUsd: 0.25 },
});
console.log(result.status, result.finalText, result.costUsd);
```

Write your own tool with a Zod schema; the JSON Schema is generated from it:

```ts
const lineCount = defineTool({
  name: 'line_count',
  description: 'Count the lines in a workspace file.',
  risk: 'read',
  inputSchema: z.object({ path: z.string() }),
  async run({ path }, { sandbox }) {
    /* resolve via sandbox, never use `path` directly */
  },
});
```

## Design

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Short version: the loop depends on a
`ModelClient` port, so it is tested with a scripted fake model; the real client is a thin streaming
adapter over `@anthropic-ai/sdk`. Defaults follow the current Claude API guidance: adaptive
thinking with an explicit `effort`, no forced `tool_choice`, no sampling parameters, streaming,
top-level prompt caching on a frozen system prompt, and the server-side refusal fallback beta
(turn it off with `--no-fallback`).

## Threat model

- **The model is not trusted with paths.** Every path goes through the sandbox.
- **File contents are untrusted input.** A file the agent reads can contain instructions
  (prompt injection). That is why write tools ask for approval by default. Do not run with
  `--yes` on a workspace you do not trust.
- **The sandbox is a library check, not an OS sandbox.** It does not stop a process from
  doing other things, and there is no shell tool on purpose. If you add one, run it in a
  container or VM and put it behind approval.
- **Secrets:** `.git` and `.env*` are blocked by name only. A secret in another file is readable
  if it is inside the workspace. The API key is read from the environment and never written to a
  trace.

## What is verified, and what is not

**Verified (71 tests, 94.8% statement coverage, run on Node 22):**

- The loop with a scripted model: ordering, parallel vs serial scheduling, permission decisions,
  every stop reason, each limit, aborts, timeouts, tool failures, and the fallback boundary rule.
- The sandbox against traversal, absolute paths, denied names and symlink escapes.
- The real Anthropic adapter against a **local fake of the streaming API**: the request body and
  headers (model, adaptive thinking, effort, caching, fallback beta, tool schemas) and the
  assembly of a streamed tool-use turn, including a full two-request tool loop.
- The CLI as a real process: usage errors, a tool loop, trace output, write refusal without a
  terminal, `--yes`, and the turn limit.

**Not verified:**

- **Nothing here has run against the live Claude API.** There was no API key in the
  environment where this was built. The fake server proves what the code sends and how it parses
  a stream; it cannot prove the live API accepts every parameter (for example the fallback beta).
- **The sample evals** (`src/evals/tasks.ts`) have never been run against a real model, so there
  is no pass rate yet. `npm run eval -- --yes` runs them and costs money.
- **Cost numbers are estimates** from prices copied on 2026-11-03; they will go stale.
- The fallback echo rule is implemented from the API documentation and unit tested, but has not
  been exercised by a real mid-output fallback.

## Known limitations

- No MCP client, sub-agents, context compaction or resumable sessions.
- No shell or network tools; four file tools only.
- Cost limits are checked **before** each model call, so a run can overshoot by one turn.
- `typescript` is pinned to 6.0 because `typescript-eslint` does not support TypeScript 7 yet.
- `npm audit` reports a high advisory for `picomatch` (ReDoS in a glob matcher) in the **dev
  toolchain** (Vite, ESLint); no fixed version exists. The production dependencies audit clean, and
  CI runs `npm audit --omit=dev`.

## Roadmap

- Run the evals against the live API and publish the numbers.
- Load tools from MCP servers (for example the sibling `rust-mcp-server`).
- Context management for long runs (compaction or context editing) and saved sessions.
- A containerised `run_command` tool behind approval.

## License

MIT
