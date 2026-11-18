import { describe, expect, it } from 'vitest';
import { runEval, summarise, type EvalTask } from '../src/eval.js';
import { defaultTools } from '../src/tools/fs.js';
import { tasks } from '../src/evals/tasks.js';
import { ScriptedModel, callTools, endTurn, toolUse } from './helpers.js';

const config = (model: ScriptedModel) => () => ({
  model,
  tools: defaultTools,
  system: 'sys',
  approve: async () => true,
});

describe('runEval', () => {
  const task: EvalTask = {
    id: 'read-it',
    prompt: 'what does a.txt say?',
    files: { 'a.txt': 'blue' },
    check: (run) => (run.finalText.includes('blue') ? true : 'did not say blue'),
  };

  it('runs a task in a fresh workspace and passes when the check passes', async () => {
    const model = new ScriptedModel([
      callTools(toolUse('1', 'read_file', { path: 'a.txt' })),
      endTurn('it says blue'),
    ]);
    const [outcome] = await runEval([task], config(model));
    expect(outcome).toMatchObject({ id: 'read-it', passed: true, status: 'completed', turns: 2 });
  });

  it('fails with the check message, and fails a run that did not complete', async () => {
    const wrong = new ScriptedModel([endTurn('it says red')]);
    expect((await runEval([task], config(wrong)))[0]).toMatchObject({
      passed: false,
      detail: 'did not say blue',
    });
    const broken = new ScriptedModel([new Error('503')]);
    expect((await runEval([task], config(broken)))[0]).toMatchObject({
      passed: false,
      status: 'error',
    });
  });

  it('summarises pass/fail and cost', () => {
    const text = summarise([
      { id: 'a', passed: true, detail: 'ok', status: 'completed', turns: 2, costUsd: 0.01 },
      { id: 'b', passed: false, detail: 'nope', status: 'completed', turns: 1 },
    ]);
    expect(text).toContain('PASS  a');
    expect(text).toContain('FAIL  b');
    expect(text).toContain('1/2 passed, estimated cost $0.0100');
  });
});

describe('sample tasks', () => {
  it('have unique ids and checks that reject an obviously wrong answer', async () => {
    expect(new Set(tasks.map((t) => t.id)).size).toBe(tasks.length);
    const wrong = new ScriptedModel(tasks.map(() => endTurn('I did nothing')));
    const outcomes = await runEval(tasks.slice(0, 2), config(wrong));
    expect(outcomes.every((o) => !o.passed)).toBe(true);
  });

  it('the oracle path for find-marker passes', async () => {
    const model = new ScriptedModel([
      callTools(toolUse('1', 'search_text', { query: 'URGENT-FIX' })),
      endTurn('src/billing.ts'),
    ]);
    const [outcome] = await runEval([tasks[0] as EvalTask], config(model));
    expect(outcome?.passed).toBe(true);
  });
});
