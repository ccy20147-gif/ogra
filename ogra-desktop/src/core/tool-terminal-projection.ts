/**
 * Tool terminal projections shared by the live gateway and crash recovery.
 *
 * `IngressReviewService` owns the terminal effect transition.  This service
 * supplies its in-transaction hook for effects that have a durable
 * `tool_invocations` row, keeping the tool projection (finding/completion,
 * action ledger, and accepted Observation) inseparable from that transition.
 * It deliberately reads only durable ids, hashes and references; tool output
 * plaintext never enters this service.
 */
import * as crypto from 'crypto';
import { OgraDatabase } from './database';
import { DurableRuntimeService } from './durable-runtime-service';
import { EncryptedCapsuleStore } from './capsule-store';
import { canonicalJSON } from './audit-envelope';
import { canonicalToolId } from './tool-broker-types';
import { validateToolOutput } from './tool-schema-validation';
import {
  KnowledgeSearchInput, KnowledgeSearchResult,
  verifyKnowledgeSearchResultAuthority,
} from './knowledge-search-adapter';
import { OgraError, OgraErrorCode } from '../shared/errors';
import { DataClassification } from '../shared/types';

export interface ToolTerminalProjectionResult {
  actionLedgerId: string;
  actionSequenceNo: number;
  observationId: string | null;
}

export interface ToolTerminalProjection {
  postCommitBody: (args: {
    outcomeEventId: string;
    review: {
      effectId: string; findingId: string;
      outcome: 'accepted' | 'quarantined' | 'rejected';
      payloadDigest: string;
    };
  }) => void;
  result: ToolTerminalProjectionResult | null;
}

export class ToolTerminalProjectionService {
  constructor(
    private readonly odb: OgraDatabase,
    private readonly runtime: DurableRuntimeService,
    private readonly capsuleStore: EncryptedCapsuleStore,
  ) {}

  /**
   * Returns null for non-tool effects. Tool effects receive a projection only
   * after the verified result and sealed callback satisfy the immutable T1/T2
   * schema, canonical-id, workspace-binding, and knowledge-scope authority.
   */
  forVerifiedResult(input: {
    effectId: string;
    receiptId: string;
    attemptNo: number;
    workspaceId: string;
    verifiedPayload: unknown;
    leaseHolderId: string;
    leaseVersion: number;
    sourceKind: 'production' | 'recovery';
    ruleVersion: string;
  }): ToolTerminalProjection | null {
    const exists = this.odb.getDB().prepare(
      'SELECT 1 FROM tool_invocations WHERE effect_id = ?',
    ).get(input.effectId);
    if (!exists) return null;

    this.validatePinnedResultAuthority(input);

    let result: ToolTerminalProjectionResult | null = null;
    return {
      get result() { return result; },
      postCommitBody: ({ outcomeEventId, review }) => {
        // Every lookup and write below runs in the finalizer's existing
        // transactionalAppend body. A missing/tampered tool projection aborts
        // the terminal transition rather than creating a partial terminal row.
        const row = this.odb.getDB().prepare(`
          SELECT e.run_id, e.owner_frame_id, e.policy_version_hash,
                 ti.prepared_canonical_tool_id, ti.workspace_binding_id,
                 b.binding_hash,
                 er.result_capsule_ref, er.result_capsule_hash,
                 er.response_hash
            FROM run_effects e
            JOIN tool_invocations ti ON ti.effect_id = e.id
            JOIN workspace_tool_bindings b ON b.id = ti.workspace_binding_id
            JOIN effect_receipts er ON er.id = ? AND er.effect_id = e.id
           WHERE e.id = ? AND er.attempt_no = ?
        `).get(input.receiptId, input.effectId, input.attemptNo) as {
          run_id: string; owner_frame_id: string; policy_version_hash: string | null;
          prepared_canonical_tool_id: string; workspace_binding_id: string; binding_hash: string;
          result_capsule_ref: string; result_capsule_hash: string; response_hash: string;
        } | undefined;
        if (!row || !/^tid_[a-f0-9]{64}$/.test(row.prepared_canonical_tool_id)
            || !/^[a-f0-9]{64}$/.test(row.response_hash)) {
          throw new Error('tool terminal projection missing durable invocation/receipt authority');
        }

        const now = new Date().toISOString();
        const invocationUpdate = this.odb.getDB().prepare(`
          UPDATE tool_invocations
             SET current_approval_id = NULL, ingress_finding_id = ?, completed_at = ?
           WHERE effect_id = ? AND ingress_finding_id IS NULL AND completed_at IS NULL
        `).run(review.findingId, now, input.effectId);
        if (invocationUpdate.changes !== 1) {
          throw new Error(`tool terminal projection invocation CAS lost for ${input.effectId}`);
        }

        let observationId: string | null = null;
        if (review.outcome === 'accepted') {
          observationId = `obs_${crypto.randomBytes(6).toString('hex')}`;
          this.odb.getDB().prepare(`
            INSERT INTO tool_observations
              (id, run_id, effect_id, receipt_id, ingress_finding_id,
               result_capsule_ref, result_capsule_hash, payload_digest,
               created_event_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            observationId, row.run_id, input.effectId, input.receiptId,
            review.findingId, row.result_capsule_ref, row.result_capsule_hash,
            review.payloadDigest, outcomeEventId, now,
          );
        }

        const seqRow = this.odb.getDB().prepare(
          'SELECT COALESCE(MAX(sequence_no), 0) AS s FROM action_ledger WHERE run_id = ?',
        ).get(row.run_id) as { s: number };
        const actionSequenceNo = seqRow.s + 1;
        const actionLedgerId = `act_${crypto.randomBytes(6).toString('hex')}`;
        this.odb.getDB().prepare(`
          INSERT INTO action_ledger
            (id, run_id, frame_id, effect_id, attempt_no, sequence_no,
             action_type, action_target, source_kind, payload_digest,
             policy_version_hash, scope_hash, approval_id, recovery_approval_id,
             lease_holder_id, lease_version, rule_version, outcome_summary, l1_event_id)
          VALUES (?, ?, ?, ?, ?, ?, 'tool_call', ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)
        `).run(
          actionLedgerId, row.run_id, row.owner_frame_id, input.effectId,
          input.attemptNo, actionSequenceNo,
          `tool:${row.prepared_canonical_tool_id}`, input.sourceKind,
          review.payloadDigest, row.policy_version_hash, row.binding_hash,
          input.leaseHolderId, input.leaseVersion, input.ruleVersion,
          `tool_invocation_${review.outcome}`, outcomeEventId,
        );
        this.odb.getDB().prepare(`
          INSERT INTO audit_edges
            (id, run_id, from_kind, from_id, relation, to_kind, to_id,
             source_event_id, created_at)
          VALUES (?, ?, 'frame', ?, 'has_action_ledger', 'event', ?, ?, ?)
        `).run(
          `edg_${crypto.randomBytes(6).toString('hex')}`,
          row.run_id, row.owner_frame_id, outcomeEventId, outcomeEventId, now,
        );
        result = { actionLedgerId, actionSequenceNo, observationId };
      },
    };
  }

  private validatePinnedResultAuthority(input: {
    effectId: string;
    receiptId: string;
    attemptNo: number;
    workspaceId: string;
    verifiedPayload: unknown;
  }): void {
    const reject = (): never => {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        'tool result does not satisfy pinned terminal authority');
    };
    const row = this.odb.getDB().prepare(`
      SELECT e.run_id, e.capsule_fingerprint, e.payload_fingerprint,
             ar.workspace_id AS run_workspace_id,
             ti.tool_version_id, ti.input_hash,
             ti.prepared_descriptor_hash, ti.prepared_input_schema_hash,
             ti.prepared_binding_hash, ti.prepared_canonical_tool_id,
             ti.prepared_output_schema_json, ti.prepared_output_schema_hash,
             v.descriptor_id, v.source_version, v.descriptor_hash,
             v.input_schema_hash, v.output_schema_json,
             d.source_kind, d.source_ref,
             b.workspace_id AS binding_workspace_id,
             b.tool_version_id AS binding_tool_version_id,
             b.binding_hash, b.policy_id, b.approval_mode,
             b.constraints_json
        FROM run_effects e
        JOIN agent_runs ar ON ar.id = e.run_id
        JOIN tool_invocations ti ON ti.effect_id = e.id
        JOIN tool_versions v ON v.id = ti.tool_version_id
        JOIN tool_descriptors d ON d.id = v.descriptor_id
        JOIN workspace_tool_bindings b ON b.id = ti.workspace_binding_id
       WHERE e.id = ?
    `).get(input.effectId) as {
      run_id: string; capsule_fingerprint: string | null;
      payload_fingerprint: string | null; run_workspace_id: string;
      tool_version_id: string; input_hash: string;
      prepared_descriptor_hash: string | null;
      prepared_input_schema_hash: string | null;
      prepared_binding_hash: string | null;
      prepared_canonical_tool_id: string | null;
      prepared_output_schema_json: string | null;
      prepared_output_schema_hash: string | null;
      descriptor_id: string; source_version: string; descriptor_hash: string;
      input_schema_hash: string; output_schema_json: string | null;
      source_kind: string; source_ref: string;
      binding_workspace_id: string; binding_tool_version_id: string;
      binding_hash: string; policy_id: string | null;
      approval_mode: string; constraints_json: string;
    } | undefined;
    if (!row) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        'tool result does not satisfy pinned terminal authority');
    }
    if (!row.capsule_fingerprint
        || !row.prepared_binding_hash
        || !row.prepared_output_schema_json
        || !row.prepared_output_schema_hash
        || !row.output_schema_json
        || row.run_workspace_id !== input.workspaceId
        || row.binding_workspace_id !== input.workspaceId
        || row.binding_tool_version_id !== row.tool_version_id
        || row.payload_fingerprint !== row.input_hash
        || row.prepared_descriptor_hash !== row.descriptor_hash
        || row.prepared_input_schema_hash !== row.input_schema_hash
        || row.prepared_binding_hash !== row.binding_hash
        || row.source_kind !== 'builtin'
        || row.source_ref !== 'core:knowledge') reject();
    const capsuleFingerprint = row.capsule_fingerprint as string;
    const preparedBindingHash = row.prepared_binding_hash as string;
    const preparedOutputSchemaJson = row.prepared_output_schema_json as string;
    const preparedOutputSchemaHash = row.prepared_output_schema_hash as string;
    const outputSchemaJson = row.output_schema_json as string;

    const canonicalId = canonicalToolId(
      'builtin', row.source_ref, row.descriptor_id, row.source_version,
    );
    if (row.prepared_canonical_tool_id !== canonicalId) reject();

    let outputSchema: unknown;
    let constraints: unknown;
    try {
      outputSchema = JSON.parse(preparedOutputSchemaJson);
      constraints = JSON.parse(row.constraints_json);
      const canonicalSchema = canonicalJSON(outputSchema);
      if (canonicalSchema !== preparedOutputSchemaJson
          || canonicalSchema !== canonicalJSON(JSON.parse(outputSchemaJson))
          || crypto.createHash('sha256').update(canonicalSchema).digest('hex')
            !== preparedOutputSchemaHash) reject();
    } catch (err) {
      if (err instanceof OgraError) throw err;
      reject();
    }

    const payload = input.verifiedPayload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || !Object.prototype.hasOwnProperty.call(payload, 'result')) reject();
    const result = (payload as Record<string, unknown>).result;
    validateToolOutput(outputSchema, result);

    const callback = this.capsuleStore.openVerifiedCallbackForEffect<{
      payload?: unknown;
    }>({
      effectId: input.effectId,
      attemptNo: input.attemptNo,
      expectedFingerprint: capsuleFingerprint,
    });
    const args = callback.payload?.payload;
    if (!args || typeof args !== 'object' || Array.isArray(args)
        || crypto.createHash('sha256').update(canonicalJSON(args)).digest('hex')
          !== row.input_hash) reject();

    verifyKnowledgeSearchResultAuthority({
      result: result as KnowledgeSearchResult,
      arguments: args as KnowledgeSearchInput,
      expectedWorkspaceId: input.workspaceId,
      binding: {
        workspaceId: row.binding_workspace_id,
        toolVersionId: row.binding_tool_version_id,
        preparedToolVersionId: row.tool_version_id,
        bindingHash: row.binding_hash,
        preparedBindingHash,
        policyId: row.policy_id,
        approvalMode: row.approval_mode,
        constraints,
      },
      lookupHitAuthority: (hit) => (this.odb.getDB().prepare(`
        SELECT c.classification_snapshot AS classification
          FROM document_chunks c
          JOIN documents d ON d.id = c.document_id
          JOIN knowledge_bases kb ON kb.id = d.knowledge_base_id
         WHERE c.id = ? AND d.id = ? AND c.workspace_id = ?
           AND d.workspace_id = ? AND kb.workspace_id = ? AND kb.id = ?
      `).get(
        hit.chunkId, hit.documentId, input.workspaceId, input.workspaceId,
        input.workspaceId, hit.knowledgeBaseId,
      ) as { classification: DataClassification } | undefined) ?? null,
    });
  }
}
