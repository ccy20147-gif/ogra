import { describe, expect, it, vi } from 'vitest';
import { invokeApprovalDecision } from '../../src/renderer/components/AiGovernanceCenter';

describe('approval decision UI boundary', () => {
  it('returns a retryable failure instead of an optimistic done outcome', async () => {
    const handler = vi.fn(async () => {
      throw new Error('same-run resume rejected');
    });

    const result = await invokeApprovalDecision(handler, 'apr_1', 'run_1', 'ws_1', 'approve');

    expect(handler).toHaveBeenCalledWith('apr_1', 'run_1', 'ws_1', 'approve');
    expect(result).toEqual({ ok: false, message: 'same-run resume rejected' });
  });

  it('reports done only after the Core-backed handler resolves', async () => {
    const result = await invokeApprovalDecision(async () => undefined, 'apr_1', 'run_1', 'ws_1', 'deny');
    expect(result).toEqual({ ok: true });
  });
});
