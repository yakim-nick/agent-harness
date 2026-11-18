import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLICY, decide } from '../src/permissions.js';
import { listFiles, writeFile } from '../src/tools/fs.js';

describe('decide', () => {
  it('allows reads and asks for writes by default', async () => {
    const approve = vi.fn().mockResolvedValue(true);
    expect((await decide(listFiles, {}, DEFAULT_POLICY, approve)).allowed).toBe(true);
    expect(approve).not.toHaveBeenCalled();
    expect((await decide(writeFile, { path: 'a' }, DEFAULT_POLICY, approve)).allowed).toBe(true);
    expect(approve).toHaveBeenCalledWith({
      tool: 'write_file',
      risk: 'write',
      input: { path: 'a' },
    });
  });

  it('refuses a write when the user declines or no approver exists, with a reason the model can read', async () => {
    const declined = await decide(writeFile, {}, DEFAULT_POLICY, async () => false);
    expect(declined).toEqual({ allowed: false, reason: 'the user declined the write_file call' });
    const none = await decide(writeFile, {}, DEFAULT_POLICY, undefined);
    expect(none.allowed).toBe(false);
    expect(none.reason).toContain('needs approval');
  });

  it('per-tool overrides beat per-risk defaults', async () => {
    const policy = {
      byRisk: { read: 'allow', write: 'allow' },
      byTool: { write_file: 'deny', list_files: 'ask' },
    } as const;
    expect((await decide(writeFile, {}, policy, async () => true)).reason).toContain('forbids');
    expect((await decide(listFiles, {}, policy, async () => false)).allowed).toBe(false);
  });
});
