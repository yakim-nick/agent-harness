/**
 * Tracing: every run writes one JSON object per line (JSONL), so a run can be replayed,
 * diffed and audited. Tool inputs are truncated and tool outputs are never stored, only their
 * size, so a trace does not become a copy of your files.
 */
import { appendFileSync } from 'node:fs';

export type TraceEvent =
  | { type: 'run_start'; model: string; task: string; limits: Record<string, number | undefined> }
  | {
      type: 'model_response';
      turn: number;
      stopReason: string | null;
      latencyMs: number;
      usage: Record<string, number>;
      costUsd?: number;
    }
  | {
      type: 'tool_call';
      turn: number;
      tool: string;
      input: string;
      decision: string;
      allowed: boolean;
      durationMs: number;
      isError: boolean;
      resultChars: number;
      error?: string;
    }
  | {
      type: 'run_end';
      status: string;
      turns: number;
      usage: Record<string, number>;
      costUsd?: number;
      message?: string;
    };

export interface Tracer {
  emit(event: TraceEvent): void;
}

export const nullTracer: Tracer = { emit() {} };

export class MemoryTracer implements Tracer {
  readonly events: Array<TraceEvent & { ts: string }> = [];
  emit(event: TraceEvent): void {
    this.events.push({ ts: new Date().toISOString(), ...event });
  }
}

export class JsonlTracer implements Tracer {
  constructor(private readonly file: string) {}
  emit(event: TraceEvent): void {
    appendFileSync(this.file, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
  }
}

/** Short, single-line preview of a tool input for the trace. */
export function previewInput(input: unknown, max = 300): string {
  let text: string;
  try {
    text = JSON.stringify(input) ?? String(input);
  } catch {
    text = String(input);
  }
  return text.length > max ? `${text.slice(0, max)}…(${text.length} chars)` : text;
}
