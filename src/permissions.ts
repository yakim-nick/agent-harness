/**
 * Permission policy. The harness decides, per tool call, whether to run it, ask a human or
 * refuse. Reversibility drives the defaults: reads run freely, writes ask.
 */
import type { Risk, Tool } from './tool.js';

export type Mode = 'allow' | 'ask' | 'deny';

export interface Policy {
  /** Default decision per risk level. */
  byRisk: Record<Risk, Mode>;
  /** Overrides for specific tool names (for example forbid one tool entirely). */
  byTool?: Record<string, Mode>;
}

export const DEFAULT_POLICY: Policy = { byRisk: { read: 'allow', write: 'ask' } };

export interface ApprovalRequest {
  tool: string;
  risk: Risk;
  input: unknown;
}

/** Resolves true to allow this call. Interactive CLIs prompt; tests pass a stub. */
export type Approver = (request: ApprovalRequest) => Promise<boolean>;

export interface Decision {
  allowed: boolean;
  /** Why it was refused (shown to the model so it can adapt) or how it was allowed. */
  reason: string;
}

export async function decide(
  tool: Tool,
  input: unknown,
  policy: Policy,
  approve: Approver | undefined,
): Promise<Decision> {
  const mode = policy.byTool?.[tool.name] ?? policy.byRisk[tool.risk];
  if (mode === 'allow') return { allowed: true, reason: 'policy: allow' };
  if (mode === 'deny')
    return { allowed: false, reason: `the policy forbids the ${tool.name} tool` };
  if (!approve) {
    return {
      allowed: false,
      reason: `${tool.name} needs approval and no approver is available (run interactively or pass --yes)`,
    };
  }
  const ok = await approve({ tool: tool.name, risk: tool.risk, input });
  return ok
    ? { allowed: true, reason: 'approved' }
    : { allowed: false, reason: `the user declined the ${tool.name} call` };
}
