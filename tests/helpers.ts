import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  ModelClient,
  ModelRequest,
  BetaContentBlock,
  BetaMessage,
} from '../src/model/types.js';
import { Sandbox } from '../src/sandbox.js';

type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause_turn';

interface ScriptedTurn {
  content: unknown[];
  stop_reason: StopReason;
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_details?: unknown;
}

/** Build a model response. The SDK type has many fields the loop never reads, so it is cast once, here. */
export function reply(turn: ScriptedTurn): BetaMessage {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: turn.content,
    stop_reason: turn.stop_reason,
    stop_sequence: null,
    stop_details: turn.stop_details ?? null,
    usage: { input_tokens: 100, output_tokens: 50, ...turn.usage },
  } as unknown as BetaMessage;
}

export const text = (value: string) => ({ type: 'text', text: value });
export const toolUse = (id: string, name: string, input: unknown) => ({
  type: 'tool_use',
  id,
  name,
  input,
});
export const thinking = (value: string) => ({
  type: 'thinking',
  thinking: value,
  signature: 'sig',
});
export const fallbackBlock = () => ({
  type: 'fallback',
  from: { model: 'claude-opus-5-5' },
  to: { model: 'claude-opus-4-8' },
});

export const endTurn = (answer: string, usage?: ScriptedTurn['usage']) =>
  reply({ content: [text(answer)], stop_reason: 'end_turn', ...(usage ? { usage } : {}) });

export const callTools = (...calls: ReturnType<typeof toolUse>[]) =>
  reply({ content: [text('working'), ...calls], stop_reason: 'tool_use' });

/** A model that plays back prepared responses and records every request it receives. */
export class ScriptedModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  private index = 0;
  constructor(
    private readonly script: Array<
      BetaMessage | Error | ((request: ModelRequest) => Promise<BetaMessage>)
    >,
    readonly model = 'claude-opus-5-5',
  ) {}

  async create(request: ModelRequest): Promise<BetaMessage> {
    // Snapshot: the loop keeps mutating its own messages array after this call.
    this.requests.push({ ...request, messages: structuredClone(request.messages) });
    const step = this.script[this.index++];
    if (step === undefined) throw new Error('ScriptedModel: script exhausted');
    if (step instanceof Error) throw step;
    return typeof step === 'function' ? step(request) : step;
  }
}

export async function workspace(
  files: Record<string, string> = {},
): Promise<{ dir: string; sandbox: Sandbox }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'harness-'));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
  return { dir, sandbox: await Sandbox.create(dir) };
}

export function blocksOf(message: { content?: unknown }): BetaContentBlock[] {
  return message.content as BetaContentBlock[];
}
