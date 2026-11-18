import type Anthropic from '@anthropic-ai/sdk';
import type { ToolSpec } from '../tool.js';

export type BetaMessage = Anthropic.Beta.BetaMessage;
export type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
export type BetaContentBlock = Anthropic.Beta.BetaContentBlock;

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelRequest {
  system: string;
  messages: BetaMessageParam[];
  tools: ToolSpec[];
  maxTokens: number;
  effort: Effort;
  signal?: AbortSignal;
  /** Called with streamed text as it is generated (for live display). */
  onText?: (delta: string) => void;
}

/**
 * The only thing the loop knows about a model. The real implementation calls the Claude API;
 * tests use a scripted fake, so the loop is fully testable without a network or an API key.
 */
export interface ModelClient {
  readonly model: string;
  create(request: ModelRequest): Promise<BetaMessage>;
}
