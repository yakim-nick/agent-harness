/**
 * The agent loop. A model turn either ends the run or asks for tools; the harness runs the
 * tools under a permission policy and resource limits, then feeds the results back.
 *
 * Why a manual loop: the harness owns the control layer (what may run, how many turns and
 * dollars it may spend, what is recorded). Rules it enforces:
 *  - the assistant turn is echoed back as received (thinking blocks included), except for the
 *    fallback boundary rule in `echoableContent`;
 *  - all tool results of one turn go back in ONE user message, in call order;
 *  - a failing or refused tool becomes an `is_error` result (never dropped) so the model adapts;
 *  - stop reasons are handled explicitly (end_turn, tool_use, pause_turn, max_tokens, refusal).
 */
import { estimateCostUsd, hasPrice } from './cost.js';
import type {
  BetaContentBlock,
  BetaMessage,
  BetaMessageParam,
  Effort,
  ModelClient,
} from './model/types.js';
import { DEFAULT_POLICY, decide, type Approver, type Policy } from './permissions.js';
import type { Sandbox } from './sandbox.js';
import { ToolError, type Tool } from './tool.js';
import { nullTracer, previewInput, type Tracer } from './trace.js';

export interface RunLimits {
  /** Model turns (requests) at most. */
  maxTurns: number;
  /** Stop once estimated spend reaches this (checked before each model call). */
  maxCostUsd?: number;
  /** Stop once all billed tokens (input + output + cache) reach this. */
  maxTotalTokens?: number;
  /** Wall-clock limit for the whole run. */
  timeoutMs?: number;
  /** Wall-clock limit for one tool call. */
  toolTimeoutMs: number;
  /** A tool result longer than this is truncated before the model sees it. */
  toolOutputChars: number;
}

export const DEFAULT_LIMITS: RunLimits = {
  maxTurns: 25,
  toolTimeoutMs: 30_000,
  toolOutputChars: 40_000,
};

export interface AgentConfig {
  model: ModelClient;
  tools: Tool[];
  sandbox: Sandbox;
  system: string;
  policy?: Policy;
  approve?: Approver;
  tracer?: Tracer;
  limits?: Partial<RunLimits>;
  effort?: Effort;
  /** `max_tokens` per model response. */
  maxTokens?: number;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
}

export type RunStatus =
  | 'completed'
  | 'max_turns'
  | 'budget_exceeded'
  | 'timeout'
  | 'aborted'
  | 'refused'
  | 'truncated'
  | 'error';

export interface TokenTotals {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface RunResult {
  status: RunStatus;
  finalText: string;
  turns: number;
  usage: TokenTotals;
  /** Estimated; undefined when the model's price is unknown. */
  costUsd?: number;
  messages: BetaMessageParam[];
  error?: string;
}

export async function runAgent(task: string, config: AgentConfig): Promise<RunResult> {
  const limits: RunLimits = { ...DEFAULT_LIMITS, ...config.limits };
  const policy = config.policy ?? DEFAULT_POLICY;
  const tracer = config.tracer ?? nullTracer;
  const modelName = config.model.model;
  if (limits.maxCostUsd !== undefined && !hasPrice(modelName)) {
    throw new Error(`cannot enforce a cost limit: no price known for ${modelName}`);
  }
  const tools = new Map(config.tools.map((tool) => [tool.name, tool]));

  const controller = new AbortController();
  const onExternalAbort = () => controller.abort(config.signal?.reason);
  config.signal?.addEventListener('abort', onExternalAbort, { once: true });
  const timer =
    limits.timeoutMs !== undefined
      ? setTimeout(() => controller.abort(new Error('run timed out')), limits.timeoutMs)
      : undefined;
  if (config.signal?.aborted) onExternalAbort();

  const messages: BetaMessageParam[] = [{ role: 'user', content: task }];
  const usage: TokenTotals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  let costUsd: number | undefined = 0;
  let turns = 0;
  let finalText = '';

  tracer.emit({
    type: 'run_start',
    model: modelName,
    task: previewInput(task, 500),
    limits: { ...limits },
  });

  const finish = (status: RunStatus, error?: string): RunResult => {
    if (timer) clearTimeout(timer);
    config.signal?.removeEventListener('abort', onExternalAbort);
    tracer.emit({
      type: 'run_end',
      status,
      turns,
      usage: { ...usage },
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(error ? { message: error } : {}),
    });
    return {
      status,
      finalText,
      turns,
      usage,
      ...(costUsd !== undefined ? { costUsd } : {}),
      messages,
      ...(error ? { error } : {}),
    };
  };
  const abortStatus = (): RunStatus => (config.signal?.aborted ? 'aborted' : 'timeout');

  for (;;) {
    if (controller.signal.aborted) return finish(abortStatus());
    if (turns >= limits.maxTurns) return finish('max_turns', `stopped after ${turns} turns`);
    const overBudget = budgetExceeded(limits, usage, costUsd);
    if (overBudget) return finish('budget_exceeded', overBudget);

    turns += 1;
    const started = Date.now();
    let response: BetaMessage;
    try {
      response = await config.model.create({
        system: config.system,
        messages,
        tools: config.tools.map((tool) => tool.spec),
        maxTokens: config.maxTokens ?? 16_000,
        effort: config.effort ?? 'high',
        signal: controller.signal,
        ...(config.onText ? { onText: config.onText } : {}),
      });
    } catch (error) {
      if (controller.signal.aborted) return finish(abortStatus());
      return finish('error', errorMessage(error));
    }

    addUsage(usage, response.usage);
    const turnCost = estimateCostUsd(modelName, response.usage);
    costUsd = turnCost === undefined || costUsd === undefined ? undefined : costUsd + turnCost;
    tracer.emit({
      type: 'model_response',
      turn: turns,
      stopReason: response.stop_reason,
      latencyMs: Date.now() - started,
      usage: { ...numericUsage(response.usage) },
      ...(turnCost !== undefined ? { costUsd: turnCost } : {}),
    });

    const content = echoableContent(response.content);
    messages.push({ role: 'assistant', content });
    finalText = textOf(content);

    switch (response.stop_reason) {
      case 'end_turn':
      case 'stop_sequence':
        return finish('completed');
      case 'refusal':
        return finish('refused', refusalMessage(response));
      case 'max_tokens':
        // A tool call cut off at the limit would run on truncated input; never run it.
        return finish('truncated', 'the model hit max_tokens before finishing the turn');
      case 'pause_turn':
        continue; // a server-side step paused; resend the turn unchanged so it continues
      case 'tool_use':
        break;
      default:
        return finish('completed');
    }

    const calls = content.filter((block) => block.type === 'tool_use');
    if (calls.length === 0) return finish('completed');
    const results = await runToolCalls(calls, {
      tools,
      config,
      policy,
      limits,
      tracer,
      turn: turns,
      signal: controller.signal,
    });
    messages.push({ role: 'user', content: results });
  }
}

type ToolUseBlock = Extract<BetaContentBlock, { type: 'tool_use' }>;
type ToolResultParam = {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

interface ToolRunContext {
  tools: Map<string, Tool>;
  config: AgentConfig;
  policy: Policy;
  limits: RunLimits;
  tracer: Tracer;
  turn: number;
  signal: AbortSignal;
}

/**
 * Run one turn's tool calls and return their results in call order.
 * Consecutive parallel-safe (read-only) calls run concurrently; anything else runs alone,
 * in order. Permission questions are asked one at a time before a concurrent batch starts.
 */
async function runToolCalls(
  calls: ToolUseBlock[],
  ctx: ToolRunContext,
): Promise<ToolResultParam[]> {
  const results: ToolResultParam[] = [];
  let i = 0;
  while (i < calls.length) {
    const first = calls[i] as ToolUseBlock;
    if (ctx.tools.get(first.name)?.parallelSafe) {
      const batch: ToolUseBlock[] = [];
      while (i < calls.length && ctx.tools.get((calls[i] as ToolUseBlock).name)?.parallelSafe) {
        batch.push(calls[i] as ToolUseBlock);
        i += 1;
      }
      const decisions: Authorisation[] = [];
      for (const call of batch) decisions.push(await authorise(call, ctx));
      results.push(
        ...(await Promise.all(batch.map((call, n) => execute(call, decisions[n]!, ctx)))),
      );
    } else {
      results.push(await execute(first, await authorise(first, ctx), ctx));
      i += 1;
    }
  }
  return results;
}

interface Authorisation {
  allowed: boolean;
  reason: string;
}

async function authorise(call: ToolUseBlock, ctx: ToolRunContext): Promise<Authorisation> {
  const tool = ctx.tools.get(call.name);
  if (!tool) return { allowed: false, reason: `unknown tool: ${call.name}` };
  return decide(tool, call.input, ctx.policy, ctx.config.approve);
}

async function execute(
  call: ToolUseBlock,
  decision: Authorisation,
  ctx: ToolRunContext,
): Promise<ToolResultParam> {
  const started = Date.now();
  const tool = ctx.tools.get(call.name);
  let text: string;
  let isError = false;
  let detail: string | undefined;

  if (!tool || !decision.allowed) {
    text = decision.reason;
    isError = true;
  } else {
    try {
      text = await withTimeout(
        tool.execute(call.input, { sandbox: ctx.config.sandbox, signal: ctx.signal }),
        ctx.limits.toolTimeoutMs,
        call.name,
      );
    } catch (error) {
      isError = true;
      if (error instanceof ToolError) {
        text = error.message;
      } else {
        // Unexpected failure: do not leak internals to the model; keep the detail in the trace.
        text = `the ${call.name} tool failed unexpectedly`;
        detail = errorMessage(error);
      }
    }
  }

  const output = truncate(text, ctx.limits.toolOutputChars);
  ctx.tracer.emit({
    type: 'tool_call',
    turn: ctx.turn,
    tool: call.name,
    input: previewInput(call.input),
    decision: decision.reason,
    allowed: decision.allowed,
    durationMs: Date.now() - started,
    isError,
    resultChars: text.length,
    ...(detail ? { error: detail } : {}),
  });
  return {
    type: 'tool_result',
    tool_use_id: call.id,
    content: output,
    ...(isError ? { is_error: true } : {}),
  };
}

/**
 * What to send back as the assistant turn. After a mid-output refusal fallback the API
 * requires dropping `thinking`, `redacted_thinking` and `tool_use` blocks that appear BEFORE
 * the last `fallback` block. Every `fallback` block stays where it appeared. Dropped tool calls
 * are never executed. Text before the boundary and everything after it is kept.
 */
export function echoableContent(blocks: BetaContentBlock[]): BetaContentBlock[] {
  let boundary = -1;
  blocks.forEach((block, index) => {
    if (block.type === 'fallback') boundary = index;
  });
  if (boundary < 0) return blocks;
  return blocks.filter(
    (block, index) => index >= boundary || block.type === 'text' || block.type === 'fallback',
  );
}

function textOf(blocks: BetaContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<BetaContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

function refusalMessage(response: BetaMessage): string {
  const details = response.stop_details;
  if (details && 'category' in details && details.category) {
    return `the model declined this request (category: ${String(details.category)})`;
  }
  return 'the model declined this request';
}

function budgetExceeded(
  limits: RunLimits,
  usage: TokenTotals,
  costUsd: number | undefined,
): string | undefined {
  if (limits.maxCostUsd !== undefined && costUsd !== undefined && costUsd >= limits.maxCostUsd) {
    return `estimated cost $${costUsd.toFixed(4)} reached the limit of $${limits.maxCostUsd}`;
  }
  const total =
    usage.input_tokens +
    usage.output_tokens +
    usage.cache_creation_input_tokens +
    usage.cache_read_input_tokens;
  if (limits.maxTotalTokens !== undefined && total >= limits.maxTotalTokens) {
    return `${total} tokens reached the limit of ${limits.maxTotalTokens}`;
  }
  return undefined;
}

function addUsage(totals: TokenTotals, usage: BetaMessage['usage']): void {
  totals.input_tokens += usage.input_tokens;
  totals.output_tokens += usage.output_tokens;
  totals.cache_creation_input_tokens += usage.cache_creation_input_tokens ?? 0;
  totals.cache_read_input_tokens += usage.cache_read_input_tokens ?? 0;
}

function numericUsage(usage: BetaMessage['usage']): Record<string, number> {
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
  };
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[output truncated: ${text.length - max} more characters]`;
}

/** Reject if the tool does not finish in time. The tool also gets an abort signal to stop early. */
async function withTimeout<T>(work: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ToolError(`${name} timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
