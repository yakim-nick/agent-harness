/** Workspace tools: list, read, search (read-only) and write. All paths go through the sandbox. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { SandboxError, isDeniedName } from '../sandbox.js';
import { ToolError, defineTool } from '../tool.js';

export const MAX_LIST_ENTRIES = 300;
export const MAX_READ_BYTES = 128 * 1024;
export const MAX_SEARCH_RESULTS = 100;
export const MAX_SEARCH_FILE_BYTES = 512 * 1024;
export const MAX_WRITE_BYTES = 200 * 1024;

/** Sandbox failures are safe to show the model; they say what rule was broken, not why internally. */
function asToolError(error: unknown): never {
  if (error instanceof SandboxError) throw new ToolError(error.message);
  throw error;
}

export const listFiles = defineTool({
  name: 'list_files',
  description:
    'List files and directories under a workspace directory as an indented tree. ' +
    'Hides .git and .env files. Symlinks are skipped.',
  risk: 'read',
  inputSchema: z.object({
    path: z.string().default('.').describe('Directory relative to the workspace root.'),
    max_depth: z.number().int().min(1).max(5).default(2).describe('Levels to descend (1-5).'),
  }),
  async run(input, { sandbox }) {
    const dir = await sandbox.resolveExisting(input.path).catch(asToolError);
    if (!(await fs.stat(dir)).isDirectory()) throw new ToolError('path is not a directory');
    const lines: string[] = [];
    const truncated = await walk(dir, input.max_depth, 0, lines);
    if (truncated) lines.push(`... stopped after ${MAX_LIST_ENTRIES} entries`);
    return [sandbox.display(dir), ...(lines.length ? lines : ['(empty)'])].join('\n');
  },
});

async function walk(dir: string, maxDepth: number, level: number, out: string[]): Promise<boolean> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  entries.sort(
    (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    if (isDeniedName(entry.name) || entry.isSymbolicLink()) continue;
    if (out.length >= MAX_LIST_ENTRIES) return true;
    const indent = '  '.repeat(level);
    if (entry.isDirectory()) {
      out.push(`${indent}${entry.name}/`);
      if (
        level + 1 < maxDepth &&
        (await walk(path.join(dir, entry.name), maxDepth, level + 1, out))
      ) {
        return true;
      }
    } else {
      const size = (await fs.stat(path.join(dir, entry.name))).size;
      out.push(`${indent}${entry.name} (${size} bytes)`);
    }
  }
  return false;
}

export const readFile = defineTool({
  name: 'read_file',
  description:
    'Read a UTF-8 text file from the workspace. Long files are truncated. ' +
    'Binary files, .git and .env files are refused.',
  risk: 'read',
  inputSchema: z.object({
    path: z.string().describe('File relative to the workspace root.'),
    max_bytes: z
      .number()
      .int()
      .min(1)
      .max(MAX_READ_BYTES)
      .default(32 * 1024),
  }),
  async run(input, { sandbox }) {
    const file = await sandbox.resolveExisting(input.path).catch(asToolError);
    if (!(await fs.stat(file)).isFile()) throw new ToolError('path is not a regular file');
    const handle = await fs.open(file, 'r');
    try {
      const buffer = Buffer.alloc(input.max_bytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const truncated = bytesRead > input.max_bytes;
      const text = decodeUtf8(buffer.subarray(0, Math.min(bytesRead, input.max_bytes)), truncated);
      if (text === null) throw new ToolError('file is not valid UTF-8 text');
      return truncated ? `${text}\n\n[truncated at ${input.max_bytes} bytes]` : text;
    } finally {
      await handle.close();
    }
  },
});

/**
 * Decode UTF-8. When the bytes were cut at a size limit, an incomplete character at the very
 * end is dropped instead of failing; any other invalid sequence (binary data) returns null.
 */
export function decodeUtf8(bytes: Uint8Array, truncated: boolean): string | null {
  const usable = truncated ? withoutIncompleteTail(bytes) : bytes;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(usable);
  } catch {
    return null;
  }
}

/** Cut a trailing multi-byte sequence whose lead byte promises more bytes than are present. */
function withoutIncompleteTail(bytes: Uint8Array): Uint8Array {
  for (let back = 1; back <= Math.min(3, bytes.length); back++) {
    const byte = bytes[bytes.length - back] as number;
    if ((byte & 0xc0) === 0x80) continue; // continuation byte: look further back for the lead
    const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return needed > back ? bytes.subarray(0, bytes.length - back) : bytes;
  }
  return bytes;
}

export const searchText = defineTool({
  name: 'search_text',
  description:
    'Find lines containing a literal string (case-insensitive) in the workspace text files. ' +
    'Returns path:line: text. Not a regex.',
  risk: 'read',
  inputSchema: z.object({
    query: z.string().min(1).max(200),
    path: z
      .string()
      .default('.')
      .describe('Directory or file to search, relative to the workspace.'),
    max_results: z.number().int().min(1).max(MAX_SEARCH_RESULTS).default(30),
  }),
  async run(input, { sandbox }) {
    const start = await sandbox.resolveExisting(input.path).catch(asToolError);
    const needle = input.query.toLowerCase();
    const results: string[] = [];
    await searchIn(start, sandbox.root, needle, input.max_results, results);
    return results.length ? results.join('\n') : 'no matches';
  },
});

async function searchIn(
  target: string,
  root: string,
  needle: string,
  limit: number,
  out: string[],
): Promise<void> {
  if (out.length >= limit) return;
  const stat = await fs.stat(target);
  if (stat.isDirectory()) {
    for (const entry of (await fs.readdir(target, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (isDeniedName(entry.name) || entry.isSymbolicLink() || entry.name === 'node_modules')
        continue;
      await searchIn(path.join(target, entry.name), root, needle, limit, out);
      if (out.length >= limit) return;
    }
    return;
  }
  if (!stat.isFile() || stat.size > MAX_SEARCH_FILE_BYTES) return;
  const text = decodeUtf8(await fs.readFile(target), false);
  if (text === null) return; // binary
  const rel = path.relative(root, target);
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    const line = lines[i] ?? '';
    if (line.toLowerCase().includes(needle))
      out.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`);
  }
}

export const writeFile = defineTool({
  name: 'write_file',
  description:
    'Create or overwrite a UTF-8 text file in the workspace (parent folders are created). ' +
    'This changes files, so it may need approval.',
  risk: 'write',
  inputSchema: z.object({
    path: z.string().describe('File relative to the workspace root.'),
    content: z.string().describe('Full new content of the file.'),
  }),
  async run(input, { sandbox }) {
    const bytes = Buffer.byteLength(input.content, 'utf8');
    if (bytes > MAX_WRITE_BYTES)
      throw new ToolError(`content is too large (max ${MAX_WRITE_BYTES} bytes)`);
    const file = await sandbox.resolveForWrite(input.path).catch(asToolError);
    if (file === sandbox.root) throw new ToolError('path must name a file');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, input.content, 'utf8');
    return `wrote ${bytes} bytes to ${sandbox.display(file)}`;
  },
});

export const defaultTools = [listFiles, readFile, searchText, writeFile];
