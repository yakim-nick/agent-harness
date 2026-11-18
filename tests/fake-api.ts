import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Captured {
  url: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

export const sse = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export function streamOf(
  blocks: Array<{ block: Record<string, unknown>; delta?: Record<string, unknown> }>,
  stopReason: string,
): string {
  let out = sse('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_fake',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 120, output_tokens: 1 },
    },
  });
  blocks.forEach(({ block, delta }, index) => {
    out += sse('content_block_start', { type: 'content_block_start', index, content_block: block });
    if (delta) out += sse('content_block_delta', { type: 'content_block_delta', index, delta });
    out += sse('content_block_stop', { type: 'content_block_stop', index });
  });
  out += sse('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 40 },
  });
  out += sse('message_stop', { type: 'message_stop' });
  return out;
}

/** Start a fake Messages API that answers each request with the next prepared stream. */
export async function startFakeApi(
  responses: string[],
): Promise<{ server: Server; baseURL: string; captured: Captured[] }> {
  const captured: Captured[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      captured.push({
        url: req.url ?? '',
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
      });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(responses[captured.length - 1] ?? responses.at(-1));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, baseURL: `http://127.0.0.1:${port}`, captured };
}
