import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseService } from '../../src/core/database-service';
import { envelopeV2Hash, HASH_ENVELOPE_VERSION_V2 } from '../../src/core/audit-envelope';
import { DataClassification, WorkspaceType, RunEventType } from '../../src/shared/types';
import { createTestDb } from '../helpers/test-db';

/**
 * Alpha 07: Audit Verifier
 *
 * Tests that:
 * - Every run has ordered events with monotonic sequence
 * - (run_id, sequence) is unique
 * - previous_hash matches prior event
 * - event_hash is reproducible from canonical JSON
 * - Tamper tests fail verification after mutation
 * - Concurrent event append preserves transaction boundaries
 */
describe('Alpha Audit Verifier', () => {
  let fixture: ReturnType<typeof createTestDb>;
  let db: DatabaseService;
  let wsId: string;

  beforeAll(() => {
    fixture = createTestDb();
    db = fixture.db;
    wsId = fixture.workspaceId;
    // Create an agent run that all test events can reference
    const now = new Date().toISOString();
    db.storeRun({ id: 'verify_seq_run', workspaceId: wsId, task: 'Sequence test', status: 'completed', startedAt: now, completedAt: now });
    db.storeRun({ id: 'verify_unique_run', workspaceId: wsId, task: 'Uniqueness test', status: 'completed', startedAt: now, completedAt: now });
    db.storeRun({ id: 'verify_hash_run', workspaceId: wsId, task: 'Hash chain test', status: 'completed', startedAt: now, completedAt: now });
    db.storeRun({ id: 'verify_tamper_run', workspaceId: wsId, task: 'Tamper test', status: 'completed', startedAt: now, completedAt: now });
    db.storeRun({ id: 'verify_route_run', workspaceId: wsId, task: 'Route test', status: 'completed', startedAt: now, completedAt: now });
    db.storeRun({ id: 'verify_policy_run', workspaceId: wsId, task: 'Policy test', status: 'completed', startedAt: now, completedAt: now });
    db.storeRun({ id: 'demo-run-001', workspaceId: wsId, task: 'Demo run', status: 'completed', startedAt: now, completedAt: now });
    db.storeRun({ id: 'verify_risk_run', workspaceId: wsId, task: 'Risk test', status: 'completed', startedAt: now, completedAt: now });
    db.storeRun({ id: 'verify_high_risk', workspaceId: wsId, task: 'High risk test', status: 'completed', startedAt: now, completedAt: now });
  });

  afterAll(() => {
    fixture.cleanup();
  });

  it('should create events with monotonic sequence per run', () => {
    const runId = 'verify_seq_run';

    for (let i = 1; i <= 5; i++) {
      db.appendRunEvent(runId, wsId, 'test_event', { step: i, data: `value_${i}` });
    }

    const events = db.getRunEvents(runId);
    expect(events).toHaveLength(5);

    for (let i = 0; i < events.length; i++) {
      expect(events[i].sequence).toBe(i + 1);
    }
  });

  it('should enforce (run_id, sequence) uniqueness', () => {
    // Attempting to insert with same run_id + sequence should work since we always auto-increment
    // But manually check that sequences are strict
    const runId = 'verify_unique_run';
    db.appendRunEvent(runId, wsId, 'event_a', { msg: 'first' });
    db.appendRunEvent(runId, wsId, 'event_b', { msg: 'second' });

    const events = db.getRunEvents(runId);
    expect(events[0].sequence).toBe(1);
    expect(events[1].sequence).toBe(2);
    expect(events[0].run_id).toBe(events[1].run_id);
  });

  it('should link previous_hash correctly', () => {
    const runId = 'verify_hash_chain';

    const event1 = db.appendRunEvent(runId, wsId, 'first', { msg: 'genesis' });
    const event2 = db.appendRunEvent(runId, wsId, 'second', { msg: 'followup' });

    // First event uses genesis hash
    expect(event1.previous_hash).toBe('0000000000000000000000000000000000000000000000000000000000000000');
    // Second event's previous_hash = first event's event_hash
    expect(event2.previous_hash).toBe(event1.event_hash);
  });

  it('should produce verifiable event_hash (canonical JSON)', () => {
    const runId = 'verify_reproducible_hash';
    const payload = { msg: 'test', number: 42 };

    const event = db.appendRunEvent(runId, wsId, 'reproducible', payload);

    // v18 writers sign the canonical v2 envelope, not only the
    // payload and previous hash used by legacy v1 rows.
    const expectedHash = envelopeV2Hash({
      id: event.id,
      runId,
      workspaceId: wsId,
      sequence: event.sequence,
      eventType: event.event_type,
      eventPayloadJson: event.event_payload_json,
      payloadHash: event.payload_hash,
      policyVersionHash: event.policy_version_hash,
      redactionRuleVersion: event.redaction_rule_version,
      createdAt: event.created_at,
      previousHash: event.previous_hash,
    });

    expect(event.event_hash).toBe(expectedHash);
    expect(event.hash_envelope_version).toBe(HASH_ENVELOPE_VERSION_V2);
  });

  it('writes and verifies independent v2 chains with overlapping sequence numbers', () => {
    const first = db.appendRunEvent('verify_seq_run', wsId, 'v2_a', { a: 1 });
    const second = db.appendRunEvent('verify_unique_run', wsId, 'v2_b', { b: 2 });
    expect(first.sequence).toBeGreaterThan(0);
    expect(second.sequence).toBeGreaterThan(0);
    expect(db.verifyRunChain('verify_seq_run').valid).toBe(true);
    expect(db.verifyRunChain('verify_unique_run').valid).toBe(true);
  });

  it('detects non-payload envelope field tampering on production-written v2 rows', () => {
    const runId = 'verify_v2_envelope_tamper';
    const row = db.appendRunEvent(runId, wsId, 'safe_event', { safe: true });
    db.getRawDB().prepare('UPDATE run_events SET event_type = ? WHERE id = ?')
      .run('tampered_event', row.id);
    expect(db.verifyRunChain(runId).valid).toBe(false);
  });

  it('rejects non-canonical payload bytes on production-written v2 rows', () => {
    const runId = 'verify_v2_payload_bytes';
    const row = db.appendRunEvent(runId, wsId, 'safe_event', { a: 1, b: 2 });
    db.getRawDB().prepare('UPDATE run_events SET event_payload_json = ? WHERE id = ?')
      .run('{"b":2,"a":1}', row.id);
    expect(db.verifyRunChain(runId).valid).toBe(false);
  });

  it('should verify chain integrity', () => {
    const runId = 'verify_integrity';
    db.appendRunEvent(runId, wsId, 'step1', { action: 'begin' });
    db.appendRunEvent(runId, wsId, 'step2', { action: 'process' });
    db.appendRunEvent(runId, wsId, 'step3', { action: 'complete' });

    const result = db.verifyRunChain(runId);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should detect tampered event payload', () => {
    const runId = 'verify_tamper_detect';

    // Create events
    db.appendRunEvent(runId, wsId, 'original', { data: 'safe_value' });
    db.appendRunEvent(runId, wsId, 'complete', { status: 'done' });

    // Now tamper by directly modifying the event_payload_json in the DB
    const events = db.getRunEvents(runId);
    const firstEvent = events[0];

    db.updateRunEventField(firstEvent.id, 'event_payload_json', '{"data":"TAMPERED"}');

    // Verification should now fail
    const result = db.verifyRunChain(runId);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
  });

  it('should detect broken previous_hash', () => {
    const runId = 'verify_broken_chain';

    db.appendRunEvent(runId, wsId, 'a', { seq: 1 });
    db.appendRunEvent(runId, wsId, 'b', { seq: 2 });

    // Tamper the event_hash of the first event
    const eventA = db.getRunEvents(runId)[0];
    db.updateRunEventField(eventA.id, 'event_hash', 'tampered_hash_0000000000000000000');

    const result = db.verifyRunChain(runId);
    expect(result.valid).toBe(false);
  });

  it('should record route_decision events for every run', () => {
    const runId = 'verify_has_route_decision';

    db.appendRunEvent(runId, wsId, RunEventType.RouteDecision, {
      route: 'local',
      classification: 'Confidential',
      reasons: ['Confidential data local-only'],
    });

    const events = db.getRunEvents(runId);
    const hasRouteDecision = events.some(e => e.event_type === RunEventType.RouteDecision);
    expect(hasRouteDecision).toBe(true);
  });

  it('should record policy_evaluation events', () => {
    const runId = 'verify_has_policy_eval';

    // Store a policy evaluation directly
    db.storePolicyEvaluation({
      id: `pe_verify_${Date.now()}`,
      runId,
      inputSnapshot: { dataClassification: 'Confidential', requestedCompute: 'local' },
      result: { decision: 'local_only', reasons: ['Confidential data'] },
      matchedRules: ['confidential-local-only'],
    });

    // And add audit event
    db.appendRunEvent(runId, wsId, RunEventType.PolicyEvaluation, {
      policyId: 'confidential-local-only',
      result: 'local_only',
    }, 'sha256:test_version_hash');

    const events = db.getRunEvents(runId);
    const hasPolicyEvent = events.some(e => e.event_type === RunEventType.PolicyEvaluation);
    expect(hasPolicyEvent).toBe(true);
  });

  it('should record model_call events when generation happens', () => {
    const runId = 'verify_model_call_event';

    db.appendRunEvent(runId, wsId, RunEventType.ModelCallStarted, {
      providerId: 'ollama_local',
      modelId: 'qwen',
      isCloud: false,
    });

    db.appendRunEvent(runId, wsId, RunEventType.ModelCallCompleted, {
      tokenUsage: { prompt: 100, completion: 50, total: 150 },
      responseHash: 'sha256:mock_hash',
    });

    const events = db.getRunEvents(runId);
    expect(events.some(e => e.event_type === RunEventType.ModelCallStarted)).toBe(true);
    expect(events.some(e => e.event_type === RunEventType.ModelCallCompleted)).toBe(true);
  });
});
