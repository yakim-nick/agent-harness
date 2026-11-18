/** The real model client: the Claude Messages API through the official SDK (streaming). */
import Anthropic from '@anthropic-ai/sdk';
import type { ModelClient, ModelRequest, BetaMessage } from './types.js';

export const DEFAULT_MODEL = 'claude-opus-5-5';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export interface AnthropicModelOptions {
  model?: string;
  /** Inject a configured client (custom base URL, retries...). Defaults to `new Anthropic()`. */
  client?: Anthropic;
  /**
   * Server-side refusal fallback (beta): if a safety classifier declines, the API reruns the
   * request on a fallback model inside the same call. On by default for the models that support it.
   */
  fallback?: boolean;
  /** Top-level automatic prompt caching of the stable prefix (system, tools, earlier turns). */
  cache?: boolean;
}

export class AnthropicModelClient implements ModelClient {
  readonly model: string;
  private readonly client: Anthropic;
  private readonly fallback: boolean;
  private readonly cache: boolean;

  constructor(options: AnthropicModelOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.client = options.client ?? new Anthropic();
    this.fallback = options.fallback ?? true;
    this.cache = options.cache ?? true;
  }

  async create(request: ModelRequest): Promise<BetaMessage> {
    const stream = this.client.beta.messages.stream(
      {
        model: this.model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages: request.messages,
        tools: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: { ...tool.inputSchema, type: 'object' as const },
        })),
        // Adaptive thinking is the supported mode on this model; depth is controlled by effort.
        thinking: { type: 'adaptive' },
        output_config: { effort: request.effort },
        ...(this.cache ? { cache_control: { type: 'ephemeral' as const } } : {}),
        ...(this.fallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
      },
      request.signal ? { signal: request.signal } : undefined,
    );
    if (request.onText) stream.on('text', request.onText);
    // finalMessage() resolves with the complete message once the stream ends.
    return stream.finalMessage();
  }
}
