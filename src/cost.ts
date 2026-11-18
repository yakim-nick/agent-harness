/**
 * Cost estimates in USD. Prices are copied from the Claude API reference (cached 2026-11-03)
 * and WILL go stale: they are estimates for budgeting, not billing. Cache reads are 5% of the
 * input price and 5-minute cache writes 1.25x, per the same reference.
 */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** USD per million tokens. */
interface Price {
  input: number;
  output: number;
}

const PRICES: Record<string, Price> = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  // Haiku 5.5 prices apply to prompts up to 100K tokens; longer prompts cost more.
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
};

export function hasPrice(model: string): boolean {
  return model in PRICES;
}

/** Estimated cost of one response, or undefined when the model's price is not known. */
export function estimateCostUsd(model: string, usage: Usage): number | undefined {
  const price = PRICES[model];
  if (!price) return undefined;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const dollars =
    usage.input_tokens * price.input +
    cacheRead * price.input * 0.05 +
    cacheWrite * price.input * 1.25 +
    usage.output_tokens * price.output;
  return dollars / 1_000_000;
}
