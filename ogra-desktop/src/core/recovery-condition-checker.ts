/**
 * Series 1B M1 Round 7: Default RecoveryConditionChecker
 * implementation. Re-evaluates approval / policy / route before
 * any recovery retry.
 *
 * Round 7 update: instead of just confirming that the
 * previously-persisted approval row is still present, this
 * checker actually invokes the current `PolicyService` and
 * `RouteService` to verify the policy and route still apply.
 * If the policy version changed (i.e. rules were tightened)
 * or the route decision is no longer reachable from the
 * current policy, the retry is blocked.
 *
 * The recovery layer holds a reference to this checker so the
 * fail-closed gate is identical to Sequence-0's runtime
 * loadApproval: any drift in approval (revoked / expired /
 * fingerprint / scope / policy_version_hash mismatch) or in
 * the route decision (deleted / drift / mismatch) blocks the
 * retry.
 */
import { OgraDatabase } from './database';
import { PolicyService } from './policy-service';
import { RouteService } from './route-service';
import { DataClassification, RouteDecisionType } from '../shared/types';
import {
  RecoveryConditionChecker,
} from './recovery-service';

export interface RecoveryPolicyRouteInput {
  /**
   * The data classification captured at prepare-time.
   * The checker re-runs policy + route on this snapshot to
   * confirm the persisted decision still holds today.
   */
  workspaceId: string;
  /** The exact high-water classification persisted with the effect's route. */
  dataClassification: DataClassification;
  task: string;
  /** Optional original high-water sources retained by the route decision. */
  highWaterSources?: Array<{ sourceType: string; sourceId: string; classification: string }>;
  /** Provider / model originally requested for this exact route. */
  providerId?: string | null;
  modelId?: string | null;
}

export class DefaultRecoveryConditionChecker
  implements RecoveryConditionChecker
{
  constructor(
    private readonly odb: OgraDatabase,
    private readonly policyService: PolicyService,
    private readonly routeService: RouteService,
    private readonly ctxProvider: (input: {
      runId: string;
      routeDecisionId: string;
    }) => RecoveryPolicyRouteInput | null,
    /** Live authority owned by RedactionService, never a checker fallback. */
    private readonly getCurrentRedactionRuleVersion: () => string,
  ) {}

  async check(input: {
    effect: { id: string; runId: string; routeDecisionId: string | null;
              payloadFingerprint: string; capsuleFingerprint: string | null;
              callbackCapsuleRef: string | null;
              redactionRuleVersion: string | null; };
    approvalId: string | null;
    policyVersionHash: string | null;
    routeDecisionId: string | null;
    payloadFingerprint: string;
    scopeHash: string | null;
    asOf?: string;
  }): Promise<{
    ok: boolean;
    reason?:
      | 'approval_missing'
      | 'approval_expired'
      | 'approval_revoked'
      | 'approval_fingerprint_mismatch'
      | 'approval_scope_mismatch'
      | 'approval_policy_version_mismatch'
      | 'route_policy_drift'
      | 'route_decision_missing'
      | 'redaction_rule_version_mismatch';
    detail?: string;
  }> {
    const asOf = input.asOf ?? new Date().toISOString();
    type Reason =
      | 'approval_missing'
      | 'approval_expired'
      | 'approval_revoked'
      | 'approval_fingerprint_mismatch'
      | 'approval_scope_mismatch'
      | 'approval_policy_version_mismatch'
      | 'route_policy_drift'
      | 'route_decision_missing'
      | 'redaction_rule_version_mismatch';
    const fail = (reason: Reason, detail: string) => ({
      ok: false as const, reason, detail,
    });

    // First: re-evaluate the policy + route at this effect's exact
    // persisted route. A run can contain several route decisions, so using
    // its most recent row would authorize one effect with another effect's
    // classification/provider/model context.
    let policyVersionCurrent: string | null = null;
    try {
      policyVersionCurrent = this.policyService.getPolicyVersionHash();
    } catch {
      // If the policy service can't produce a hash (no policies
      // loaded) we cannot prove the policy still permits the
      // egress. Fail-closed.
      return fail('route_policy_drift',
        'current policy_service.getPolicyVersionHash() failed');
    }

    // Approval binding checks (when an approval was used at
    // prepare-time).
    if (input.approvalId) {
      const row = this.odb.getDB().prepare(`
        SELECT id, run_id, workspace_id, decision, expires_at,
               payload_fingerprint, scope_hash, policy_version_hash,
               redaction_rule_version
          FROM approvals WHERE id = ?
      `).get(input.approvalId) as
        { id: string; run_id: string; workspace_id: string; decision: string; expires_at: string | null;
          payload_fingerprint: string | null; scope_hash: string | null;
          policy_version_hash: string | null;
          redaction_rule_version: string | null; } | undefined;
      if (!row) {
        return fail('approval_missing',
          `approval ${input.approvalId} not found`);
      }
      if (row.run_id !== input.effect.runId) {
        return fail('approval_missing',
          `approval ${input.approvalId} is not bound to run ${input.effect.runId}`);
      }
      if (row.decision !== 'approved') {
        return fail('approval_revoked',
          `approval ${input.approvalId} decision=${row.decision}`);
      }
      if (row.expires_at && row.expires_at <= asOf) {
        return fail('approval_expired',
          `approval ${input.approvalId} expired at ${row.expires_at}`);
      }
      if (!row.payload_fingerprint
          || row.payload_fingerprint !== input.payloadFingerprint) {
        return fail('approval_fingerprint_mismatch',
          `approval ${input.approvalId} fingerprint drift`);
      }
      if (input.scopeHash && (!row.scope_hash
          || row.scope_hash !== input.scopeHash)) {
        return fail('approval_scope_mismatch',
          `approval ${input.approvalId} scope drift`);
      }
      // Compare against the CURRENT policy version (not the
      // snapshot on the effect row). If the policy was tightened
      // during the recovery window, the old approval's
      // policy_version_hash will not match.
      if (!row.policy_version_hash
          || row.policy_version_hash !== policyVersionCurrent) {
        return fail('approval_policy_version_mismatch',
          `approval ${input.approvalId} policy_version_hash=${row.policy_version_hash?.slice(0, 12)}… current=${policyVersionCurrent.slice(0, 12)}…`);
      }
    }

    // Every durable effect has a route binding. Missing it is not a valid
    // recovery context: accepting it would turn a damaged row into an
    // unscoped egress retry.
    if (!input.routeDecisionId) {
      return fail('route_decision_missing',
        `effect ${input.effect.id} has no route_decision_id`);
    }

    const route = this.odb.getDB().prepare(`
      SELECT id, run_id, route, provider_id, model_id,
             policy_evaluation_id, data_classification,
             high_water_sources_json, requires_user_approval
        FROM route_decisions WHERE id = ? AND run_id = ?
    `).get(input.routeDecisionId, input.effect.runId) as
      { id: string; run_id: string | null; route: string;
        provider_id: string | null; model_id: string | null;
        policy_evaluation_id: string | null;
        data_classification: string;
        high_water_sources_json: string | null;
        requires_user_approval: number | null; } | undefined;
    if (!route) {
      return fail('route_decision_missing',
        `route_decision ${input.routeDecisionId} is missing or belongs to another run`);
    }
    if (route.route === RouteDecisionType.Blocked) {
      return fail('route_policy_drift',
        `effect ${input.effect.id} is bound to a blocked route`);
    }
    if (route.requires_user_approval && !input.approvalId) {
      return fail('route_policy_drift',
        `route_decision ${route.id} requires approval but effect has no approval binding`);
    }

    const requiresRedactionEvidence = route.route === RouteDecisionType.Redact_Then_Egress;
    if (requiresRedactionEvidence) {
      let redactionRuleVersionCurrent: string;
      try {
        redactionRuleVersionCurrent = this.getCurrentRedactionRuleVersion();
      } catch {
        return fail('redaction_rule_version_mismatch',
          'current redaction rule provider failed');
      }
      if (!redactionRuleVersionCurrent || !input.effect.redactionRuleVersion
          || input.effect.redactionRuleVersion !== redactionRuleVersionCurrent) {
        return fail('redaction_rule_version_mismatch',
          `effect ${input.effect.id} redaction_rule_version=${input.effect.redactionRuleVersion ?? '(missing)'} current=${redactionRuleVersionCurrent || '(missing)'}`);
      }
      const approvalRow = this.odb.getDB().prepare(
        'SELECT redaction_rule_version FROM approvals WHERE id = ?',
      ).get(input.approvalId) as { redaction_rule_version: string | null } | undefined;
      if (!approvalRow || approvalRow.redaction_rule_version !== redactionRuleVersionCurrent) {
        return fail('redaction_rule_version_mismatch',
          `redaction route ${route.id} approval provenance is missing or stale`);
      }
      const approvalEvidence = this.odb.getDB().prepare(`
        SELECT id FROM approvals
         WHERE id = ? AND redaction_rule_version = ?
      `).get(input.approvalId, redactionRuleVersionCurrent) as { id: string } | undefined;
      if (!approvalEvidence) {
        return fail('redaction_rule_version_mismatch',
          `redaction route ${route.id} has no approval evidence for current rule version`);
      }
      const redactionEvidence = this.odb.getDB().prepare(`
        SELECT id FROM redaction_records
         WHERE run_id = ? AND approval_id = ? AND rule_version = ? AND after_hash = ?
         ORDER BY created_at DESC LIMIT 1
      `).get(input.effect.runId, input.approvalId, redactionRuleVersionCurrent,
        input.payloadFingerprint) as { id: string } | undefined;
      if (!redactionEvidence) {
        return fail('redaction_rule_version_mismatch',
          `redaction route ${route.id} has no matching redaction evidence`);
      }
      const egressEvidence = this.odb.getDB().prepare(`
        SELECT id FROM egress_records
         WHERE run_id = ? AND route_decision_id = ? AND approval_id = ?
           AND redaction_rule_version = ? AND payload_hash = ?
         ORDER BY created_at DESC LIMIT 1
      `).get(input.effect.runId, route.id, input.approvalId,
        redactionRuleVersionCurrent, input.payloadFingerprint) as { id: string } | undefined;
      if (!egressEvidence) {
        return fail('redaction_rule_version_mismatch',
          `redaction route ${route.id} has no matching egress evidence`);
      }
    }

    const ctx = this.ctxProvider({
      runId: input.effect.runId,
      routeDecisionId: route.id,
    });
    if (!ctx || !ctx.workspaceId || !ctx.task) {
      return fail('route_policy_drift',
        `unable to load complete policy context for route_decision ${route.id}`);
    }
    // The context provider is a convenience for the run task/workspace only.
    // Route-sensitive values are always taken from the exact persisted route
    // row above, never from a newer decision in the same run.
    if (ctx.dataClassification !== route.data_classification
        || (ctx.providerId ?? null) !== route.provider_id
        || (ctx.modelId ?? null) !== route.model_id) {
      return fail('route_policy_drift',
        `persisted route context drift for route_decision ${route.id}`);
    }

    let highWaterSources: Array<{ sourceType: string; sourceId: string; classification: string }> | undefined;
    if (route.high_water_sources_json) {
      try {
        const parsed = JSON.parse(route.high_water_sources_json);
        if (!Array.isArray(parsed)) throw new Error('not an array');
        highWaterSources = parsed;
      } catch {
        return fail('route_policy_drift',
          `route_decision ${route.id} has invalid high-water evidence`);
      }
    }

    try {
      const isCloudRoute = route.route === RouteDecisionType.Cloud
        || route.route === RouteDecisionType.Hybrid
        || route.route === RouteDecisionType.Redact_Then_Egress;
      // RouteService invokes PolicyService internally. We pass the same
      // classification/provider/model and the original compute intent
      // represented by this effect's route, then demand an exact route match.
      const reEvaluated = await this.routeService.evaluateRoute({
        workspaceId: ctx.workspaceId,
        dataClassification: route.data_classification as DataClassification,
        providerId: route.provider_id ?? undefined,
        modelId: route.model_id ?? undefined,
        requestedCompute: isCloudRoute ? 'cloud' : 'local',
        requiresCloud: isCloudRoute,
        hasUserApproval: Boolean(input.approvalId),
        highWaterSources,
      });
      if (reEvaluated.route !== route.route) {
        return fail('route_policy_drift',
          `persisted route=${route.route} but current policy/route resolves ${reEvaluated.route}`);
      }
    } catch (err) {
      return fail('route_policy_drift',
        `current route evaluation failed: ${(err as Error)?.message ?? 'unknown'}`);
    }

    return { ok: true };
  }
}
