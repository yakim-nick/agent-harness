#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { tasks as sampleTasks } from './evals/tasks.js';
import { runEval, summarise } from './eval.js';
import { runAgent, type RunLimits } from './loop.js';
import { AnthropicModelClient, DEFAULT_MODEL } from './model/anthropic.js';
import type { Effort } from './model/types.js';
import type { Approver } from './permissions.js';
import { SYSTEM_PROMPT } from './prompt.js';
import { Sandbox } from './sandbox.js';
import { JsonlTracer, nullTracer, previewInput } from './trace.js';
import { defaultTools } from './tools/fs.js';

const USAGE = `agent-harness: run a tool-using Claude agent with permissions, limits and tracing

Usage:
  agent-harness run "<task>" [options]
  agent-harness eval [--yes] [options]       run the sample evals against the real model (costs money)

Options:
  --workspace <dir>   directory the agent may work in (default: current directory)
  --model <id>        model id (default: ${DEFAULT_MODEL})
  --effort <level>    low | medium | high | xhigh | max (default: high)
  --max-turns <n>     model turns at most (default: 25)
  --max-cost <usd>    stop when the estimated cost reaches this
  --timeout <sec>     wall-clock limit for the run
  --trace <file>      append a JSONL trace of the run
  --yes               approve write tools without asking
  --no-fallback       turn off server-side refusal fallback
  -h, --help

Needs ANTHROPIC_API_KEY (or another credential the Anthropic SDK understands).
Write tools ask for approval; without a terminal and without --yes they are refused.`;

const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

function fail(message: string): never {
  console.error(`error: ${message}\n\n${USAGE}`);
  process.exit(2);
}

function positive(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) fail(`${name} must be a positive number`);
  return n;
}

/** A malformed command line is a usage error (exit 2 with the usage text), not a crash. */
function parseOrExit<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

async function main(): Promise<number> {
  const { values, positionals } = parseOrExit(() =>
    parseArgs({
      allowPositionals: true,
      options: {
        workspace: { type: 'string', default: '.' },
        model: { type: 'string', default: DEFAULT_MODEL },
        effort: { type: 'string', default: 'high' },
        'max-turns': { type: 'string' },
        'max-cost': { type: 'string' },
        timeout: { type: 'string' },
        trace: { type: 'string' },
        yes: { type: 'boolean', default: false },
        'no-fallback': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }),
  );
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  if (!EFFORTS.includes(values.effort)) fail(`--effort must be one of ${EFFORTS.join(', ')}`);

  const limits: Partial<RunLimits> = {};
  const maxTurns = positive('--max-turns', values['max-turns']);
  const maxCost = positive('--max-cost', values['max-cost']);
  const timeout = positive('--timeout', values.timeout);
  if (maxTurns !== undefined) limits.maxTurns = Math.floor(maxTurns);
  if (maxCost !== undefined) limits.maxCostUsd = maxCost;
  if (timeout !== undefined) limits.timeoutMs = timeout * 1000;

  const model = new AnthropicModelClient({ model: values.model, fallback: !values['no-fallback'] });
  const effort = values.effort as Effort;
  const tracer = values.trace ? new JsonlTracer(values.trace) : nullTracer;

  if (command === 'eval') {
    if (!values.yes) fail('eval calls the real API and costs money: pass --yes to confirm');
    const outcomes = await runEval(sampleTasks, () => ({
      model,
      tools: defaultTools,
      system: SYSTEM_PROMPT,
      effort,
      limits,
      tracer,
      approve: async () => true,
    }));
    console.log(summarise(outcomes));
    return outcomes.every((o) => o.passed) ? 0 : 1;
  }

  if (command !== 'run') fail(`unknown command: ${command}`);
  const task = rest.join(' ').trim();
  if (!task) fail('run needs a task, for example: agent-harness run "list the files"');

  let sandbox: Sandbox;
  try {
    sandbox = await Sandbox.create(values.workspace);
  } catch (error) {
    fail(
      `cannot use workspace ${values.workspace}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const rl =
    process.stdin.isTTY && !values.yes
      ? createInterface({ input: process.stdin, output: process.stderr })
      : undefined;
  const approve: Approver | undefined = values.yes
    ? async () => true
    : rl
      ? async ({ tool, input }) =>
          /^y(es)?$/i.test(
            (await rl.question(`\nAllow ${tool} ${previewInput(input, 200)} ? [y/N] `)).trim(),
          )
      : undefined;

  console.error(`workspace: ${sandbox.root}\nmodel: ${model.model}, effort: ${effort}\n`);
  const result = await runAgent(task, {
    model,
    tools: defaultTools,
    sandbox,
    system: SYSTEM_PROMPT,
    effort,
    limits,
    tracer,
    ...(approve ? { approve } : {}),
    onText: (delta) => process.stdout.write(delta),
  });
  rl?.close();

  process.stdout.write('\n');
  const u = result.usage;
  console.error(
    `\n[${result.status}] ${result.turns} turn(s), ${u.input_tokens} in / ${u.output_tokens} out tokens` +
      (u.cache_read_input_tokens ? ` (${u.cache_read_input_tokens} cached)` : '') +
      (result.costUsd !== undefined ? `, estimated cost $${result.costUsd.toFixed(4)}` : '') +
      (result.error ? `\n${result.error}` : ''),
  );
  return result.status === 'completed' ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
