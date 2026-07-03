import { OgraDatabase } from './database';
import * as crypto from 'crypto';
import { DataClassification, WorkspaceType } from '../shared/types';
import { OgraError, OgraErrorCode } from '../shared/errors';

export interface WorkspaceRow {
  id: string;
  name: string;
  type: string;
  default_data_classification: string;
  created_at: string;
  updated_at: string;
}

export interface RunEventRow {
  id: string;
  run_id: string;
  workspace_id: string;
  sequence: number;
  event_type: string;
  event_payload_json: string;
  payload_hash: string | null;
  previous_hash: string;
  event_hash: string;
  policy_version_hash: string | null;
  redaction_rule_version: string | null;
  created_at: string;
}

export interface RouteDecisionRow {
  id: string;
  run_id: string;
  route: string;
  data_classification: string;
  high_water_sources_json: string | null;
  reason_json: string | null;
  requires_user_approval: number;
  provider_id: string | null;
  model_id: string | null;
  cloud_payload_hash: string | null;
  created_at: string;
}

const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

/**
 * Database service providing typed query methods for Ogra Core.
 */
export class DatabaseService {
  private db: OgraDatabase;

  constructor(appDataDir: string) {
    this.db = new OgraDatabase(appDataDir);
    this.db.runMigrations();
  }

  getRawDB() {
    return this.db.getDB();
  }

  close(): void {
    this.db.close();
  }

  // ---- Workspace Queries ----

  createWorkspace(name: string, type: WorkspaceType, defaultClassification: DataClassification): WorkspaceRow {
    const id = `ws_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();
    this.db.getDB().prepare(`
      INSERT INTO workspaces (id, name, type, default_data_classification, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, name, type, defaultClassification, now, now);
    return this.getWorkspace(id)!;
  }

  listWorkspaces(): WorkspaceRow[] {
    return this.db.getDB().prepare('SELECT * FROM workspaces ORDER BY created_at DESC').all() as WorkspaceRow[];
  }

  getWorkspace(id: string): WorkspaceRow | undefined {
    return this.db.getDB().prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow | undefined;
  }

  updateWorkspaceClassification(id: string, classification: DataClassification): void {
    const now = new Date().toISOString();
    this.db.getDB().prepare(`
      UPDATE workspaces SET default_data_classification = ?, updated_at = ? WHERE id = ?
    `).run(classification, now, id);
  }

  // ---- Run Event Queries (append-only with hash chain) ----

  appendRunEvent(
    runId: string,
    workspaceId: string,
    eventType: string,
    eventPayload: Record<string, unknown>,
    policyVersionHash?: string,
    redactionRuleVersion?: string,
  ): RunEventRow {
    // Get next sequence
    const lastSeq = this.db.getDB().prepare(
      'SELECT MAX(sequence) as seq FROM run_events WHERE run_id = ?'
    ).get(runId) as { seq: number | null };
    const seq = (lastSeq?.seq ?? 0) + 1;

    // Get previous event hash
    const prevEvent = this.db.getDB().prepare(
      'SELECT event_hash FROM run_events WHERE run_id = ? ORDER BY sequence DESC LIMIT 1'
    ).get(runId) as { event_hash: string } | undefined;
    const previousHash = prevEvent?.event_hash ?? GENESIS_HASH;

    // Calculate payload hash and event hash
    const canonicalJson = JSON.stringify(eventPayload, Object.keys(eventPayload).sort());
    const payloadHash = crypto.createHash('sha256').update(canonicalJson).digest('hex');
    const hashInput = canonicalJson + previousHash;
    const eventHash = crypto.createHash('sha256').update(hashInput).digest('hex');

    const id = `evt_${Date.now()}_${seq}_${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();

    this.db.getDB().prepare(`
      INSERT INTO run_events (id, run_id, workspace_id, sequence, event_type,
        event_payload_json, payload_hash, previous_hash, event_hash,
        policy_version_hash, redaction_rule_version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, runId, workspaceId, seq, eventType, JSON.stringify(eventPayload),
      payloadHash, previousHash, eventHash, policyVersionHash || null, redactionRuleVersion || null, now);

    return {
      id, run_id: runId, workspace_id: workspaceId, sequence: seq, event_type: eventType,
      event_payload_json: JSON.stringify(eventPayload), payload_hash: payloadHash,
      previous_hash: previousHash, event_hash: eventHash,
      policy_version_hash: policyVersionHash || null, redaction_rule_version: redactionRuleVersion || null,
      created_at: now,
    };
  }

  getRunEvents(runId: string, limit = 100, offset = 0): RunEventRow[] {
    return this.db.getDB().prepare(`
      SELECT * FROM run_events WHERE run_id = ? ORDER BY sequence ASC LIMIT ? OFFSET ?
    `).all(runId, limit, offset) as RunEventRow[];
  }

  getWorkspaceEvents(workspaceId: string, limit = 100): RunEventRow[] {
    return this.db.getDB().prepare(`
      SELECT * FROM run_events WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(workspaceId, limit) as RunEventRow[];
  }

  verifyRunChain(runId: string): { valid: boolean; brokenAt?: number; errors: string[] } {
    const events = this.db.getDB().prepare(
      'SELECT * FROM run_events WHERE run_id = ? ORDER BY sequence ASC'
    ).all(runId) as RunEventRow[];

    const errors: string[] = [];
    for (let i = 0; i < events.length; i++) {
      const evt = events[i];

      // Check sequence
      if (evt.sequence !== i + 1) {
        errors.push(`Event ${evt.id}: expected sequence ${i + 1}, got ${evt.sequence}`);
      }

      // Check previous_hash
      const expectedPrevHash = i === 0 ? GENESIS_HASH : events[i - 1].event_hash;
      if (evt.previous_hash !== expectedPrevHash) {
        errors.push(`Event ${evt.id}: previous_hash mismatch`);
        return { valid: false, brokenAt: i, errors };
      }

      // Recompute event_hash
      const payload = JSON.parse(evt.event_payload_json);
      const canonicalJson = JSON.stringify(payload, Object.keys(payload).sort());
      const hashInput = canonicalJson + evt.previous_hash;
      const recomputedHash = crypto.createHash('sha256').update(hashInput).digest('hex');
      if (evt.event_hash !== recomputedHash) {
        errors.push(`Event ${evt.id}: event_hash mismatch`);
        return { valid: false, brokenAt: i, errors };
      }
    }

    return { valid: errors.length === 0, errors };
  }

  // ---- Route Decision Queries ----

  storeRouteDecision(decision: {
    id: string;
    runId: string;
    route: string;
    dataClassification: string;
    highWaterSources: string[];
    reasons: string[];
    localSteps: string[];
    cloudSteps: string[];
    requiresUserApproval: boolean;
    providerId?: string;
    modelId?: string;
    cloudPayloadHash?: string;
    incidentIds: string[];
  }): void {
    const now = new Date().toISOString();
    this.db.getDB().prepare(`
      INSERT INTO route_decisions (id, run_id, route, data_classification,
        high_water_sources_json, reason_json, local_steps_json, cloud_steps_json,
        requires_user_approval, provider_id, model_id, cloud_payload_hash,
        incident_ids_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      decision.id, decision.runId, decision.route, decision.dataClassification,
      JSON.stringify(decision.highWaterSources),
      JSON.stringify(decision.reasons),
      JSON.stringify(decision.localSteps),
      JSON.stringify(decision.cloudSteps),
      decision.requiresUserApproval ? 1 : 0,
      decision.providerId || null,
      decision.modelId || null,
      decision.cloudPayloadHash || null,
      JSON.stringify(decision.incidentIds),
      now,
    );
  }

  getRouteDecision(runId: string): RouteDecisionRow | undefined {
    return this.db.getDB().prepare(
      'SELECT * FROM route_decisions WHERE run_id = ?'
    ).get(runId) as RouteDecisionRow | undefined;
  }

  // ---- Policy Queries ----

  storePolicyEvaluation(policyEval: {
    id: string;
    runId: string;
    policyId?: string;
    inputSnapshot: Record<string, unknown>;
    result: Record<string, unknown>;
    matchedRules: string[];
  }): void {
    this.db.getDB().prepare(`
      INSERT INTO policy_evaluations (id, run_id, policy_id, input_snapshot_json, result_json, matched_rules_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(policyEval.id, policyEval.runId, policyEval.policyId || null,
      JSON.stringify(policyEval.inputSnapshot), JSON.stringify(policyEval.result),
      JSON.stringify(policyEval.matchedRules));
  }

  // ---- Model Provider Queries ----

  listProviders(): Array<{
    id: string; kind: string; name: string; endpoint: string; is_local: number;
    data_retention_policy: string | null; training_opt_out: number | null;
    region: string | null; zero_data_retention_supported: number | null;
    supports_streaming: number; supports_tool_calling: number; enabled: number;
  }> {
    return this.db.getDB().prepare('SELECT * FROM model_providers ORDER BY name').all() as any[];
  }

  addProvider(provider: {
    id: string; kind: string; name: string; endpoint: string; isLocal: boolean;
  }): void {
    this.db.getDB().prepare(`
      INSERT INTO model_providers (id, kind, name, endpoint, is_local, supports_streaming, enabled)
      VALUES (?, ?, ?, ?, ?, 1, 1)
    `).run(provider.id, provider.kind, provider.name, provider.endpoint, provider.isLocal ? 1 : 0);
  }

  // ---- Incident Queries ----

  createIncident(incident: {
    id: string; workspaceId: string; runId?: string;
    incidentType: string; severity: string; summary: string;
    evidenceEventIds: string[];
  }): void {
    this.db.getDB().prepare(`
      INSERT INTO incidents (id, workspace_id, run_id, incident_type, severity, summary, evidence_event_ids_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(incident.id, incident.workspaceId, incident.runId || null,
      incident.incidentType, incident.severity, incident.summary,
      JSON.stringify(incident.evidenceEventIds));
  }

  listIncidents(workspaceId?: string): any[] {
    if (workspaceId) {
      return this.db.getDB().prepare(
        'SELECT * FROM incidents WHERE workspace_id = ? ORDER BY created_at DESC'
      ).all(workspaceId);
    }
    return this.db.getDB().prepare(
      'SELECT * FROM incidents ORDER BY created_at DESC'
    ).all();
  }

  // ---- Knowledge Base Queries ----

  createKnowledgeBase(kb: {
    id: string; workspaceId: string; name: string; rootPath: string; classification: string;
  }): void {
    this.db.getDB().prepare(`
      INSERT INTO knowledge_bases (id, workspace_id, name, root_path, classification, indexing_status)
      VALUES (?, ?, ?, ?, ?, 'queued')
    `).run(kb.id, kb.workspaceId, kb.name, kb.rootPath, kb.classification);
  }

  listKnowledgeBases(workspaceId: string): any[] {
    return this.db.getDB().prepare(
      'SELECT * FROM knowledge_bases WHERE workspace_id = ? ORDER BY created_at DESC'
    ).all(workspaceId);
  }

  updateKnowledgeBaseIndexStatus(id: string, status: string): void {
    const now = new Date().toISOString();
    this.db.getDB().prepare(`
      UPDATE knowledge_bases SET indexing_status = ?, last_indexed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(status, status === 'succeeded' ? now : null, now, id);
  }

  // ---- Agent Run Queries ----

  storeRun(run: {
    id: string;
    workspaceId: string;
    task: string;
    status: string;
    startedAt: string;
    completedAt?: string;
  }): void {
    this.db.getDB().prepare(`
      INSERT OR REPLACE INTO agent_runs (id, workspace_id, task, status, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(run.id, run.workspaceId, run.task, run.status, run.startedAt, run.completedAt || null);
  }

  updateRunStatus(id: string, status: string, completedAt?: string): void {
    const now = completedAt || new Date().toISOString();
    this.db.getDB().prepare(`
      UPDATE agent_runs SET status = ?, completed_at = ? WHERE id = ?
    `).run(status, status === 'completed' || status === 'failed' || status === 'cancelled' ? now : null, id);
  }

  // ---- Model Call Queries ----

  storeModelCall(call: {
    id: string;
    runId: string;
    status: string;
    adapterKind: string;
    providerId: string;
    modelId: string;
    routeDecisionId?: string;
    isCloud: boolean;
    promptHash?: string;
    requestPayloadHash?: string;
    uploadedPayloadHash?: string;
    tokenUsage?: { prompt: number; completion: number; total: number };
    errorCode?: string;
    startedAt: string;
    completedAt?: string;
  }): void {
    this.db.getDB().prepare(`
      INSERT INTO model_calls (id, run_id, status, adapter_kind, provider_id, model_id,
        route_decision_id, is_cloud, prompt_hash, request_payload_hash, uploaded_payload_hash,
        token_usage_json, error_code, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      call.id, call.runId, call.status, call.adapterKind, call.providerId, call.modelId,
      call.routeDecisionId || null, call.isCloud ? 1 : 0,
      call.promptHash || null, call.requestPayloadHash || null, call.uploadedPayloadHash || null,
      call.tokenUsage ? JSON.stringify(call.tokenUsage) : null,
      call.errorCode || null, call.startedAt, call.completedAt || null,
    );
  }

  getModelCalls(runId: string): any[] {
    return this.db.getDB().prepare(
      'SELECT * FROM model_calls WHERE run_id = ? ORDER BY started_at'
    ).all(runId);
  }

  getCloudCallCount(workspaceId: string): { total: number; byRun: Array<{ runId: string; count: number }> } {
    const calls = this.db.getDB().prepare(
      'SELECT run_id, COUNT(*) as count FROM model_calls WHERE is_cloud = 1 GROUP BY run_id'
    ).all() as any[];
    return {
      total: calls.reduce((sum: number, c: any) => sum + c.count, 0),
      byRun: calls,
    };
  }
}
