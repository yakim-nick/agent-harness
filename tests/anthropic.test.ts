/**
 * The real adapter against a local fake of the Messages API (server-sent events). This proves
 * what we SEND (headers, body, tool schemas) and that the stream is assembled into a message
 * the loop understands. It does not prove the live API accepts the request: that needs a key.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { runAgent } from '../src/loop.js';
import { AnthropicModelClient } from '../src/model/anthropic.js';
import { defaultTools } from '../src/tools/fs.js';
import { startFakeApi, streamOf, type Captured } from './fake-api.js';
import { workspace } from './helpers.js';

let server: Server | undefined;
afterEach(
  () => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())),
);

async function fakeApi(responses: string[]): Promise<{ client: Anthropic; captured: Captured[] }> {
  const api = await startFakeApi(responses);
  server = api.server;
  return {
    client: new Anthropic({ apiKey: 'test-key', baseURL: api.baseURL, maxRetries: 0 }),
    captured: api.captured,
  };
}

const toolTurn = streamOf(
  [
    { block: { type: 'text', text: '' }, delta: { type: 'text_delta', text: 'Let me look.' } },
    {
      block: { type: 'tool_use', id: 'toolu_1', name: 'list_files', input: {} },
      delta: { type: 'input_json_delta', partial_json: '{"path":"."}' },
    },
  ],
  'tool_use',
);
const finalTurn = streamOf(
  [
    {
      block: { type: 'text', text: '' },
      delta: { type: 'text_delta', text: 'There is one file.' },
    },
  ],
  'end_turn',
);

describe('AnthropicModelClient', () => {
  it('sends the expected request: model, adaptive thinking, effort, caching, fallback beta and tool schemas', async () => {
    const { client, captured } = await fakeApi([finalTurn]);
    const model = new AnthropicModelClient({ client });
    const deltas: string[] = [];
    const message = await model.create({
      system: 'You are careful.',
      messages: [{ role: 'user', content: 'hi' }],
      tools: defaultTools.map((t) => t.spec),
      maxTokens: 777,
      effort: 'medium',
      onText: (d) => deltas.push(d),
    });

    const [request] = captured;
    expect(request!.url).toContain('/v1/messages');
    expect(String(request!.headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01');
    expect(request!.headers['authorization']).toBe('Bearer test-key');
    expect(request!.headers['anthropic-version']).toBe('2026-10-21');
    expect(request!.body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 777,
      stream: true,
      system: 'You are careful.',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      cache_control: { type: 'ephemeral' },
      fallbacks: 'default',
    });
    const tools = request!.body['tools'] as Array<{
      name: string;
      input_schema: Record<string, unknown>;
    }>;
    expect(tools.map((t) => t.name)).toEqual([
      'list_files',
      'read_file',
      'search_text',
      'write_file',
    ]);
    for (const tool of tools) {
      expect(tool.input_schema['type']).toBe('object');
      expect(tool.input_schema).not.toHaveProperty('$schema');
    }
    // No forced tool use and no sampling parameters: both are rejected by this model.
    expect(request!.body).not.toHaveProperty('tool_choice');
    expect(request!.body).not.toHaveProperty('temperature');

    expect(message.stop_reason).toBe('end_turn');
    expect(message.content).toEqual([
      expect.objectContaining({ type: 'text', text: 'There is one file.' }),
    ]);
    expect(deltas.join('')).toBe('There is one file.');
  });

  it('can turn fallback and caching off', async () => {
    const { client, captured } = await fakeApi([finalTurn]);
    const model = new AnthropicModelClient({ client, fallback: false, cache: false });
    await model.create({
      system: '',
      messages: [{ role: 'user', content: 'x' }],
      tools: [],
      maxTokens: 10,
      effort: 'low',
    });
    expect(captured[0]!.body).not.toHaveProperty('fallbacks');
    expect(captured[0]!.body).not.toHaveProperty('cache_control');
    expect(String(captured[0]!.headers['anthropic-beta'] ?? '')).not.toContain(
      'server-side-fallback',
    );
  });

  it('drives a full tool loop: the second request carries the echoed assistant turn and the tool result', async () => {
    const { client, captured } = await fakeApi([toolTurn, finalTurn]);
    const { sandbox } = await workspace({ 'notes.txt': 'hello' });
    const result = await runAgent('what files are here?', {
      model: new AnthropicModelClient({ client }),
      tools: defaultTools,
      sandbox,
      system: 'sys',
    });

    expect(result.status).toBe('completed');
    expect(result.finalText).toBe('There is one file.');
    expect(result.turns).toBe(2);
    expect(result.usage.input_tokens).toBe(240);

    const second = captured[1]!.body['messages'] as Array<{ role: string; content: unknown }>;
    expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const assistant = second[1]!.content as Array<Record<string, unknown>>;
    expect(assistant.map((b) => b['type'])).toEqual(['text', 'tool_use']);
    expect(assistant[1]).toMatchObject({ id: 'toolu_1', name: 'list_files', input: { path: '.' } });
    const results = second[2]!.content as Array<Record<string, unknown>>;
    expect(results[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' });
    expect(String(results[0]!['content'])).toContain('notes.txt (5 bytes)');
  });

  it('turns an API error into status "error" instead of crashing the run', async () => {
    server = createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'invalid x-api-key' },
        }),
      );
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const client = new Anthropic({
      apiKey: 'bad',
      baseURL: `http://127.0.0.1:${port}`,
      maxRetries: 0,
    });
    const { sandbox } = await workspace();
    const result = await runAgent('x', {
      model: new AnthropicModelClient({ client }),
      tools: [],
      sandbox,
      system: '',
    });
    expect(result.status).toBe('error');
    expect(result.error).toContain('invalid x-api-key');
  });
});
