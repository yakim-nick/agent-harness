import { readFile as readFromDisk } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { echoableContent, runAgent, type AgentConfig } from '../src/loop.js';
import { MemoryTracer } from '../src/trace.js';
import { ToolError, defineTool } from '../src/tool.js';
import { defaultTools } from '../src/tools/fs.js';
import { z } from 'zod';
import {
  ScriptedModel,
  blocksOf,
  callTools,
  endTurn,
  fallbackBlock,
  reply,
  text,
  thinking,
  toolUse,
  workspace,
} from './helpers.js';

async function setup(
  script: ConstructorParameters<typeof ScriptedModel>[0],
  overrides: Partial<AgentConfig> = {},
  files: Record<string, string> = {},
) {
  const { sandbox, dir } = await workspace(files);
  const model = new ScriptedModel(script);
  const tracer = new MemoryTracer();
  const config: AgentConfig = {
    model,
    tools: defaultTools,
    sandbox,
    system: 'sys',
    tracer,
    ...overrides,
  };
  return { model, tracer, config, dir };
}

describe('runAgent: the basic loop', () => {
  it('completes when the model ends its turn, and reports text, usage and estimated cost', async () => {
    const { config } = await setup([
      endTurn('All done.', { input_tokens: 1000, output_tokens: 500 }),
    ]);
    const result = await runAgent('say hi', config);
    expect(result.status).toBe('completed');
    expect(result.finalText).toBe('All done.');
    expect(result.turns).toBe(1);
    expect(result.usage.input_tokens).toBe(1000);
    // 1000 * $4/M + 500 * $20/M = $0.014
    expect(result.costUsd).toBeCloseTo(0.014, 6);
  });

  it('runs a tool, returns ONE user message with the results, and finishes', async () => {
    const { config, model } = await setup(
      [
        callTools(toolUse('t1', 'read_file', { path: 'a.txt' }), toolUse('t2', 'list_files', {})),
        endTurn('read it'),
      ],
      {},
      { 'a.txt': 'hello' },
    );
    const result = await runAgent('look around', config);
    expect(result.status).toBe('completed');

    const second = model.requests[1]!.messages;
    expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const results = blocksOf(second[2]!) as Array<{
      type: string;
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    }>;
    expect(results.map((r) => [r.type, r.tool_use_id])).toEqual([
      ['tool_result', 't1'],
      ['tool_result', 't2'],
    ]);
    expect(results[0]!.content).toBe('hello');
    expect(results[1]!.content).toContain('a.txt (5 bytes)');
    expect(results.some((r) => r.is_error)).toBe(false);
  });

  it('echoes the assistant turn unchanged, thinking blocks included', async () => {
    const turn = reply({
      content: [thinking('hmm'), text('x'), toolUse('t1', 'list_files', {})],
      stop_reason: 'tool_use',
    });
    const { config, model } = await setup([turn, endTurn('ok')]);
    await runAgent('go', config);
    const assistant = model.requests[1]!.messages[1]!;
    expect(blocksOf(assistant).map((b) => b.type)).toEqual(['thinking', 'text', 'tool_use']);
  });

  it('passes the tool specs, system prompt and effort to the model', async () => {
    const { config, model } = await setup([endTurn('ok')], { effort: 'low', maxTokens: 999 });
    await runAgent('go', config);
    const request = model.requests[0]!;
    expect(request.system).toBe('sys');
    expect(request.effort).toBe('low');
    expect(request.maxTokens).toBe(999);
    expect(request.tools.map((t) => t.name)).toEqual([
      'list_files',
      'read_file',
      'search_text',
      'write_file',
    ]);
  });
});

describe('runAgent: tool scheduling', () => {
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  function timedTool(name: string, risk: 'read' | 'write', ms: number, log: string[]) {
    return defineTool({
      name,
      description: name,
      risk,
      inputSchema: z.object({}),
      async run() {
        log.push(`${name}:start`);
        await delay(ms);
        log.push(`${name}:end`);
        return name;
      },
    });
  }

  it('runs consecutive read-only calls concurrently but keeps results in call order', async () => {
    const log: string[] = [];
    const tools = [timedTool('slow', 'read', 60, log), timedTool('fast', 'read', 5, log)];
    const { config, model } = await setup(
      [callTools(toolUse('a', 'slow', {}), toolUse('b', 'fast', {})), endTurn('ok')],
      { tools },
    );
    await runAgent('go', config);
    expect(log).toEqual(['slow:start', 'fast:start', 'fast:end', 'slow:end']); // overlapped
    const results = blocksOf(model.requests[1]!.messages[2]!) as Array<{ tool_use_id: string }>;
    expect(results.map((r) => r.tool_use_id)).toEqual(['a', 'b']);
  });

  it('runs write tools one at a time, in order, and never overlapped with reads', async () => {
    const log: string[] = [];
    const tools = [
      timedTool('w1', 'write', 20, log),
      timedTool('w2', 'write', 5, log),
      timedTool('r', 'read', 5, log),
    ];
    const policy = { byRisk: { read: 'allow', write: 'allow' } } as const;
    const { config } = await setup(
      [
        callTools(toolUse('1', 'w1', {}), toolUse('2', 'w2', {}), toolUse('3', 'r', {})),
        endTurn('ok'),
      ],
      { tools, policy },
    );
    await runAgent('go', config);
    expect(log).toEqual(['w1:start', 'w1:end', 'w2:start', 'w2:end', 'r:start', 'r:end']);
  });
});

describe('runAgent: permissions', () => {
  it('refuses a write without an approver, tells the model why, and does not write', async () => {
    const { config, model, dir } = await setup([
      callTools(toolUse('w', 'write_file', { path: 'out.txt', content: 'x' })),
      endTurn('could not write'),
    ]);
    const result = await runAgent('write', config);
    expect(result.status).toBe('completed');
    const [r] = blocksOf(model.requests[1]!.messages[2]!) as Array<{
      is_error?: boolean;
      content: string;
    }>;
    expect(r!.is_error).toBe(true);
    expect(r!.content).toContain('needs approval');
    await expect(readFromDisk(path.join(dir, 'out.txt'))).rejects.toThrow();
  });

  it('writes when the approver says yes, and not when it says no', async () => {
    const approve = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const { config, dir } = await setup(
      [
        callTools(
          toolUse('a', 'write_file', { path: 'yes.txt', content: 'ok' }),
          toolUse('b', 'write_file', { path: 'no.txt', content: 'no' }),
        ),
        endTurn('done'),
      ],
      { approve },
    );
    await runAgent('write', config);
    expect(await readFromDisk(path.join(dir, 'yes.txt'), 'utf8')).toBe('ok');
    await expect(readFromDisk(path.join(dir, 'no.txt'))).rejects.toThrow();
    expect(approve).toHaveBeenCalledTimes(2);
  });

  it('a policy that forbids a tool blocks it even when an approver would say yes', async () => {
    const approve = vi.fn().mockResolvedValue(true);
    const policy = {
      byRisk: { read: 'allow', write: 'ask' },
      byTool: { write_file: 'deny' },
    } as const;
    const { config, model } = await setup(
      [callTools(toolUse('w', 'write_file', { path: 'x', content: 'x' })), endTurn('ok')],
      { approve, policy },
    );
    await runAgent('go', config);
    expect(approve).not.toHaveBeenCalled();
    const [r] = blocksOf(model.requests[1]!.messages[2]!) as Array<{ content: string }>;
    expect(r!.content).toContain('forbids');
  });
});

describe('runAgent: tool failures become results, never crashes', () => {
  async function firstResult(
    call: ReturnType<typeof toolUse>,
    overrides: Partial<AgentConfig> = {},
    files: Record<string, string> = {},
  ) {
    const { config, model, tracer } = await setup(
      [callTools(call), endTurn('ok')],
      overrides,
      files,
    );
    const result = await runAgent('go', config);
    const [r] = blocksOf(model.requests[1]!.messages[2]!) as Array<{
      content: string;
      is_error?: boolean;
    }>;
    return { result, r: r!, tracer };
  }

  it('unknown tool', async () => {
    const { r } = await firstResult(toolUse('x', 'rm_rf', {}));
    expect(r).toMatchObject({ is_error: true, content: 'unknown tool: rm_rf' });
  });

  it('invalid arguments are explained to the model (Zod issues)', async () => {
    const { r } = await firstResult(toolUse('x', 'read_file', { path: 42 }));
    expect(r.is_error).toBe(true);
    expect(r.content).toContain('invalid arguments: path');
  });

  it('a sandbox violation is a readable error and leaks no absolute path', async () => {
    const { r } = await firstResult(toolUse('x', 'read_file', { path: '../../etc/passwd' }));
    expect(r.is_error).toBe(true);
    expect(r.content).toContain("must not contain '..'");
    expect(r.content).not.toContain('/home');
  });

  it('an unexpected exception is hidden from the model but kept in the trace', async () => {
    const boom = defineTool({
      name: 'boom',
      description: 'always fails',
      risk: 'read',
      inputSchema: z.object({}),
      async run() {
        throw new Error('database password is hunter2');
      },
    });
    const { r, tracer } = await firstResult(toolUse('x', 'boom', {}), { tools: [boom] });
    expect(r).toMatchObject({ is_error: true, content: 'the boom tool failed unexpectedly' });
    const call = tracer.events.find((e) => e.type === 'tool_call');
    expect(call).toMatchObject({ error: 'database password is hunter2', isError: true });
  });

  it('a slow tool times out with a ToolError result', async () => {
    const slow = defineTool({
      name: 'slow',
      description: 'never finishes',
      risk: 'read',
      inputSchema: z.object({}),
      run: () => new Promise<string>(() => {}),
    });
    const { r } = await firstResult(toolUse('x', 'slow', {}), {
      tools: [slow],
      limits: { toolTimeoutMs: 30 },
    });
    expect(r).toMatchObject({ is_error: true, content: 'slow timed out after 30 ms' });
  });

  it('long output is truncated before the model sees it', async () => {
    const { r } = await firstResult(
      toolUse('x', 'read_file', { path: 'big.txt' }),
      { limits: { toolOutputChars: 100 } },
      { 'big.txt': 'x'.repeat(5000) },
    );
    expect(r.content.length).toBeLessThan(250);
    expect(r.content).toContain('[output truncated');
  });

  it('ToolError messages are passed through as written', async () => {
    const picky = defineTool({
      name: 'picky',
      description: 'x',
      risk: 'read',
      inputSchema: z.object({}),
      async run() {
        throw new ToolError('file is locked');
      },
    });
    const { r } = await firstResult(toolUse('x', 'picky', {}), { tools: [picky] });
    expect(r.content).toBe('file is locked');
  });
});

describe('runAgent: limits and stop reasons', () => {
  const loopForever = () =>
    Array.from({ length: 10 }, () => callTools(toolUse('t', 'list_files', {})));

  it('stops at max turns', async () => {
    const { config } = await setup(loopForever(), { limits: { maxTurns: 3 } });
    const result = await runAgent('go', config);
    expect(result).toMatchObject({ status: 'max_turns', turns: 3 });
  });

  it('stops when the estimated cost reaches the limit (checked before the next call)', async () => {
    const turns = Array.from({ length: 5 }, () =>
      reply({
        content: [toolUse('t', 'list_files', {})],
        stop_reason: 'tool_use',
        usage: { input_tokens: 100_000, output_tokens: 0 },
      }),
    );
    const { config, model } = await setup(turns, { limits: { maxCostUsd: 0.5 } }); // each turn costs $0.40
    const result = await runAgent('go', config);
    expect(result.status).toBe('budget_exceeded');
    expect(result.turns).toBe(2);
    expect(model.requests).toHaveLength(2);
    expect(result.error).toContain('limit of $0.5');
  });

  it('stops on a total token budget', async () => {
    const { config } = await setup(loopForever(), { limits: { maxTotalTokens: 250 } });
    const result = await runAgent('go', config);
    expect(result.status).toBe('budget_exceeded');
    expect(result.turns).toBe(2); // 150 per turn: 150 < 250, 300 >= 250
  });

  it('refuses to start with a cost limit for a model whose price is unknown', async () => {
    const { sandbox } = await workspace();
    const model = new ScriptedModel([endTurn('x')], 'some-future-model');
    await expect(
      runAgent('go', { model, tools: [], sandbox, system: '', limits: { maxCostUsd: 1 } }),
    ).rejects.toThrow('no price known');
  });

  it('reports a refusal and does not run tools from it', async () => {
    const refused = reply({
      content: [text('no'), toolUse('t', 'write_file', { path: 'x', content: 'y' })],
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'cyber' },
    });
    const { config, dir } = await setup([refused], { approve: async () => true });
    const result = await runAgent('go', config);
    expect(result.status).toBe('refused');
    expect(result.error).toContain('cyber');
    await expect(readFromDisk(path.join(dir, 'x'))).rejects.toThrow();
  });

  it('never runs a tool call cut off by max_tokens', async () => {
    const cut = reply({
      content: [toolUse('t', 'write_file', { path: 'x', content: 'partial' })],
      stop_reason: 'max_tokens',
    });
    const { config, dir } = await setup([cut], { approve: async () => true });
    const result = await runAgent('go', config);
    expect(result.status).toBe('truncated');
    await expect(readFromDisk(path.join(dir, 'x'))).rejects.toThrow();
  });

  it('resumes after pause_turn by re-sending the same turn', async () => {
    const paused = reply({ content: [text('thinking about it')], stop_reason: 'pause_turn' });
    const { config, model } = await setup([paused, endTurn('finished')]);
    const result = await runAgent('go', config);
    expect(result.status).toBe('completed');
    expect(model.requests[1]!.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('turns a model error into status "error" without throwing', async () => {
    const { config } = await setup([new Error('503 overloaded')]);
    const result = await runAgent('go', config);
    expect(result).toMatchObject({ status: 'error', error: '503 overloaded' });
  });

  it('stops promptly when aborted from outside', async () => {
    const controller = new AbortController();
    const { config } = await setup([
      (request) =>
        new Promise((_, reject) => {
          // The run is cancelled while the model call is in flight.
          queueMicrotask(() => controller.abort(new Error('user pressed ctrl-c')));
          request.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    ]);
    const result = await runAgent('go', { ...config, signal: controller.signal });
    expect(result.status).toBe('aborted');
  });

  it('enforces a wall-clock limit for the whole run', async () => {
    const { config } = await setup(
      [
        (request) =>
          new Promise((_, reject) =>
            request.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
          ),
      ],
      { limits: { timeoutMs: 40 } },
    );
    const result = await runAgent('go', config);
    expect(result.status).toBe('timeout');
  });
});

describe('echoableContent (refusal fallback boundary)', () => {
  const types = (blocks: unknown[]) => echoableContent(blocks as never).map((b) => b.type);

  it('returns the content unchanged when there is no fallback block', () => {
    const blocks = [thinking('a'), text('b'), toolUse('t', 'x', {})];
    expect(types(blocks)).toEqual(['thinking', 'text', 'tool_use']);
  });

  it('drops thinking and tool_use before the last fallback block but keeps its text and the marker', () => {
    const blocks = [
      thinking('a'),
      text('partial'),
      toolUse('old', 'x', {}),
      fallbackBlock(),
      thinking('b'),
      toolUse('new', 'y', {}),
    ];
    expect(types(blocks)).toEqual(['text', 'fallback', 'thinking', 'tool_use']);
  });

  it('a fallback block first in the turn (declined before any output) changes nothing', () => {
    expect(types([fallbackBlock(), thinking('a'), text('b')])).toEqual([
      'fallback',
      'thinking',
      'text',
    ]);
  });

  it('uses the LAST fallback block when the chain fell back more than once', () => {
    const blocks = [
      thinking('a'),
      fallbackBlock(),
      thinking('b'),
      toolUse('t', 'x', {}),
      fallbackBlock(),
      text('c'),
    ];
    expect(types(blocks)).toEqual(['fallback', 'fallback', 'text']);
  });

  it('does not run tools that were dropped at the boundary', async () => {
    const turn = reply({
      content: [
        toolUse('old', 'write_file', { path: 'old.txt', content: 'x' }),
        fallbackBlock(),
        toolUse('new', 'write_file', { path: 'new.txt', content: 'y' }),
      ],
      stop_reason: 'tool_use',
    });
    const { config, model, dir } = await setup([turn, endTurn('ok')], {
      approve: async () => true,
    });
    await runAgent('go', config);
    await expect(readFromDisk(path.join(dir, 'old.txt'))).rejects.toThrow();
    expect(await readFromDisk(path.join(dir, 'new.txt'), 'utf8')).toBe('y');
    const results = blocksOf(model.requests[1]!.messages[2]!) as Array<{ tool_use_id: string }>;
    expect(results.map((r) => r.tool_use_id)).toEqual(['new']);
    expect(blocksOf(model.requests[1]!.messages[1]!).map((b) => b.type)).toEqual([
      'fallback',
      'tool_use',
    ]);
  });
});

describe('tracing', () => {
  it('records the run, each model response and each tool call, without storing tool output', async () => {
    const { config, tracer } = await setup(
      [callTools(toolUse('t', 'read_file', { path: 'secret-looking.txt' })), endTurn('ok')],
      {},
      { 'secret-looking.txt': 'SUPER-SECRET-CONTENT' },
    );
    await runAgent('read it', config);
    expect(tracer.events.map((e) => e.type)).toEqual([
      'run_start',
      'model_response',
      'tool_call',
      'model_response',
      'run_end',
    ]);
    const serialised = JSON.stringify(tracer.events);
    expect(serialised).not.toContain('SUPER-SECRET-CONTENT');
    expect(tracer.events.find((e) => e.type === 'tool_call')).toMatchObject({
      tool: 'read_file',
      allowed: true,
      isError: false,
      resultChars: 20,
    });
    expect(tracer.events.at(-1)).toMatchObject({ type: 'run_end', status: 'completed', turns: 2 });
  });
});
