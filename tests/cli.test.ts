/** The CLI as a real child process, talking to the fake Messages API. */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startFakeApi, streamOf } from './fake-api.js';
import { workspace } from './helpers.js';

const root = path.resolve(import.meta.dirname, '..');
let closeServer: (() => void) | undefined;
afterEach(() => closeServer?.());

function cli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: root,
      env: { ...process.env, ANTHROPIC_API_KEY: 'test-key', ...env },
      stdio: ['ignore', 'pipe', 'pipe'], // stdin is not a terminal: nobody can answer approval prompts
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const textTurn = (text: string) =>
  streamOf(
    [{ block: { type: 'text', text: '' }, delta: { type: 'text_delta', text } }],
    'end_turn',
  );
const toolTurn = (name: string, input: unknown) =>
  streamOf(
    [
      {
        block: { type: 'tool_use', id: 'toolu_1', name, input: {} },
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
      },
    ],
    'tool_use',
  );

describe('cli usage errors (no network)', () => {
  it('prints help and exits 0, or exits 2 with no command', async () => {
    expect((await cli(['--help'])).code).toBe(0);
    const none = await cli([]);
    expect(none.code).toBe(2);
    expect(none.stdout).toContain('Usage:');
  });

  it('rejects bad arguments with exit code 2 and a message', async () => {
    expect((await cli(['run'])).stderr).toContain('run needs a task');
    expect((await cli(['run', 'x', '--effort', 'turbo'])).stderr).toContain(
      '--effort must be one of',
    );
    expect((await cli(['run', 'x', '--max-cost=-3'])).stderr).toContain(
      '--max-cost must be a positive number',
    );
    // The parser reads a separate "-3" as an option: still a usage error, not a crash.
    const malformed = await cli(['run', 'x', '--max-cost', '-3']);
    expect(malformed.code).toBe(2);
    expect(malformed.stderr).toContain('Usage:');
    expect((await cli(['run', 'x', '--bogus'])).code).toBe(2);
    expect((await cli(['run', 'x', '--workspace', '/definitely/not/here'])).stderr).toContain(
      'cannot use workspace',
    );
    expect((await cli(['frobnicate'])).stderr).toContain('unknown command');
    const evalNoYes = await cli(['eval']);
    expect(evalNoYes.code).toBe(2);
    expect(evalNoYes.stderr).toContain('costs money');
  });
});

describe('cli against the fake API', () => {
  it('runs a tool loop, streams the answer, writes a trace and exits 0', async () => {
    const { server, baseURL, captured } = await startFakeApi([
      toolTurn('read_file', { path: 'a.txt' }),
      textTurn('It says hello.'),
    ]);
    closeServer = () => server.close();
    const { dir } = await workspace({ 'a.txt': 'hello' });
    const trace = path.join(dir, '..', `trace-${Date.now()}.jsonl`);

    const run = await cli(['run', 'what does a.txt say?', '--workspace', dir, '--trace', trace], {
      ANTHROPIC_BASE_URL: baseURL,
    });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('It says hello.');
    expect(run.stderr).toContain('[completed] 2 turn(s)');
    expect(captured).toHaveLength(2);

    const events = (await readFile(trace, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; tool?: string });
    expect(events.map((e) => e.type)).toEqual([
      'run_start',
      'model_response',
      'tool_call',
      'model_response',
      'run_end',
    ]);
    expect(events[2]).toMatchObject({ tool: 'read_file' });
  });

  it('refuses write tools without a terminal and without --yes, so nothing is written', async () => {
    const { server, baseURL, captured } = await startFakeApi([
      toolTurn('write_file', { path: 'out.txt', content: 'x' }),
      textTurn('I could not write it.'),
    ]);
    closeServer = () => server.close();
    const { dir } = await workspace();
    const run = await cli(['run', 'write a file', '--workspace', dir], {
      ANTHROPIC_BASE_URL: baseURL,
    });
    expect(run.code).toBe(0);
    await expect(readFile(path.join(dir, 'out.txt'))).rejects.toThrow();
    const results = (
      captured[1]!.body['messages'] as Array<{
        content: Array<{ content?: string; is_error?: boolean }>;
      }>
    )[2]!.content;
    expect(results[0]).toMatchObject({ is_error: true });
    expect(results[0]!.content).toContain('needs approval');
  });

  it('writes with --yes', async () => {
    const { server, baseURL } = await startFakeApi([
      toolTurn('write_file', { path: 'out.txt', content: 'hello' }),
      textTurn('Done.'),
    ]);
    closeServer = () => server.close();
    const { dir } = await workspace();
    const run = await cli(['run', 'write a file', '--workspace', dir, '--yes'], {
      ANTHROPIC_BASE_URL: baseURL,
    });
    expect(run.code).toBe(0);
    expect(await readFile(path.join(dir, 'out.txt'), 'utf8')).toBe('hello');
  });

  it('exits 1 and says why when the turn limit is hit', async () => {
    const { server, baseURL } = await startFakeApi([toolTurn('list_files', {})]);
    closeServer = () => server.close();
    const { dir } = await workspace();
    const run = await cli(['run', 'loop', '--workspace', dir, '--max-turns', '2'], {
      ANTHROPIC_BASE_URL: baseURL,
    });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('[max_turns]');
  });
});
