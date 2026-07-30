import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawnSync } from 'child_process';
import { IndependentIngressReviewer } from '../../src/core/independent-ingress-reviewer';
import { OgraErrorCode } from '../../src/shared/errors';
import { canonicalJSON } from '../../src/core/audit-envelope';

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
    undefined,
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

  it.each([
    ['empty response object', '{}'],
    ['null response', 'null'],
    ['null verdict', '{"verdict":null}'],
    ['primitive verdict', '{"verdict":"SECRET_SENTINEL"}'],
    ['malformed verdict JSON', '{"verdict":'],
  ])('converts %s to a stable typed denial', (_label, rawResponse) => {
    const malformed = reviewer(workerScript(
      `process.stdout.write(${JSON.stringify(rawResponse)});`,
    ));
    let caught: unknown;
    try {
      malformed.review(input());
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: OgraErrorCode.INGRESS_REVIEW_DENIED });
    expect((caught as Error).message).toBe(
      '[INGRESS_REVIEW_DENIED] ingress reviewer returned an invalid or untrusted verdict',
    );
    expect(JSON.stringify(caught)).not.toContain('SECRET_SENTINEL');
    expect((caught as Error).message).not.toMatch(/TypeError|Cannot read|JSON|SyntaxError/);
  });

  it('never exposes worker stderr or raw spawn-system diagnostics', () => {
    const stderrSecret = 'WORKER_STDERR_SECRET_DO_NOT_EXPOSE';
    const stderrWorker = reviewer(workerScript(`
      process.stderr.write('${stderrSecret}');
      process.exit(23);
    `));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let stderrError: unknown;
    try {
      stderrWorker.review(input());
    } catch (err) {
      stderrError = err;
    }
    expect(stderrError).toMatchObject({ code: OgraErrorCode.INGRESS_REVIEW_DENIED });
    expect(JSON.stringify(stderrError)).not.toContain(stderrSecret);
    expect((stderrError as Error).message).toBe(
      '[INGRESS_REVIEW_DENIED] ingress reviewer is unavailable',
    );
    expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain(stderrSecret);

    const pathSecret = 'RAW_SYSTEM_PATH_SECRET_DO_NOT_EXPOSE';
    let spawnError: unknown;
    try {
      reviewer(`/missing/${pathSecret}.js`).review(input());
    } catch (err) {
      spawnError = err;
    }
    expect(spawnError).toMatchObject({ code: OgraErrorCode.INGRESS_REVIEW_DENIED });
    expect(JSON.stringify(spawnError)).not.toContain(pathSecret);
    consoleSpy.mockRestore();
  });

  it('real worker redacts a valid sealed payload that cannot be parsed as JSON', () => {
    const secret = 'INGRESS_WORKER_PAYLOAD_SECRET';
    const key = Buffer.alloc(32, 9);
    const requestId = 'request_redaction';
    const nonce = Buffer.alloc(12, 4);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(requestId, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const sealedPayload = Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64');
    const request = {
      namespace: 'ogra.ingress-review.v1', callerContext: 'core-ingress-supervisor',
      requestId, effectId: 'effect_redaction', runId: 'run_redaction',
      workspaceId: 'workspace_redaction', receiptId: 'receipt_redaction',
      attemptNo: 1, payloadDigest: 'a'.repeat(64), source: 'agent', sealedPayload,
    };
    const worker = path.resolve(__dirname, '../../src/core/ingress-review-worker.js');
    const completed = spawnSync(process.execPath, [worker], {
      input: JSON.stringify(request), encoding: 'utf8',
      env: { ...process.env, OGRA_INGRESS_REVIEW_KEY: key.toString('base64') },
    });
    expect(completed.status).toBe(2);
    expect(completed.stderr).toBe('ingress_review_failed\n');
    expect(`${completed.stdout}${completed.stderr}`).not.toContain(secret);
  });

  it('converts unexpected finalizer exceptions to a stable typed denial', () => {
    const finalizerSecret = 'RAW_SQLITE_FINALIZER_SECRET_DO_NOT_EXPOSE';
    const payload = { safe: true };
    const digest = crypto.createHash('sha256')
      .update(canonicalJSON(payload)).digest('hex');
    const worker = workerScript(`
      const fs = require('fs');
      const request = JSON.parse(fs.readFileSync(0, 'utf8'));
      process.stdout.write(JSON.stringify({
        namespace: request.namespace,
        callerContext: 'ingress-review-worker',
        requestId: request.requestId,
        pid: process.pid,
        verdict: {
          outcome: 'accepted', reviewer: 'default-policy',
          sanitizedReasonCode: 'no_anomalies_detected'
        }
      }));
    `);
    const fakeDb = {
      getDB: () => ({
        prepare: (sql: string) => ({
          get: () => sql.includes('effect_receipts') ? {
            result_capsule_ref: 'sealed-ref',
            result_capsule_hash: digest,
            result_capsule_format_version: 'v1',
          } : undefined,
        }),
      }),
    } as any;
    const isolated = new IndependentIngressReviewer(
      fakeDb, {} as any,
      { openResultForReceipt: () => ({ payload }) } as any,
      { finalizeIngressDecision: () => { throw new Error(finalizerSecret); } },
      undefined,
      { workerPath: worker },
    );
    let caught: unknown;
    try {
      isolated.reviewAndFinalize({
        ...input(), payloadDigest: digest,
        ruleVersion: 'test-v1', leaseHolderId: 'holder', leaseVersion: 1,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: OgraErrorCode.INGRESS_REVIEW_DENIED });
    expect((caught as Error).message).toBe(
      '[INGRESS_REVIEW_DENIED] ingress review finalization failed',
    );
    expect(JSON.stringify(caught)).not.toContain(finalizerSecret);
  });

  it('fails closed when the reviewer exceeds its execution deadline', () => {
    const timeout = reviewer(workerScript('setTimeout(() => {}, 5000);'), 20);
    expect(() => timeout.review(input())).toThrow(OgraErrorCode.INGRESS_REVIEW_DENIED);
  });
});
