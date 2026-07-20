import { OgraCoreConfig } from './index';
import { WorkspaceService } from './workspace-service';
import { RouteService, RouteDecisionRecord } from './route-service';
import { AuditService } from './audit-service';
import { DatabaseService } from './database-service';
import { PolicyService } from './policy-service';
import { InternalAgentAdapter } from '../edge/internal-agent-adapter';
import { RagEngine } from '../edge/rag-engine';
import { BaseModelAdapter } from './model-adapter';
import { ProviderService } from './provider-service';
import { RedactionService } from './redaction-service';
import { OgraSecretBroker } from './secret-broker';
import { RunEventType, RunStatus } from '../shared/types';
import { OgraError, OgraErrorCode } from '../shared/errors';
import * as crypto from 'crypto';

export interface RunStartRequest {
  workspaceId: string;
  task: string;
  knowledgeBaseIds?: string[];
  /**
   * Requested model id. Resolution order:
   *   1. explicit requestedProvider + requestedModel (if both provided)
   *   2. workspace default model from ProviderService (first local, enabled)
   * If neither is available, the run is blocked with NO_ACCEPTABLE_MODEL.
   */
  requestedModel?: string;
  requestedProvider?: string;
  /**
   * Caller-supplied approval id for egress-bound runs.
   * Sequence 0 enforces: this MUST match a persisted `approvals` row with
   * decision='approved' for the requested scope; otherwise the run is
   * blocked. Renderer-supplied approval ids are NEVER trusted without the
   * canonical database row backing them.
   */
  approvalId?: string;
  /**
   * Sequence 0 — for an approval-required run, the renderer MUST
   * start the run TWICE: first without approvalId (Core parks
   * it at awaiting_approval), then a second time with the same
   * runId + approvalId to actually drive the model. resumeRunId
   * identifies the first call's runId; the second call reuses
   * that row in agent_runs so the hash chain stays bounded to
   * one run.
   */
  resumeRunId?: string;
  // P0 #1: payloadFingerprint was previously a caller-supplied
  // override. It is now ALWAYS computed by RunService from the
  // actual redacted egress preview hash. The renderer cannot
  // inject or influence this binding.
  /**
   * P1 #4: renderer pre-allocates a runId via `createRunId()` so
   * the cancel button is live BEFORE startRun() resolves. If
   * supplied, startRun uses this id instead of generating a new
   * one. Core validates format; renderer cannot forge a runId
   * that belongs to another workspace because the row is still
   * created by Core with the renderer's workspaceId.
   */
  preallocatedRunId?: string;
  /**
   * Internal override for tests / adapters. Caller MUST be Core/test code.
   * Production code paths never pass this — Core wires the adapter.
   */
  adapterOverride?: BaseModelAdapter;
}

export interface RunRecord {
  id: string;
  workspaceId: string;
  task: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  finalOutput?: {
    answer: string;
    citations: Array<Record<string, unknown>>;
    modelCallId?: string;
  };
  routeDecision?: RouteDecisionRecord;
  riskLevel?: string;
  error?: string;
}

export interface RunStartOutcome {
  run: RunRecord;
  auditEventIds: string[];
  blocked: boolean;
  blockedReason?: string;
}

/**
 * Result returned by the production AdapterResolver. Carries the
 * BaseModelAdapter plus the canonical model / provider ids so the
 * agent can record accurate model_call rows and the audit chain
 * captures the actual model that was used.
 */
export interface ResolvedAdapter {
  adapter: BaseModelAdapter;
  /** Canonical `models.id` from ProviderService (stable). */
  modelInternalId: string;
  /** Canonical `models.name` from ProviderService — the model id sent to the HTTP endpoint. */
  modelName: string;
  /** `model_providers.id` the adapter resolves against. */
  providerId: string;
}

/**
 * Adapter resolution contract.
 *
 * Sequence 0 only allows two kinds of adapters:
 *  - a configured OllamaAdapter / OpenAICompatibleAdapter from
 *    ProviderService (production path — no synthetic completion),
 *  - an explicit test adapter (Test Model Adapter) injected by tests.
 *
 * Anything else must throw — production must NEVER return a
 * hard-coded "model completion" result; this gate enforces that.
 */
export type AdapterResolver = (input: {
  workspaceId: string;
  requestedProviderId?: string;
  requestedModelId?: string;
}) => Promise<ResolvedAdapter>;

/**
 * Run Service — owns the canonical local run lifecycle.
 *
 * Sequence 0 invariants:
 *  - persistence is REQUIRED. `db` is never optional in production.
 *  - the run path goes Renderer → IPC → Main → OgraCore.runService →
 *    InternalAgentAdapter → PolicyService → RouteService → RagEngine
 *    → configured ModelAdapter → SQLite. No component in this chain
 *    is permitted to fabricate a model completion.
 *  - approval / policy / route evidence missing ⇒ ModelAdapter
 *    callback count is 0; the run is blocked.
 *  - run row, audit events and (where applicable) model_calls are
 *    written through the AuditService / DatabaseService. They MUST
 *    survive service rebuild because the data is in SQLite, not in
 *    a process-local Map.
 *
 * Run lifecycle:
 *   created → policy_precheck → retrieval → context_policy_check →
 *   route_decision → risk_classified → model_invocation → audit_complete
 *   (or blocked / failed at any stage).
 */
export class RunService {
  /**
   * P1 #4: atomically create a `created` run row and return its id.
   * The renderer calls this BEFORE startRun() so the cancel button
   * has a target id during the run. The row is persisted to SQLite
   * immediately — cancelRun() will find it even if startRun() has
   * not yet resolved the adapter.
   */
  createRunId(workspaceId: string, task: string): string {
    const runId = `run_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();
    this.db.storeRun({
      id: runId,
      workspaceId,
      task,
      status: RunStatus.Created,
      startedAt: now,
    });
    return runId;
  }

  /** Adapters registered by runId so cancelRun can forward aborts.
   *  P1 #4: keyed by runId, NOT by class+provider, because the
   *  resolver creates a fresh adapter per run. Keying by class+provider
   *  would cause the second concurrent run on the same provider to
   *  overwrite the first adapter's entry, making cancelRun unable to
   *  abort the first run's in-flight request. */
  private readonly registeredAdapters = new Map<string, { cancel(runId: string): void; runId: string }>();
  /** Set of runIds whose agent loop should be aborted. */
  private readonly cancelledRuns = new Set<string>();
  /** Signals forwarded to the agent each step so it can short-circuit
   * a long HTTP request. */
  private readonly cancellationSignals = new Map<string, { aborted: boolean }>();

  /** Read the scope_hash of an existing approval row. Used to seed the
   *  approval context bound to that scope so the agent's loadApproval
   *  verification does not reject a legitimate approval. */
  private peekApprovalScopeHash(runId: string, approvalId: string): string | undefined {
    const row = this.db.getRawDB().prepare(
      'SELECT scope_hash FROM approvals WHERE id = ? AND run_id = ?',
    ).get(approvalId, runId) as any;
    return row?.scope_hash ?? undefined;
  }

  /** Read the canonical payload_fingerprint bound to an approval row
   *  at requestApproval() time. Used to bind resumeRun calls back to
   *  the original approval, so the agent's loadApproval check sees
   *  the same fingerprint the row was approved against. */
  private peekApprovalPayloadFingerprint(runId: string, approvalId: string): string | undefined {
    const row = this.db.getRawDB().prepare(
      'SELECT payload_fingerprint FROM approvals WHERE id = ? AND run_id = ?',
    ).get(approvalId, runId) as any;
    return row?.payload_fingerprint ?? undefined;
  }

  /** Read the canonical policy_version_hash bound to an approval row
   *  at requestApproval() time. */
  private peekApprovalPolicyVersionHash(runId: string, approvalId: string): string | undefined {
    const row = this.db.getRawDB().prepare(
      'SELECT policy_version_hash FROM approvals WHERE id = ? AND run_id = ?',
    ).get(approvalId, runId) as any;
    return row?.policy_version_hash ?? undefined;
  }

  constructor(
    private workspaceService: WorkspaceService,
    private routeService: RouteService,
    private auditService: AuditService,
    private policyService: PolicyService,
    private db: DatabaseService,
    private providerService: ProviderService,
    private secretBroker: OgraSecretBroker,
    private config: OgraCoreConfig,
    private ragEngine: RagEngine,
    private resolveAdapter: AdapterResolver,
    private internalAgent: InternalAgentAdapter,
    private redactionService: RedactionService,
  ) {
    if (!db) {
      // Defensive: RunService cannot serve a real run path without
      // a database; Sequence 0 forbids fail-open persistence.
      throw new OgraError(
        OgraErrorCode.INTERNAL_ERROR,
        'RunService requires a DatabaseService; refusing to start with persistence disabled',
      );
    }
    if (!internalAgent) {
      throw new OgraError(
        OgraErrorCode.INTERNAL_ERROR,
        'RunService requires InternalAgentAdapter',
      );
    }
    if (!resolveAdapter) {
      throw new OgraError(
        OgraErrorCode.INTERNAL_ERROR,
        'RunService requires an AdapterResolver; production must wire the configured adapter',
      );
    }
  }

  /**
   * Look up a real approval row by id and bind it to the supplied
   * run / workspace / policy-version / scope-fingerprint.
   *
   * Returns null whenever the row is missing, the decision is not
   * `approved`, the binding doesn't match, or the row has expired.
   * Cross-run / cross-workspace reuse is rejected by comparing the
   * stored runId + workspaceId against what the caller is about to
   * execute; an approval granted for run A can never satisfy run B.
   */
  async loadApproval(input: {
    approvalId?: string;
    runId: string;
    workspaceId: string;
    policyVersionHash: string;
    payloadFingerprint: string;
    scopeHash: string;
    asOf?: string;
  }): Promise<{
    id: string;
    runId: string;
    workspaceId: string;
    approvalType: string;
    scopeHash: string;
    payloadFingerprint: string;
    policyVersionHash: string;
    decision: 'approved';
    revision: number;
    expiresAt?: string;
  } | null> {
    if (!input.approvalId) return null;
    const row = this.db.getRawDB().prepare(`
      SELECT id, run_id, workspace_id, decision, approval_type,
             scope_hash, payload_fingerprint, policy_version_hash,
             revision, expires_at
        FROM approvals WHERE id = ?
    `).get(input.approvalId) as any;
    if (!row) return null;
    if (row.decision !== 'approved') return null;
    if (row.run_id !== input.runId) return null;
    if (row.workspace_id !== input.workspaceId) return null;
    // Sequence 0 invariant: every binding hash MUST be persisted
    // (non-null) on the canonical row and MUST match the value the
    // caller supplies. NULL on the row means the row is legacy/incomplete
    // and never satisfies a binding check — explicit failure rather than
    // wildcard silent-allow.
    if (!row.scope_hash || row.scope_hash !== input.scopeHash) return null;
    if (!row.payload_fingerprint || row.payload_fingerprint !== input.payloadFingerprint) return null;
    if (!row.policy_version_hash || row.policy_version_hash !== input.policyVersionHash) return null;
    const asOf = input.asOf ?? new Date().toISOString();
    if (row.expires_at && row.expires_at <= asOf) return null;
    return {
      id: row.id,
      runId: row.run_id,
      workspaceId: row.workspace_id,
      approvalType: row.approval_type,
      scopeHash: row.scope_hash,
      payloadFingerprint: row.payload_fingerprint,
      policyVersionHash: row.policy_version_hash,
      decision: 'approved',
      revision: row.revision ?? 1,
      expiresAt: row.expires_at ?? undefined,
    };
  }

  async startRun(req: RunStartRequest): Promise<RunRecord> {
    if (!req || !req.workspaceId || typeof req.workspaceId !== 'string') {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, 'workspaceId is required');
    }
    if (!req.task || typeof req.task !== 'string') {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, 'task is required');
    }

    // 0. Workspace existence — Core authority; renderer-supplied
    //    workspace ids are not trusted if they don't resolve to a
    //    persisted row.
    const workspace = await this.workspaceService.get(req.workspaceId);

    // 0a. Resolve the canonical adapter first so we know the real
    //     model + provider ids, and so the agent's `run_created`
    //     event captures them.
    let resolved: ResolvedAdapter;
    try {
      resolved = req.adapterOverride
        ? {
            adapter: req.adapterOverride,
            modelInternalId: req.requestedModel ?? 'test_model',
            modelName: req.requestedModel ?? 'test_model',
            providerId: req.adapterOverride.providerId,
          }
        : await this.resolveAdapter({
            workspaceId: workspace.id,
            requestedProviderId: req.requestedProvider,
            requestedModelId: req.requestedModel,
          });
    } catch (err) {
      // No acceptable adapter (e.g. nothing configured, or requested
      // model not registered). Persist a blocked run + audit event
      // atomically so the trace is complete.
      const blockedAt = new Date().toISOString();
      const blockRunId = `run_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      this.persistRunRow({
        id: blockRunId,
        workspaceId: workspace.id,
        task: req.task,
        status: RunStatus.Blocked,
        startedAt: blockedAt,
      });
      const errorMessage = (err as Error)?.message?.slice(0, 200) || 'No acceptable model';
      this.persistRunTerminal({
        runId: blockRunId,
        workspaceId: workspace.id,
        status: RunStatus.Blocked,
        completedAt: blockedAt,
        error: `NO_ACCEPTABLE_MODEL: ${errorMessage}`,
        terminalEvent: {
          eventType: RunEventType.RunBlocked,
          payload: { route: 'blocked', reasons: ['no acceptable model'] },
        },
      });
      throw err instanceof OgraError
        ? err
        : new OgraError(OgraErrorCode.NO_ACCEPTABLE_MODEL, errorMessage);
    }

    // 1. Persist the run row IMMEDIATELY. If persistence fails the
    //    run does not exist; we never enter "in-memory only" mode.
    //
    //    When the caller supplies resumeRunId, this is the resume
    //    call after an approval decision. The same canonical runId
    //    MUST be reused so the hash chain stays bounded to one run,
    //    and so the approval row's run_id check still holds.
    const startedAt = new Date().toISOString();
    let record: RunRecord;
    if (req.resumeRunId) {
      const existing = await this.readRunFromDb(req.resumeRunId);
      if (!existing || existing.workspaceId !== workspace.id) {
        throw new OgraError(OgraErrorCode.RUN_NOT_FOUND,
          `Cannot resume run ${req.resumeRunId} in workspace ${workspace.id}`);
      }
      if (existing.status !== RunStatus.AwaitingApproval && existing.status !== RunStatus.Failed) {
        throw new OgraError(OgraErrorCode.RUN_INVALID_STATE,
          `Cannot resume run ${req.resumeRunId}: status=${existing.status}`);
      }
      // Reset to created in its own transaction (no audit chain
      // append yet; the agent will follow up with a single
      // run_resumed event).
      this.db.updateRunStatus(existing.id, RunStatus.Created, startedAt);
      record = {
        ...existing,
        status: RunStatus.Created,
        startedAt,
      };
      await this.auditService.appendEvent({
        runId: existing.id,
        workspaceId: workspace.id,
        eventType: RunEventType.RunResumed,
        eventPayload: {
          taskHash: crypto.createHash('sha256').update(existing.task).digest('hex'),
          taskLength: existing.task.length,
          approvalId: req.approvalId ?? null,
          reason: 'resume after user approval',
        },
        policyVersionHash: this.policyService.getPolicyVersionHash(),
      });
    } else {
      let generatedRunId: string;
      if (req.preallocatedRunId) {
        // P1 #4: format validation to prevent injection.
        if (!/^run_\d+_[0-9a-f]{8}$/.test(req.preallocatedRunId)) {
          throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
            'preallocatedRunId must match run_<timestamp>_<8hex>');
        }
        // P0 regression fix: createRunId() now pre-writes the
        // agent_runs row so cancelRun() can find it during the
        // adapter-resolution window. startRun must TAKE OVER that
        // existing row rather than reject it. We require the row to
        // be in `created` status and to belong to the same workspace
        // and have the same task; otherwise it is a forgery attempt.
        const existing = await this.readRunFromDb(req.preallocatedRunId);
        if (existing) {
          if (existing.workspaceId !== workspace.id) {
            throw new OgraError(OgraErrorCode.PERMISSION_DENIED,
              'preallocatedRunId belongs to a different workspace');
          }
          if (existing.status !== RunStatus.Created) {
            throw new OgraError(OgraErrorCode.RUN_INVALID_STATE,
              `preallocatedRunId ${req.preallocatedRunId} has status=${existing.status}`);
          }
          if (existing.task !== req.task) {
            throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
              'preallocatedRunId task does not match the requested task');
          }
          // Take over the existing created row. Do NOT call
          // persistRunRow — that would duplicate or fail.
          record = {
            ...existing,
            status: RunStatus.Created,
            startedAt,
          };
          generatedRunId = existing.id;
        } else {
          // No pre-existing row matched; create a fresh one.
          generatedRunId = `run_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
          record = {
            id: generatedRunId,
            workspaceId: workspace.id,
            task: req.task,
            status: RunStatus.Created,
            startedAt,
          };
          this.persistRunRow(record);
        }
      } else {
        generatedRunId = `run_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        record = {
          id: generatedRunId,
          workspaceId: workspace.id,
          task: req.task,
          status: RunStatus.Created,
          startedAt,
        };
        this.persistRunRow(record);
      }
    }
    const runId = record.id;
    // Seed the hash chain with the run_created event. P1 #4: the
    // audit chain MUST NOT carry the raw task text — it only
    // records a sha256 hash + length so the chain is verifiable
    // without leaking sensitive input. The raw task is kept in
    // agent_runs.task (DB-local) for the agent's own retrieval.
    const taskHash = crypto.createHash('sha256').update(record.task).digest('hex');
    // P2 #5: resume path writes run_resumed only; the initial
    // startRun path writes run_created. Never both for the same run.
    if (!req.resumeRunId) {
      await this.auditService.appendEvent({
        runId,
        workspaceId: record.workspaceId,
        eventType: RunEventType.RunCreated,
        eventPayload: {
          taskHash,
          taskLength: record.task.length,
          workspaceId: record.workspaceId,
          knowledgeBaseIds: req.knowledgeBaseIds ?? [],
          approvalIdHint: req.approvalId ?? null,
          providerId: resolved.providerId,
          modelInternalId: resolved.modelInternalId,
          modelName: resolved.modelName,
          requestedProviderId: req.requestedProvider ?? null,
          requestedModel: req.requestedModel ?? null,
        },
        policyVersionHash: this.policyService.getPolicyVersionHash(),
      });
    }

    // 2. Sequence 0 — same-run approval flow.
    //
    // For Confidential + cloud (and any route that demands
    // user approval), the agent MUST NOT be invoked until the
    // canonical approvals row for THIS runId is `approved`. The
    // pre-flight policy evaluation runs here so we can decide
    // whether to suspend the run at `awaiting_approval` and
    // capture the binding hashes that the upcoming approval row
    // will be locked to. Reuse RunService as the sole authority
    // for approval row creation — the renderer/agent can never
    // forge approval bindings.
    const policyVersionHash = this.policyService.getPolicyVersionHash();
    const preliminaryPolicy = await this.policyService.evaluate({
      workspaceId: workspace.id,
      dataClassification: workspace.defaultClassification,
      requestedCompute: resolved.adapter.isLocal ? 'local' : 'cloud',
      providerId: resolved.providerId,
      modelId: resolved.modelName,
      providerIsLocal: resolved.adapter.isLocal,
      requestedOperation: 'generate',
      hasUserApproval: !!req.approvalId,
    });
    const requiresApproval = preliminaryPolicy.decision === 'require_approval'
      || preliminaryPolicy.decision === 'allow'
        && (preliminaryPolicy.route as string) === 'redact_then_egress';

    if (requiresApproval && !req.approvalId) {
      // P0 #1 + P1 #2: the approval fingerprint MUST be the hash of
      // the ACTUAL redacted egress payload. To guarantee hash equality
      // with the resume path, we run the SAME RAG retrieval and the
      // SAME assembleContext() call that the agent uses on resume, so
      // the contextBlock strings are byte-identical between park and
      // resume. The redaction engine is deterministic, so the
      // hashes will match as long as the knowledge base is stable.
      // P1 fix: use the same MAX_RETRIEVAL_RESULTS as the agent's
      // resume path. Otherwise retrieval results differ between
      // park and resume, assembleContext() builds a different
      // contextBlock, and the redactor hash equality check rejects
      // the run.
      const parkRetrieved = this.ragEngine.retrieve(
        record.task, record.workspaceId,
        InternalAgentAdapter.MAX_RETRIEVAL_RESULTS,
      );
      const parkContextAssembly = parkRetrieved.length > 0
        ? this.ragEngine.assembleContext(parkRetrieved, record.task)
        : { contextBlock: '', highWaterClassification: workspace.defaultClassification,
            citationCount: 0, citations: [] };
      const parkContextBlock = parkContextAssembly.contextBlock;
      const parkChunkIds = parkRetrieved.map((c: any) => c.chunkId || c.id || '');
      const preliminaryEgress = JSON.stringify({
        task: record.task,
        contextBlock: parkContextBlock,
        chunkIds: parkChunkIds,
      });
      const redactionPreview = this.redactionService.redact({
        runId: record.id,
        ruleSetId: 'builtin-core-v1',
        ruleVersion: 'r1.0.0',
        beforeText: preliminaryEgress,
        classification: workspace.defaultClassification,
      });
      const payloadFingerprint = redactionPreview.afterHash;
      const expHours = Number(
        (this.config as any).approvalTtlHours
        ?? process.env.OGRA_APPROVAL_TTL_HOURS
        ?? '24',
      );
      const expiresAt = new Date(
        Date.now() + expHours * 60 * 60 * 1000,
      ).toISOString();
      const created = await this.requestApproval({
        runId: record.id,
        workspaceId: workspace.id,
        approvalType: 'egress',
        requestedScope: {
          mode: 'approve_then_egress',
          classification: workspace.defaultClassification,
          providerId: resolved.providerId,
          modelId: resolved.modelName,
          // P1 #4: no raw task in the approval scope either;
          // the scope hash binds to the redacted preview hash.
          payloadFingerprint,
        },
        policyVersionHash,
        payloadFingerprint,
        sanitizedPreview: redactionPreview.redactedText,
        redactionRuleVersion: 'r1.0.0',
        expiresAt,
      });
      this.redactionService.linkApproval(redactionPreview.recordId, created.id);

      // Persist the policy + route decision evidence, then park
      // the run in awaiting_approval. The terminal state and event
      // are committed in ONE transaction (Sequence 0 #5).
      this.persistRunTerminal({
        runId,
        workspaceId: workspace.id,
        status: RunStatus.AwaitingApproval,
        completedAt: startedAt,
        terminalEvent: {
          eventType: RunEventType.AuditComplete,
          payload: {
            status: RunStatus.AwaitingApproval,
            route: 'awaiting_approval',
            pendingApprovalId: created.id,
            policyVersionHash,
            payloadFingerprint,
            decision: preliminaryPolicy.decision,
            reasons: preliminaryPolicy.reasons,
          },
          policyVersionHash,
        },
      });
      // Mark the audit chain as paused — there is no model call yet.
      // Caller MUST call submitApprovalDecision(... 'approved') and
      // then re-invoke startRun with the SAME runId + approvalId to
      // resume execution.
      record.status = RunStatus.AwaitingApproval;
      (record as any).pendingApprovalId = created.id;
      (record as any).pendingApprovalScopeHash = created.scopeHash;
      (record as any).pendingPayloadFingerprint = payloadFingerprint;
      (record as any).pendingPolicyVersionHash = policyVersionHash;
      return record;
    }

    try {
      // Auto-register the resolved adapter so cancelRun() can
      // forward an abort signal to the in-flight fetch. The adapter
      // is unregistered in persistRunTerminal once the run reaches
      // its terminal state (success or failure).
      if (typeof (resolved.adapter as any).cancel === 'function') {
        this.registerAdapterForRun(runId, resolved.adapter as any);
      }
      // 4. Drive the canonical run path through InternalAgentAdapter.
      //    The agent owns: high-water mark, policy, route, retrieval,
      //    prompt assembly, model call, audit, and SQLite persistence.
      //    We pass our `runId` so the agent's run row + audit chain
      //    reuse the same id the renderer will look up via IPC later.
      const result = await this.internalAgent.run({
        task: record.task,
        workspaceId: record.workspaceId,
        knowledgeBaseIds: req.knowledgeBaseIds ?? [],
        adapter: resolved.adapter,
        modelId: resolved.modelName,
        modelInternalId: resolved.modelInternalId,
        providerId: resolved.providerId,
        requestedClassification: workspace.defaultClassification as any,
        runId: record.id,
        approvalContext: req.approvalId
          ? {
              approvalIdHint: req.approvalId,
              scopeHash: this.peekApprovalScopeHash(record.id, req.approvalId),
              // Pass the canonical binding hashes that RunService
              // recorded on the approval row at park time so the
              // agent's loadApproval verification matches strictly.
              payloadFingerprint:
                this.peekApprovalPayloadFingerprint(record.id, req.approvalId),
              policyVersionHash:
                this.peekApprovalPolicyVersionHash(record.id, req.approvalId),
            }
          : null,
        isCancelled: () => this.isRunCancelled(runId),
        abortSignal: this.cancellationSignals.get(runId),
      });
      // The agent handles its own run_blocked / audit_complete events
      // internally; we only need to persist the canonical terminal
      // state on the agent_runs row + an audit_complete event in
      // ONE transaction with the rest of the lifecycle evidence.
      // P0 #2: CAS — if the run was cancelled while the agent was
      // executing (agent returned a cancelled result or the
      // cancellation signal fired just before we write the terminal
      // state), we MUST write `cancelled` instead of `completed`.
      // This closes the race where cancelRun() writes `cancelled`
      // but the success path overwrites it with `completed`.
      if (this.isRunCancelled(runId)) {
        const cancelledAt = new Date().toISOString();
        record.status = RunStatus.Cancelled;
        record.completedAt = cancelledAt;
        this.persistRunTerminal({
          runId,
          workspaceId: record.workspaceId,
          status: RunStatus.Cancelled,
          completedAt: cancelledAt,
          terminalEvent: {
            eventType: RunEventType.RunCancelled,
            payload: { reason: 'cancelled before terminal commit' },
          },
        });
        this.unregisterAdapterForRun(runId);
        return record;
      }
      const finalStatus = result.routeDecision.route === 'blocked'
        ? RunStatus.Blocked
        : RunStatus.Completed;
      const completedAt = new Date().toISOString();
      record.status = finalStatus;
      record.completedAt = completedAt;
      record.routeDecision = result.routeDecision;
      record.riskLevel = result.riskSummary?.riskLevel;
      record.finalOutput = {
        answer: result.answer,
        citations: result.citations,
        modelCallId: result.modelCall?.id,
      };
      this.persistRunTerminal({
        runId,
        workspaceId: record.workspaceId,
        status: finalStatus,
        completedAt,
        finalOutput: record.finalOutput,
        terminalEvent: {
          eventType: RunEventType.AuditComplete,
          payload: {
            status: finalStatus,
            route: result.routeDecision.route,
            modelCallId: result.modelCall?.id ?? null,
          },
          policyVersionHash: this.policyService.getPolicyVersionHash(),
        },
      });
      this.unregisterAdapterForRun(runId);
      return record;
    } catch (err) {
      // P0 #2: cancel CAS. If the run was cancelled (either by
      // cancelRun() writing `cancelled` or by setting the
      // cancellation signal), the terminal state MUST be `cancelled`,
      // NOT `failed`. The adapter throws because its AbortController
      // fired; that is the expected consequence of cancel, not a
      // failure. We check `isRunCancelled` BEFORE writing `failed`.
      if (this.isRunCancelled(runId)) {
        const cancelledAt = new Date().toISOString();
        record.status = RunStatus.Cancelled;
        record.completedAt = cancelledAt;
        this.persistRunTerminal({
          runId,
          workspaceId: record.workspaceId,
          status: RunStatus.Cancelled,
          completedAt: cancelledAt,
          terminalEvent: {
            eventType: RunEventType.RunCancelled,
            payload: { reason: 'cancelled during execution', cause: 'abort_signal' },
          },
        });
        this.unregisterAdapterForRun(runId);
        return record;
      }
      // Sequence 0 invariant: the agent MUST NOT have written
      // user-sensitive text into the hash chain. RunService catches
      // any adapter-thrown error, sanitizes it to (code | message,
      // bounded), and persists terminal state + a sanitized
      // run_failed event in one transaction.
      const errorCode = (err as any)?.code || OgraErrorCode.INTERNAL_ERROR;
      const rawMessage = (err as Error)?.message || 'Run failed';
      const errorMessage = rawMessage.slice(0, 200);
      const failedAt = new Date().toISOString();
      record.status = RunStatus.Failed;
      record.completedAt = failedAt;
      record.error = `${errorCode}: ${errorMessage}`.slice(0, 200);
      this.persistRunTerminal({
        runId,
        workspaceId: record.workspaceId,
        status: RunStatus.Failed,
        completedAt: failedAt,
        error: record.error,
        terminalEvent: {
          eventType: RunEventType.RunFailed,
          payload: {
            errorCode,
            errorMessage,
          },
        },
      });
      this.unregisterAdapterForRun(runId);
      throw new OgraError(errorCode as OgraErrorCode, errorMessage);
    }
  }

  async getStatus(runId: string): Promise<RunRecord | null> {
    if (!runId || typeof runId !== 'string') return null;
    // Always read from SQLite so a fresh service can see the run
    // created by a previous instance. The in-memory cache (if any)
    // is a hint only; the row in agent_runs is authoritative.
    return this.readRunFromDb(runId);
  }

  async cancelRun(runId: string): Promise<void> {
    const existing = await this.readRunFromDb(runId);
    if (!existing) {
      throw new OgraError(OgraErrorCode.RUN_NOT_FOUND, `Run ${runId} not found`);
    }
    if ([RunStatus.Completed, RunStatus.Failed, RunStatus.Cancelled, RunStatus.Blocked].includes(existing.status as RunStatus)) {
      return;
    }
    // Mark the run as cancelled in-memory so the agent's polling
    // helpers (isCancelled / abortSignal) see the cancellation and
    // abort any in-flight model request immediately. The persisted
    // row + audit event still flow through `persistRunTerminal`.
    this.cancellationSignals.set(runId, { aborted: true });
    this.cancelledRuns.add(runId);

    // Best-effort: ask every registered adapter to abort this runId.
    // P1 #4: look up the adapter by runId (not iterate all) so
    // concurrent runs on the same provider don't interfere.
    const adapter = this.registeredAdapters.get(runId);
    if (adapter) {
      try {
        adapter.cancel(runId);
      } catch {
        // best-effort
      }
    }

    const cancelledAt = new Date().toISOString();
    this.persistRunTerminal({
      runId,
      workspaceId: existing.workspaceId,
      status: RunStatus.Cancelled,
      completedAt: cancelledAt,
      terminalEvent: {
        eventType: RunEventType.RunCancelled,
        payload: { reason: 'User cancelled' },
      },
    });
    this.cancellationSignals.delete(runId);
  }

  private isRunCancelled(runId: string): boolean {
    return this.cancelledRuns.has(runId);
  }

  /** P1 #4: register an adapter for a specific runId so cancelRun
   *  can forward aborts. Keyed by runId to support concurrent runs
   *  on the same provider. */
  registerAdapterForRun(runId: string, adapter: { cancel(runId: string): void }): void {
    this.registeredAdapters.set(runId, { cancel: adapter.cancel.bind(adapter), runId });
  }

  /** P1 #4: unregister the adapter for a run after terminal state. */
  unregisterAdapterForRun(runId: string): void {
    this.registeredAdapters.delete(runId);
  }

  /** Legacy single-arg registration kept for test compatibility. */
  registerAdapter(adapter: { cancel(runId: string): void }): void {
    // No-op for legacy callers; tests should use registerAdapterForRun.
    void adapter;
  }

  private persistRunRow(record: RunRecord): void {
    this.db.storeRun({
      id: record.id,
      workspaceId: record.workspaceId,
      task: record.task,
      status: record.status,
      startedAt: record.startedAt,
    });
  }

  /**
   * Persist the terminal transition in ONE SQLite transaction:
   *   agent_runs.status + completed_at + final_output_location + error_message
   *   run_events.<terminalEvent.eventType>
   *
   * Sequence 0 invariant: the lifecycle hash chain never has a row
   * update without the matching terminal audit event. A crash
   * before this transaction commits leaves the run in its prior
   * state and the audit chain intact; a crash after commits both
   * atomically.
   */
  private persistRunTerminal(input: {
    runId: string;
    workspaceId: string;
    status: string;
    completedAt: string;
    finalOutput?: RunRecord['finalOutput'];
    error?: string;
    terminalEvent: {
      eventType: string;
      payload: Record<string, unknown>;
      policyVersionHash?: string;
      redactionRuleVersion?: string;
    };
  }): void {
    // Sequence 0 invariant: the agent_runs row transition AND the
    // terminal audit event MUST be committed in one SQLite
    // transaction. better-sqlite3's `db.transaction(() => { ... })()`
    // rolls back ALL writes inside the closure if any throws, so a
    // terminal-event insertion failure leaves the row in its prior
    // state. The verifier-side chain verifies the row state matches
    // the audit chain; a half-committed terminal state would break
    // the contract.
    const tx = this.db.getRawDB().transaction(() => {
      this.db.updateRunStatus(input.runId, input.status, input.completedAt);
      const updates: string[] = [];
      const params: unknown[] = [];
      if (input.finalOutput !== undefined) {
        updates.push('final_output_location = ?');
        params.push(JSON.stringify(input.finalOutput));
      }
      if (input.error !== undefined) {
        updates.push('error_message = ?');
        params.push(input.error);
      }
      if (updates.length > 0) {
        this.db.getRawDB().prepare(
          `UPDATE agent_runs SET ${updates.join(', ')} WHERE id = ?`,
        ).run(...params, input.runId);
      }
      // Append the terminal audit event INSIDE the same transaction.
      // appendRunEvent itself uses its own transaction; nested
      // transactions in better-sqlite3 are savepoints so the inner
      // transaction participates in the outer commit/rollback.
      this.db.appendRunEvent(
        input.runId,
        input.workspaceId,
        input.terminalEvent.eventType,
        input.terminalEvent.payload,
        input.terminalEvent.policyVersionHash,
        input.terminalEvent.redactionRuleVersion,
      );
    });
    tx();
  }

  private readRunFromDb(runId: string): RunRecord | null {
    const row = this.db.getRawDB().prepare(
      'SELECT * FROM agent_runs WHERE id = ?',
    ).get(runId) as any;
    if (!row) return null;
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      task: row.task,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at ?? undefined,
      finalOutput: row.final_output_location ? JSON.parse(row.final_output_location) : undefined,
      error: row.error_message ?? undefined,
    };
  }

  /**
   * Apply the given ApprovalRequest through Core policy:
   *  - persists an `approvals` row with decision='pending',
   *  - never auto-approves,
   *  - the user decision arrives via submitApprovalDecision().
   *
   * Sequence 0 stores the requested scope as JSON; binding to the
   * payload fingerprint and rule revision is recorded in
   * policy_evaluations.route_decision_id when present.
   */
  async requestApproval(input: {
    runId: string;
    workspaceId: string;
    approvalType: string;
    requestedScope: Record<string, unknown>;
    policyVersionHash: string;
    payloadFingerprint: string;
    /** Core-generated egress bytes shown to the approver. Never accepted from IPC. */
    sanitizedPreview?: string;
    redactionRuleVersion?: string;
    expiresAt?: string;
    reason?: string;
  }): Promise<{ id: string; status: 'pending'; scopeHash: string }> {
    // Workspace existence + run existence as hard preconditions.
    const workspace = await this.workspaceService.get(input.workspaceId);
    const run = await this.readRunFromDb(input.runId);
    if (!run || run.workspaceId !== workspace.id) {
      throw new OgraError(OgraErrorCode.RUN_NOT_FOUND, 'Run not found for workspace');
    }
    if (!input.policyVersionHash || !input.payloadFingerprint) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        'policyVersionHash and payloadFingerprint are required to bind the approval');
    }
    if ((input.sanitizedPreview === undefined) !== (input.redactionRuleVersion === undefined)) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        'sanitized preview and redactionRuleVersion must be supplied together');
    }
    if (input.sanitizedPreview !== undefined && crypto.createHash('sha256').update(input.sanitizedPreview).digest('hex') !== input.payloadFingerprint) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        'sanitized preview hash must match the approval payload fingerprint');
    }
    if (input.sanitizedPreview !== undefined) try {
      const preview = JSON.parse(input.sanitizedPreview);
      if (preview?.task !== '[REDACTED-task]') {
        throw new Error('task is not redacted');
      }
      if (preview?._redaction_provenance !== `ogra/redaction@${input.redactionRuleVersion!}`) {
        throw new Error('missing redaction provenance');
      }
    } catch {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        'sanitized preview must be a Core-redacted egress payload');
    }
    const id = `apr_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();
    const scopeHash = crypto.createHash('sha256')
      .update(JSON.stringify(input.requestedScope)).digest('hex');
    this.db.getRawDB().prepare(`
      INSERT INTO approvals (id, run_id, workspace_id, approval_type,
        requested_scope_json, scope_hash, payload_fingerprint,
        policy_version_hash, sanitized_preview, redaction_rule_version,
        expires_at, decision, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      id, input.runId, workspace.id, input.approvalType,
      JSON.stringify(input.requestedScope),
      scopeHash,
      input.payloadFingerprint,
      input.policyVersionHash,
      input.sanitizedPreview ?? null,
      input.redactionRuleVersion ?? null,
      input.expiresAt ?? null,
      now,
    );
    await this.auditService.appendEvent({
      runId: input.runId,
      workspaceId: workspace.id,
      eventType: RunEventType.ApprovalRequested,
      eventPayload: {
        approvalId: id,
        approvalType: input.approvalType,
        requestedScope: input.requestedScope,
        scopeHash,
        payloadFingerprint: input.payloadFingerprint,
        sanitizedPreview: input.sanitizedPreview ?? null,
        redactionRuleVersion: input.redactionRuleVersion ?? null,
      },
      policyVersionHash: input.policyVersionHash,
      redactionRuleVersion: input.redactionRuleVersion,
    });
    return { id, status: 'pending', scopeHash };
  }

  /**
   * Submit a user approval decision. Core authority is the SQLite
   * `approvals` row. Sequence 0 invariant: the supplied runId and
   * workspaceId MUST match the persisted approval row, so a
   * renderer cannot submit a decision against a different
   * workspace or run by knowing only the approvalId.
   */
  async submitApprovalDecision(input: {
    approvalId: string;
    runId: string;
    workspaceId: string;
    decision: 'approved' | 'denied';
    decidedBy?: string;
    reason?: string;
  }): Promise<{ id: string; decision: string }> {
    const row = this.db.getRawDB().prepare(
      'SELECT id, run_id, workspace_id, decision FROM approvals WHERE id = ?',
    ).get(input.approvalId) as any;
    if (!row) {
      throw new OgraError(OgraErrorCode.SECRET_ACCESS_DENIED, 'Approval not found');
    }
    if (row.run_id !== input.runId) {
      throw new OgraError(OgraErrorCode.PERMISSION_DENIED, 'Approval does not belong to the supplied run');
    }
    if (row.workspace_id !== input.workspaceId) {
      throw new OgraError(OgraErrorCode.PERMISSION_DENIED, 'Approval does not belong to the supplied workspace');
    }
    // A network/UI failure can happen after the Core decision commits but
    // before the same-run resume finishes. Replaying the identical decision
    // is safe and lets the renderer retry that resume; conflicting decisions
    // remain rejected.
    if (row.decision === input.decision) {
      return { id: row.id, decision: row.decision };
    }
    if (row.decision !== 'pending') {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT, `Approval already ${row.decision}`);
    }
    const now = new Date().toISOString();
    this.db.getRawDB().prepare(`
      UPDATE approvals
      SET decision = ?, decided_by = ?, reason = ?, decided_at = ?
      WHERE id = ?
    `).run(input.decision, input.decidedBy ?? null, input.reason ?? null, now, input.approvalId);
    await this.auditService.appendEvent({
      runId: row.run_id,
      workspaceId: row.workspace_id,
      eventType: RunEventType.ApprovalDecision,
      eventPayload: {
        approvalId: row.id,
        decision: input.decision,
        decidedBy: input.decidedBy ?? null,
      },
    });
    return { id: row.id, decision: input.decision };
  }

  /** Add a free-form note to an existing approval row (rendered-visible). */
  annotateApprovalReason(approvalId: string, reason: string): void {
    this.db.getRawDB().prepare(
      'UPDATE approvals SET reason = ? WHERE id = ?',
    ).run(reason, approvalId);
  }

  /** Find all approvals (of any decision state) for a single runId. */
  async listApprovalsByRun(runId: string): Promise<Array<{
    id: string; runId: string; workspaceId: string; approvalType: string;
    requestedScope: Record<string, unknown>; scopeHash: string;
    payloadFingerprint: string; policyVersionHash: string;
    sanitizedPreview?: string; redactionRuleVersion?: string;
    decision: string; createdAt: string;
    decidedAt?: string; decidedBy?: string; reason?: string; expiresAt?: string;
  }>> {
    const rows = this.db.getRawDB().prepare(`
      SELECT id, run_id, workspace_id, approval_type, requested_scope_json,
             scope_hash, payload_fingerprint, policy_version_hash,
             sanitized_preview, redaction_rule_version,
             decision, created_at, decided_at, decided_by, reason, expires_at
        FROM approvals WHERE run_id = ?
       ORDER BY created_at DESC
    `).all(runId) as any[];
    return rows.map((r: any) => ({
      id: r.id,
      runId: r.run_id ?? '',
      workspaceId: r.workspace_id ?? '',
      approvalType: r.approval_type,
      requestedScope: r.requested_scope_json ? JSON.parse(r.requested_scope_json) : {},
      scopeHash: r.scope_hash ?? '',
      payloadFingerprint: r.payload_fingerprint ?? '',
      policyVersionHash: r.policy_version_hash ?? '',
      sanitizedPreview: r.sanitized_preview ?? undefined,
      redactionRuleVersion: r.redaction_rule_version ?? undefined,
      decision: r.decision,
      createdAt: r.created_at,
      decidedAt: r.decided_at ?? undefined,
      decidedBy: r.decided_by ?? undefined,
      reason: r.reason ?? undefined,
      expiresAt: r.expires_at ?? undefined,
    }));
  }

  /**
   * Sequence 0 — list actionable approval rows for a workspace.
   * Decided rows stay in the audit trail / per-run evidence but must
   * not reappear in the renderer's action queue.
   */
  async listApprovals(workspaceId: string): Promise<Array<{
    id: string;
    runId: string;
    workspaceId: string;
    approvalType: string;
    requestedScope: Record<string, unknown>;
    scopeHash: string;
    payloadFingerprint: string;
    policyVersionHash: string;
    sanitizedPreview?: string;
    redactionRuleVersion?: string;
    decision: string;
    createdAt: string;
    decidedAt?: string;
    decidedBy?: string;
    reason?: string;
    expiresAt?: string;
  }>> {
    const rows = this.db.getRawDB().prepare(`
      SELECT id, run_id, workspace_id, approval_type, requested_scope_json,
             scope_hash, payload_fingerprint, policy_version_hash,
             sanitized_preview, redaction_rule_version,
             decision, created_at, decided_at, decided_by, reason, expires_at
        FROM approvals WHERE workspace_id = ? AND decision = 'pending'
       ORDER BY created_at DESC
    `).all(workspaceId) as any[];
    return rows.map((r: any) => ({
      id: r.id,
      runId: r.run_id ?? '',
      workspaceId: r.workspace_id ?? workspaceId,
      approvalType: r.approval_type,
      requestedScope: r.requested_scope_json ? JSON.parse(r.requested_scope_json) : {},
      scopeHash: r.scope_hash ?? '',
      payloadFingerprint: r.payload_fingerprint ?? '',
      policyVersionHash: r.policy_version_hash ?? '',
      sanitizedPreview: r.sanitized_preview ?? undefined,
      redactionRuleVersion: r.redaction_rule_version ?? undefined,
      decision: r.decision,
      createdAt: r.created_at,
      decidedAt: r.decided_at ?? undefined,
      decidedBy: r.decided_by ?? undefined,
      reason: r.reason ?? undefined,
      expiresAt: r.expires_at ?? undefined,
    }));
  }

  /** Verify the hash chain for a run. DB-authoritative. */
  async verifyRunChain(runId: string): Promise<{ valid: boolean; errors: string[] }> {
    const r = await this.auditService.verifyChain(runId);
    return { valid: r.valid, errors: r.errors ?? [] };
  }
}
