/**
 * A small eval runner: run tasks through the real harness and check the outcome with code.
 * Checks look at what the agent DID (files, final answer), not at how it phrased things.
 * Running against a real model costs money, so it is a manual command, never part of CI.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runAgent, type AgentConfig, type RunResult } from './loop.js';
import { Sandbox } from './sandbox.js';

export interface EvalTask {
  id: string;
  prompt: string;
  /** Files created in a fresh temporary workspace before the run. */
  files: Record<string, string>;
  /** Return true when the run satisfied the task, or a string explaining the failure. */
  check(run: RunResult, workspaceDir: string): Promise<true | string> | true | string;
}

export interface EvalOutcome {
  id: string;
  passed: boolean;
  detail: string;
  status: RunResult['status'];
  turns: number;
  costUsd?: number;
}

export type ConfigFactory = (sandbox: Sandbox) => Omit<AgentConfig, 'sandbox'>;

export async function runEval(
  tasks: EvalTask[],
  makeConfig: ConfigFactory,
): Promise<EvalOutcome[]> {
  const outcomes: EvalOutcome[] = [];
  for (const task of tasks) {
    const dir = await mkdtemp(path.join(tmpdir(), `eval-${task.id}-`));
    for (const [name, content] of Object.entries(task.files)) {
      await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await writeFile(path.join(dir, name), content);
    }
    const sandbox = await Sandbox.create(dir);
    const run = await runAgent(task.prompt, { ...makeConfig(sandbox), sandbox });
    const verdict =
      run.status === 'completed'
        ? await task.check(run, dir)
        : `run ended with status ${run.status}${run.error ? `: ${run.error}` : ''}`;
    outcomes.push({
      id: task.id,
      passed: verdict === true,
      detail: verdict === true ? 'ok' : verdict,
      status: run.status,
      turns: run.turns,
      ...(run.costUsd !== undefined ? { costUsd: run.costUsd } : {}),
    });
  }
  return outcomes;
}

export function summarise(outcomes: EvalOutcome[]): string {
  const lines = outcomes.map(
    (o) =>
      `${o.passed ? 'PASS' : 'FAIL'}  ${o.id}  (${o.turns} turns${o.costUsd !== undefined ? `, ~$${o.costUsd.toFixed(4)}` : ''})${o.passed ? '' : `  ${o.detail}`}`,
  );
  const passed = outcomes.filter((o) => o.passed).length;
  const cost = outcomes.reduce((sum, o) => sum + (o.costUsd ?? 0), 0);
  return [...lines, `${passed}/${outcomes.length} passed, estimated cost $${cost.toFixed(4)}`].join(
    '\n',
  );
}
