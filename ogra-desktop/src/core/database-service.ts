import { OgraDatabase } from './database';
import * as crypto from 'crypto';
import { DataClassification, WorkspaceType } from '../shared/types';
import { OgraError, OgraErrorCode } from '../shared/errors';
import {
  canonicalJSON,
  composeV2Envelope,
  envelopeV1Hash,
  envelopeV2Hash,
  GENESIS_HASH,
  HASH_ENVELOPE_VERSION_V1,
  HASH_ENVELOPE_VERSION_V2,
} from './audit-envelope';

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
  hash_envelope_version?: string | null;
  created_at: string;
}

export interface RouteDecisionRow {
  id: string;
  run_id: string;
  route: string;
  data_classification: string;
  high_water_sources_json: string | null;
  reason_json: string | null;
  local_steps_json: string | null;
  cloud_steps_json: string | null;
  requires_user_approval: number;
  approval_id: string | null;
  policy_evaluation_id: string | null;
  provider_id: string | null;
  incident_ids_json: string | null;
  model_id: string | null;
  cloud_payload_hash: string | null;
  created_at: string;
}

// GENESIS_HASH — imported from audit-service.ts

/**
 * Database service providing typed query methods for Ogra Core.
 */
export class DatabaseService {
  private db: OgraDatabase;

  constructor(appDataDir: string) {
    this.db = new OgraDatabase(appDataDir);
    this.db.runMigrations();
  }

  /**
   * Sequence 1B Milestone 1 — expose the underlying
   * OgraDatabase for the durable runtime kernel. The kernel is
   * a separate service from DatabaseService (it owns its own
   * state machines) but they share the same SQLite database.
   * The OgraDatabase handle is the bridge.
   */
  getOgraDatabase(): OgraDatabase {
    return this.db;
  }

  /**
   * @deprecated Use typed query methods instead of raw DB access.
   * Direct DB manipulation bypasses validation, audit, and FK constraints.
   * Only use for migration bootstrap or test cleanup.
   */
  getRawDB(): any {
    return this.db.getDB();
  }

  initialize(): void {
    // Placeholder — migrations run in constructor
  }

  close(): void {
    this.db.close();
  }

  /**
   * Update a single field on a run_event row by ID.
   * Intended for test scenarios that need to tamper with event data
   * (e.g. verifying that chain verification detects corruption).
   * This is a controlled alternative to calling getRawDB() directly.
   */
  updateRunEventField(eventId: string, field: string, value: string): void {
    const allowedFields = new Set(['event_payload_json', 'event_hash', 'previous_hash', 'payload_hash']);
    if (!allowedFields.has(field)) {
      throw new Error(`updateRunEventField: field '${field}' is not allowed. Allowed: ${[...allowedFields].join(', ')}`);
    }
    this.db.getDB().prepare(
      `UPDATE run_events SET ${field} = ? WHERE id = ?`
    ).run(value, eventId);
  }



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
    // Use a transaction to ensure atomicity of hash chain append
    return this.db.getDB().transaction(() => this.appendRunEventInTransaction(
      runId, workspaceId, eventType, eventPayload,
      policyVersionHash, redactionRuleVersion,
    ))();
  }

  /**
   * Append an event while the caller already owns the SQLite transaction.
   * This is used when an L0 mutation and its L1 event must commit or roll
   * back together. Callers must not invoke it outside `db.transaction()`.
   */
  appendRunEventInTransaction(
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

      const id = `evt_${Date.now()}_${seq}_${crypto.randomBytes(4).toString('hex')}`;
      const now = new Date().toISOString();
      const v2Enabled = this.db.getDB().prepare(
        "SELECT 1 FROM pragma_table_info('run_events') WHERE name = 'hash_envelope_version'",
      ).get();
      const eventPayloadJson = canonicalJSON(eventPayload);
      const payloadHash = crypto.createHash('sha256').update(eventPayloadJson).digest('hex');
      let eventHash: string;
      let envelopeVersion: string | null = null;
      if (v2Enabled) {
        const composed = composeV2Envelope({
          id, runId, workspaceId, sequence: seq, eventType, eventPayload,
          policyVersionHash: policyVersionHash ?? null,
          redactionRuleVersion: redactionRuleVersion ?? null,
          createdAt: now, previousHash,
        });
        eventHash = composed.eventHash;
        envelopeVersion = composed.envelopeVersion;
        this.db.getDB().prepare(`
          INSERT INTO run_events (id, run_id, workspace_id, sequence, event_type,
            event_payload_json, payload_hash, previous_hash, event_hash,
            hash_envelope_version, policy_version_hash, redaction_rule_version, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, runId, workspaceId, seq, eventType, composed.eventPayloadJson,
          composed.payloadHash, previousHash, eventHash, envelopeVersion,
          policyVersionHash || null, redactionRuleVersion || null, now);
      } else {
        eventHash = envelopeV1Hash(eventPayloadJson, previousHash);
        this.db.getDB().prepare(`
          INSERT INTO run_events (id, run_id, workspace_id, sequence, event_type,
            event_payload_json, payload_hash, previous_hash, event_hash,
            policy_version_hash, redaction_rule_version, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, runId, workspaceId, seq, eventType, eventPayloadJson,
          payloadHash, previousHash, eventHash, policyVersionHash || null, redactionRuleVersion || null, now);
      }

      return {
        id, run_id: runId, workspace_id: workspaceId, sequence: seq, event_type: eventType,
        event_payload_json: eventPayloadJson, payload_hash: payloadHash,
        previous_hash: previousHash, event_hash: eventHash,
        policy_version_hash: policyVersionHash || null, redaction_rule_version: redactionRuleVersion || null,
        hash_envelope_version: envelopeVersion,
        created_at: now,
      };
  }

  getRunEvents(runId: string, limit = 100, offset = 0): RunEventRow[] {
    return this.db.getDB().prepare(`
      SELECT * FROM run_events WHERE run_id = ? ORDER BY sequence ASC LIMIT ? OFFSET ?
    `).all(runId, limit, offset) as RunEventRow[];
  }

  getAllRunEvents(): RunEventRow[] {
    return this.db.getDB().prepare(
      'SELECT * FROM run_events ORDER BY run_id, sequence ASC'
    ).all() as RunEventRow[];
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

      const version = evt.hash_envelope_version ?? HASH_ENVELOPE_VERSION_V1;
      let payloadJson: string;
      try {
        payloadJson = canonicalJSON(JSON.parse(evt.event_payload_json));
      } catch {
        errors.push(`Event ${evt.id}: event_payload_json is invalid JSON`);
        return { valid: false, brokenAt: i, errors };
      }
      // v2 producers always persist canonical JSON. Reject any byte-level
      // alteration (including harmless-looking whitespace/order changes)
      // rather than normalizing it away before validating the envelope.
      // Legacy v1 rows retain their original verifier behavior.
      if (version === HASH_ENVELOPE_VERSION_V2 && evt.event_payload_json !== payloadJson) {
        errors.push(`Event ${evt.id}: event_payload_json is not canonical`);
        return { valid: false, brokenAt: i, errors };
      }
      const recomputedPayloadHash = crypto.createHash('sha256').update(payloadJson).digest('hex');
      if (evt.payload_hash !== recomputedPayloadHash) {
        errors.push(`Event ${evt.id}: payload_hash mismatch`);
        return { valid: false, brokenAt: i, errors };
      }
      let recomputedHash: string;
      if (version === HASH_ENVELOPE_VERSION_V2) {
        recomputedHash = envelopeV2Hash({
          id: evt.id, runId: evt.run_id, workspaceId: evt.workspace_id ?? null,
          sequence: evt.sequence, eventType: evt.event_type, eventPayloadJson: payloadJson,
          payloadHash: evt.payload_hash, policyVersionHash: evt.policy_version_hash,
          redactionRuleVersion: evt.redaction_rule_version, createdAt: evt.created_at,
          previousHash: evt.previous_hash,
        });
      } else if (version === HASH_ENVELOPE_VERSION_V1) {
        recomputedHash = envelopeV1Hash(payloadJson, evt.previous_hash);
      } else {
        errors.push(`Event ${evt.id}: unknown hash_envelope_version ${version}`);
        return { valid: false, brokenAt: i, errors };
      }
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
    approvalId?: string;
    policyEvaluationId?: string;
    providerId?: string;
    modelId?: string;
    cloudPayloadHash?: string;
    incidentIds: string[];
  }): void {
    const now = new Date().toISOString();
    this.db.getDB().prepare(`
      INSERT INTO route_decisions (id, run_id, route, data_classification,
        high_water_sources_json, reason_json, local_steps_json, cloud_steps_json,
        requires_user_approval, approval_id, policy_evaluation_id,
        provider_id, model_id, cloud_payload_hash,
        incident_ids_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      decision.id, decision.runId, decision.route, decision.dataClassification,
      JSON.stringify(decision.highWaterSources),
      JSON.stringify(decision.reasons),
      JSON.stringify(decision.localSteps),
      JSON.stringify(decision.cloudSteps),
      decision.requiresUserApproval ? 1 : 0,
      decision.approvalId || null,
      decision.policyEvaluationId || null,
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

  /** IncidentRecord-compatible row from DB */
  private static mapIncidentRow(row: any): {
    id: string;
    workspaceId: string;
    runId: string;
    incidentType: string;
    severity: string;
    summary: string;
    evidenceEventIds: string[];
    status: string;
    createdAt: string;
    resolvedAt?: string;
  } {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      runId: row.run_id || '',
      incidentType: row.incident_type,
      severity: row.severity,
      summary: row.summary,
      evidenceEventIds: row.evidence_event_ids_json
        ? JSON.parse(row.evidence_event_ids_json)
        : [],
      status: row.status,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at || undefined,
    };
  }

  createIncident(incident: {
    id: string; workspaceId: string; runId?: string;
    incidentType: string; severity: string; summary: string;
    evidenceEventIds: string[];
  }): {
    id: string;
    workspaceId: string;
    runId: string;
    incidentType: string;
    severity: string;
    summary: string;
    evidenceEventIds: string[];
    status: string;
    createdAt: string;
    resolvedAt?: string;
  } {
    const now = new Date().toISOString();
    this.db.getDB().prepare(`
      INSERT INTO incidents (id, workspace_id, run_id, incident_type, severity, summary, evidence_event_ids_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(incident.id, incident.workspaceId, incident.runId || null,
      incident.incidentType, incident.severity, incident.summary,
      JSON.stringify(incident.evidenceEventIds), now);
    return this.getIncident(incident.id)!;
  }

  getIncident(id: string): ReturnType<typeof DatabaseService.mapIncidentRow> | undefined {
    const row = this.db.getDB().prepare(
      'SELECT * FROM incidents WHERE id = ?'
    ).get(id) as any;
    return row ? DatabaseService.mapIncidentRow(row) : undefined;
  }

  listIncidents(workspaceId?: string): ReturnType<typeof DatabaseService.mapIncidentRow>[] {
    let rows: any[];
    if (workspaceId) {
      rows = this.db.getDB().prepare(
        'SELECT * FROM incidents WHERE workspace_id = ? ORDER BY created_at DESC'
      ).all(workspaceId) as any[];
    } else {
      rows = this.db.getDB().prepare(
        'SELECT * FROM incidents ORDER BY created_at DESC'
      ).all() as any[];
    }
    return rows.map(DatabaseService.mapIncidentRow);
  }

  resolveIncident(id: string): void {
    this.db.getDB().prepare(`
      UPDATE incidents SET status = 'resolved', resolved_at = ? WHERE id = ?
    `).run(new Date().toISOString(), id);
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

  // ---- Document Queries (used by RagEngine) ----

  insertDocument(doc: {
    id: string; workspaceId: string; knowledgeBaseId: string;
    filePath: string; fileName: string; extension: string;
    contentHash: string; sizeBytes: number;
    classification: string; classificationSource: string;
  }): void {
    this.db.getDB().prepare(`
      INSERT INTO documents (id, workspace_id, knowledge_base_id, file_path, file_name,
        extension, content_hash, size_bytes, classification, classification_source, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(doc.id, doc.workspaceId, doc.knowledgeBaseId, doc.filePath, doc.fileName,
      doc.extension, doc.contentHash, doc.sizeBytes, doc.classification, doc.classificationSource);
  }

  insertDocumentChunk(chunk: {
    id: string; documentId: string; workspaceId: string;
    content: string; contentHash: string;
    sourceStartOffset: number; sourceEndOffset: number;
    sourceLineStart: number | null; sourceLineEnd: number | null;
    classificationSnapshot: string;
    parserVersion: string; chunkerVersion: string;
    allowedForContext: boolean; instructionalContentDetected: boolean;
  }): void {
    this.db.getDB().prepare(`
      INSERT INTO document_chunks (id, document_id, workspace_id, content, content_hash,
        source_start_offset, source_end_offset, source_line_start, source_line_end,
        classification_snapshot, parser_version, chunker_version,
        allowed_for_context, instructional_content_detected)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(chunk.id, chunk.documentId, chunk.workspaceId, chunk.content, chunk.contentHash,
      chunk.sourceStartOffset, chunk.sourceEndOffset,
      chunk.sourceLineStart, chunk.sourceLineEnd,
      chunk.classificationSnapshot, chunk.parserVersion, chunk.chunkerVersion,
      chunk.allowedForContext ? 1 : 0, chunk.instructionalContentDetected ? 1 : 0);
  }

  insertDocumentChunkFts(content: string, chunkId: string, workspaceId: string): void {
    this.db.getDB().prepare(`
      INSERT INTO document_chunks_fts (content, chunk_id, workspace_id)
      VALUES (?, ?, ?)
    `).run(content, chunkId, workspaceId);
  }

  deleteKnowledgeBaseDocuments(knowledgeBaseId: string): void {
    this.db.getDB().prepare(`
      DELETE FROM document_chunks_fts WHERE chunk_id IN (
        SELECT id FROM document_chunks WHERE document_id IN (
          SELECT id FROM documents WHERE knowledge_base_id = ?
        )
      )
    `).run(knowledgeBaseId);
    this.db.getDB().prepare(`
      DELETE FROM document_chunks WHERE document_id IN (
        SELECT id FROM documents WHERE knowledge_base_id = ?
      )
    `).run(knowledgeBaseId);
    this.db.getDB().prepare(`
      DELETE FROM documents WHERE knowledge_base_id = ?
    `).run(knowledgeBaseId);
  }

  // ---- Agent Run Queries ----

  /**
   * Insert a new run record. MUST NOT silently overwrite an existing run —
   * run evidence (task, started_at) is append-only-by-intent.
   *
   * For status updates on an existing run, use updateRunStatus() instead.
   * This method will throw on conflict to prevent accidental overwrite
   * of run evidence (e.g. on retry, replay, or ID collision).
   */
  storeRun(run: {
    id: string;
    workspaceId: string;
    task: string;
    status: string;
    startedAt: string;
    completedAt?: string;
  }): void {
    this.db.getDB().prepare(`
      INSERT INTO agent_runs (id, workspace_id, task, status, started_at, completed_at)
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
    modelInternalId?: string;
    routeDecisionId?: string;
    isCloud: boolean;
    promptHash?: string;
    requestPayloadHash?: string;
    uploadedPayloadHash?: string;
    httpBodyHash?: string;
    responseHash?: string;
    redactionRuleVersion?: string;
    approvalId?: string;
    policyVersionHash?: string;
    tokenUsage?: { prompt: number; completion: number; total: number };
    errorCode?: string;
    startedAt: string;
    completedAt?: string;
  }): void {
    this.db.getDB().prepare(`
      INSERT INTO model_calls (id, run_id, status, adapter_kind, provider_id, model_id,
        model_internal_id, route_decision_id, is_cloud, prompt_hash, request_payload_hash,
        uploaded_payload_hash, http_body_hash, response_hash, redaction_rule_version, approval_id,
        policy_version_hash, token_usage_json, error_code, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      call.id, call.runId, call.status, call.adapterKind, call.providerId, call.modelId,
      call.modelInternalId ?? null,
      call.routeDecisionId || null, call.isCloud ? 1 : 0,
      call.promptHash || null, call.requestPayloadHash || null, call.uploadedPayloadHash || null,
      call.httpBodyHash || null,
      call.responseHash || null, call.redactionRuleVersion || null, call.approvalId || null,
      call.policyVersionHash || null,
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
