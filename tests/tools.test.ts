import { readFile as readFromDisk, writeFile as writeToDisk } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolError, ToolInputError } from '../src/tool.js';
import {
  decodeUtf8,
  listFiles,
  readFile,
  searchText,
  writeFile,
  MAX_LIST_ENTRIES,
  MAX_WRITE_BYTES,
} from '../src/tools/fs.js';
import { workspace } from './helpers.js';

const signal = new AbortController().signal;
async function run(tool: typeof listFiles, input: unknown, files: Record<string, string> = {}) {
  const { sandbox, dir } = await workspace(files);
  const ctx = { sandbox, signal };
  return { out: () => tool.execute(input, ctx), dir };
}

describe('tool specs', () => {
  it('produce plain JSON Schema objects without $schema', () => {
    for (const tool of [listFiles, readFile, searchText, writeFile]) {
      expect(tool.spec.inputSchema['type']).toBe('object');
      expect(tool.spec.inputSchema).not.toHaveProperty('$schema');
    }
    expect(readFile.spec.inputSchema['required']).toEqual(['path']);
  });

  it('marks read tools parallel-safe and the write tool serial', () => {
    expect([listFiles, readFile, searchText].every((t) => t.parallelSafe)).toBe(true);
    expect(writeFile.parallelSafe).toBe(false);
    expect(writeFile.risk).toBe('write');
  });
});

describe('list_files', () => {
  it('lists a sorted tree, directories first, hiding secrets', async () => {
    const { out } = await run(
      listFiles,
      {},
      { 'b.txt': 'bb', 'src/a.ts': 'a', '.env': 'T=1', '.git/HEAD': 'x' },
    );
    expect(await out()).toBe(['.', 'src/', '  a.ts (1 bytes)', 'b.txt (2 bytes)'].join('\n'));
  });

  it('respects max_depth', async () => {
    const { out } = await run(listFiles, { max_depth: 1 }, { 'src/deep/x.ts': 'x' });
    expect(await out()).toBe(['.', 'src/'].join('\n'));
  });

  it('rejects out-of-range arguments and non-directories', async () => {
    const bad = await run(listFiles, { max_depth: 99 });
    await expect(bad.out()).rejects.toBeInstanceOf(ToolInputError);
    const notDir = await run(listFiles, { path: 'a.txt' }, { 'a.txt': 'x' });
    await expect(notDir.out()).rejects.toThrow('not a directory');
  });

  it('stops at the entry limit and says so', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < MAX_LIST_ENTRIES + 20; i++)
      files[`f${String(i).padStart(4, '0')}.txt`] = 'x';
    const { out } = await run(listFiles, {}, files);
    expect(await out()).toContain(`stopped after ${MAX_LIST_ENTRIES} entries`);
  });
});

describe('read_file', () => {
  it('returns file content', async () => {
    const { out } = await run(readFile, { path: 'a.txt' }, { 'a.txt': 'hello\n' });
    expect(await out()).toBe('hello\n');
  });

  it('truncates at max_bytes without splitting a character', async () => {
    const { out } = await run(
      readFile,
      { path: 'e.txt', max_bytes: 10 },
      { 'e.txt': '€'.repeat(100) },
    );
    expect(await out()).toBe('€€€\n\n[truncated at 10 bytes]');
  });

  it('refuses binary files, denied files, missing files and directories with ToolErrors', async () => {
    const { sandbox, dir } = await workspace({ '.env': 'T=1', 'sub/x': 'x' });
    await writeToDisk(path.join(dir, 'bin'), Buffer.from([0xff, 0xfe, 0x00]));
    const ctx = { sandbox, signal };
    await expect(readFile.execute({ path: 'bin' }, ctx)).rejects.toThrow('not valid UTF-8');
    await expect(readFile.execute({ path: '.env' }, ctx)).rejects.toThrow('not allowed');
    await expect(readFile.execute({ path: 'nope' }, ctx)).rejects.toThrow('not found');
    await expect(readFile.execute({ path: 'sub' }, ctx)).rejects.toThrow('not a regular file');
    await expect(readFile.execute({ path: '../x' }, ctx)).rejects.toBeInstanceOf(ToolError);
    await expect(readFile.execute({}, ctx)).rejects.toThrow('invalid arguments: path');
  });

  it('decodeUtf8 only forgives a character cut by the limit', () => {
    const euro = new TextEncoder().encode('€');
    expect(decodeUtf8(euro.subarray(0, 2), true)).toBe('');
    expect(decodeUtf8(euro.subarray(0, 2), false)).toBeNull();
    expect(decodeUtf8(new Uint8Array([0xff, 0xfe]), true)).toBeNull();
  });
});

describe('search_text', () => {
  const files = {
    'a.ts': 'const Alpha = 1;\nconst beta = 2;',
    'sub/b.ts': 'ALPHA again',
    'node_modules/x.js': 'alpha',
    '.env': 'alpha=1',
  };

  it('finds case-insensitive literal matches with path:line and skips node_modules and secrets', async () => {
    const { out } = await run(searchText, { query: 'alpha' }, files);
    expect((await out()).split('\n')).toEqual([
      'a.ts:1: const Alpha = 1;',
      path.join('sub', 'b.ts') + ':1: ALPHA again',
    ]);
  });

  it('treats the query literally (no regex) and reports no matches', async () => {
    const { out } = await run(searchText, { query: '.*' }, files);
    expect(await out()).toBe('no matches');
  });

  it('honours max_results', async () => {
    const { out } = await run(searchText, { query: 'a', max_results: 1 }, { 'x.txt': 'a\na\na' });
    expect((await out()).split('\n')).toHaveLength(1);
  });
});

describe('write_file', () => {
  it('creates folders and files, and overwrites', async () => {
    const { sandbox, dir } = await workspace();
    const ctx = { sandbox, signal };
    expect(await writeFile.execute({ path: 'a/b/c.txt', content: 'one' }, ctx)).toBe(
      `wrote 3 bytes to ${path.join('a', 'b', 'c.txt')}`,
    );
    await writeFile.execute({ path: 'a/b/c.txt', content: 'two!' }, ctx);
    expect(await readFromDisk(path.join(dir, 'a/b/c.txt'), 'utf8')).toBe('two!');
  });

  it('refuses escapes, secrets and oversize content, and writes nothing', async () => {
    const { sandbox, dir } = await workspace();
    const ctx = { sandbox, signal };
    await expect(
      writeFile.execute({ path: '../evil.txt', content: 'x' }, ctx),
    ).rejects.toBeInstanceOf(ToolError);
    await expect(writeFile.execute({ path: '.env', content: 'x' }, ctx)).rejects.toThrow(
      'not allowed',
    );
    await expect(
      writeFile.execute({ path: 'big.txt', content: 'x'.repeat(MAX_WRITE_BYTES + 1) }, ctx),
    ).rejects.toThrow('too large');
    await expect(readFromDisk(path.join(dir, 'big.txt'))).rejects.toThrow();
    await expect(readFromDisk(path.join(dir, '..', 'evil.txt'))).rejects.toThrow();
  });
});
