#!/usr/bin/env node
'use strict';

// Dedicated review-process program. The only producer-to-reviewer IPC input
// is a reference/digest/state envelope plus a one-time AEAD ciphertext on
// stdin. The child never sees a workspace capsule key or database path.
const fs = require('fs');
const crypto = require('crypto');

const NAMESPACE = 'ogra.ingress-review.v1';
const SUPERVISOR = 'core-ingress-supervisor';
const WORKER = 'ingress-review-worker';

function deny(message) {
  process.stderr.write(message + '\n');
  process.exit(2);
}

function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
}

function decryptReviewPayload(request) {
  const encoded = request.sealedPayload;
  const key = process.env.OGRA_INGRESS_REVIEW_KEY;
  if (typeof encoded !== 'string' || !key) throw new Error('one-time review capability unavailable');
  const reviewKey = Buffer.from(key, 'base64');
  const blob = Buffer.from(encoded, 'base64');
  if (reviewKey.length !== 32 || blob.length < 29) throw new Error('one-time review capability invalid');
  const nonce = blob.subarray(0, 12);
  const tag = blob.subarray(blob.length - 16);
  const ciphertext = blob.subarray(12, blob.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', reviewKey, nonce);
  decipher.setAAD(Buffer.from(request.requestId, 'utf8'));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const payload = JSON.parse(plaintext.toString('utf8'));
  const digest = crypto.createHash('sha256').update(canonicalJSON(payload)).digest('hex');
  if (digest !== request.payloadDigest) throw new Error('review digest mismatch');
  return payload;
}

class PromptInjectionDetector {
  scan(payload) {
    const text = canonicalJSON(payload);
    const patterns = [
      ['prompt-injection.ignore-previous', /ignore\s+(all\s+)?(previous|prior)\s+instructions?/i, 'high'],
      ['prompt-injection.system-prompt', /(reveal|show|print).{0,40}(system\s+prompt|developer\s+message)/i, 'high'],
      ['prompt-injection.exfiltrate-secret', /(exfiltrate|send).{0,40}(secret|api[_ -]?key|token|password)/i, 'critical'],
      ['prompt-injection.jailbreak', /\b(jailbreak|do\s+anything\s+now)\b/i, 'high'],
    ];
    const findings = [];
    for (const [patternId, expression, severity] of patterns) {
      const match = text.match(expression);
      if (match) findings.push({
        patternId,
        evidence: '[redacted]',
        evidenceHash: crypto.createHash('sha256').update(match[0]).digest('hex'),
        severity,
        layer: 'result_payload',
      });
    }
    return findings;
  }
}

let request;
try {
  request = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch { deny('malformed ingress review request'); }
if (!request || request.namespace !== NAMESPACE || request.callerContext !== SUPERVISOR
  || typeof request.requestId !== 'string' || typeof request.effectId !== 'string'
  || typeof request.runId !== 'string' || typeof request.workspaceId !== 'string'
  || typeof request.receiptId !== 'string' || !Number.isInteger(request.attemptNo)
  || typeof request.payloadDigest !== 'string' || (request.source !== 'agent' && request.source !== 'recovery')) {
  deny('invalid ingress review request');
}

let verdict;
try {
  if (!request.payloadDigest) {
    verdict = { outcome: 'quarantined', reviewer: 'default-policy', sanitizedReasonCode: 'payload_digest_empty' };
  } else if (!request.receiptId || request.attemptNo <= 0) {
    verdict = { outcome: 'quarantined', reviewer: 'default-policy', sanitizedReasonCode: 'receipt_binding_invalid' };
  } else {
    const findings = new PromptInjectionDetector().scan(decryptReviewPayload(request));
    verdict = findings.length > 0
      ? { outcome: 'quarantined', reviewer: 'default-policy', sanitizedReasonCode: 'prompt_injection_detected', structuredFindings: findings }
      : { outcome: 'accepted', reviewer: 'default-policy', sanitizedReasonCode: request.source === 'agent' ? 'no_anomalies_detected' : 'recovery_replay_validated', structuredFindings: [] };
  }
} catch (error) {
  // The worker never fabricates acceptance when its independently-read
  // evidence cannot be verified. Its nonzero exit is fail-closed in Core.
  deny(`ingress review failed: ${error instanceof Error ? error.message : 'unknown'}`);
}

process.stdout.write(JSON.stringify({
  namespace: NAMESPACE, callerContext: WORKER, requestId: request.requestId,
  pid: process.pid, verdict,
}));
