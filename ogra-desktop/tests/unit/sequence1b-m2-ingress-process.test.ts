import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IndependentIngressReviewer } from '../../src/core/independent-ingress-reviewer';
import { OgraErrorCode } from '../../src/shared/errors';

const temporaryPaths: string[] = [];

function workerScript(source: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogra-ingress-worker-test-'));
  temporaryPaths.push(dir);
  const worker = path.join(dir, 'worker.js');
  fs.writeFileSync(worker, source, 'utf8');
  return worker;
}

function reviewer(workerPath?: string, timeoutMs?: number): IndependentIngressReviewer {
  return new IndependentIngressReviewer(
    { getDatabasePath: () => path.join(os.tmpdir(), 'ogra-process-boundary-test.db') } as any,
    {} as any,
    { deriveIngressReviewerKey: () => Buffer.alloc(32, 7) } as any,
    { finalizeIngressDecision: () => { throw new Error('finalization is not part of process-boundary tests'); } },
    { workerPath, timeoutMs },
  );
}

function input() {
  return {
    effectId: 'eff_process', runId: 'run_process', workspaceId: 'ws_process',
    receiptId: 'rcpt_process', attemptNo: 1, payloadDigest: 'a'.repeat(64),
    source: 'agent' as const,
  };
}

afterEach(() => {
  for (const target of temporaryPaths.splice(0)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

describe('Sequence 1B M2 ingress reviewer process boundary', () => {
  it('uses a different PID and sends no raw payload/capsule/key to the reviewer', () => {
    const capture = path.join(os.tmpdir(), `ogra-ingress-capture-${Date.now()}-${Math.random()}.json`);
    temporaryPaths.push(capture);
    const worker = workerScript(`
      const fs = require('fs');
      const request = JSON.parse(fs.readFileSync(0, 'utf8'));
      fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ request, args: process.argv, env: process.env }));
      process.stdout.write(JSON.stringify({ namespace: request.namespace, callerContext: 'ingress-review-worker', requestId: request.requestId, pid: process.pid, verdict: { outcome: 'accepted', reviewer: 'default-policy', sanitizedReasonCode: 'no_anomalies_detected' } }));
    `);
    const isolated = reviewer(worker);

    expect(isolated.review(input())).toMatchObject({ outcome: 'accepted' });
    expect(isolated.lastWorkerPid).toBeTypeOf('number');
    expect(isolated.lastWorkerPid).not.toBe(process.pid);

    const captured = JSON.parse(fs.readFileSync(capture, 'utf8'));
    const sent = JSON.stringify(captured.request);
    expect(sent).not.toContain('raw-response-body-that-must-not-cross-ipc');
    expect(sent).not.toContain('capsuleBlob');
    expect(sent).not.toContain('secret');
    expect(captured.args).not.toContain('--database-path');
    expect(captured.env.OGRA_INGRESS_CAPSULE_KEY).toBeUndefined();
    expect(JSON.stringify(captured.env)).not.toContain('capsule.v1');
    expect(captured.request).toEqual(expect.objectContaining({
      namespace: 'ogra.ingress-review.v1',
      callerContext: 'core-ingress-supervisor',
      payloadDigest: 'a'.repeat(64),
    }));
  });

  it('fails closed when the reviewer is unavailable or returns malformed IPC', () => {
    const unavailable = reviewer('/definitely-not-an-ogra-reviewer.js');
    expect(() => unavailable.review(input())).toThrow(OgraErrorCode.INGRESS_REVIEW_DENIED);

    const malformed = reviewer(workerScript("process.stdout.write('not-json');"));
    expect(() => malformed.review(input())).toThrow(OgraErrorCode.INGRESS_REVIEW_DENIED);
  });

  it('fails closed when the reviewer exceeds its execution deadline', () => {
    const timeout = reviewer(workerScript('setTimeout(() => {}, 5000);'), 20);
    expect(() => timeout.review(input())).toThrow(OgraErrorCode.INGRESS_REVIEW_DENIED);
  });
});
