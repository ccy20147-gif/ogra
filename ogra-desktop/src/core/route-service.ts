import { v4 as uuidv4 } from 'uuid';
import { PolicyService, PolicyEvaluationInput } from './policy-service';
import { DataClassification, RouteDecisionType } from '../shared/types';
import { HighWaterMarkService } from './high-water-mark';

/** Optional input for high-water mark computation in route decisions */
export interface RouteDecisionInput extends PolicyEvaluationInput {
  /** Additional sources used for high-water classification. Each entry contributes
   *  its `classification` to the effective route data classification. */
  highWaterSources?: Array<{ sourceType: string; sourceId: string; classification: string }>;
}

export interface RouteDecisionRecord {
  id: string;
  runId: string;
  /** The task/query the user submitted — used for audit trail */
  taskId: string;
  route: string;
  dataClassification: DataClassification;
  highWaterSources: string[];
  reasons: string[];
  localSteps: string[];
  cloudSteps: string[];
  requiresUserApproval: boolean;
  approvalId?: string;
  /** ID of the policy_evaluations row produced for this decision. Populated
   *  by evaluateRoute so downstream consumers can correlate. */
  policyEvaluationId: string;
  /** SHA-256 hash of the policy set used for this evaluation */
  policyVersionHash: string;
  /** Which adapter should execute this route — set by evaluateRoute */
  assignedAdapter?: 'internal' | 'local_command' | 'cloud' | 'none';
  providerId?: string;
  modelId?: string;
  cloudPayloadSummary?: string;
  cloudPayloadHash?: string;
  incidentIds: string[];
  /** Optional ID of the run_event produced when this decision is written to
   *  audit. Populated by the caller after appendRunEvent, not by evaluateRoute. */
  auditEventId?: string;
  createdAt: string;
}

/**
 * Route Decision Service.
 *
 * Determines the route for every run based on policy evaluation.
 * Route decisions are created BEFORE model invocation.
 *
 * Now computes high-water classification from input + highWaterSources so
 * route decisions reflect the real effective classification (not just the
 * raw input). Also generates a stable policyEvaluationId per call so the
 * decision is correlatable with the policy_evaluations table.
 */
export class RouteService {
  private decisions: Map<string, RouteDecisionRecord> = new Map();
  private highWaterMark = new HighWaterMarkService();

  constructor(private policyService: PolicyService) {}

  async evaluateRoute(input: RouteDecisionInput): Promise<RouteDecisionRecord> {
    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const policyResult = await this.policyService.evaluate(input);

    // Determine route type
    let route: string;
    let assignedAdapter: RouteDecisionRecord['assignedAdapter'];
    switch (policyResult.decision) {
      case 'blocked':
        route = RouteDecisionType.Blocked;
        assignedAdapter = 'none';
        break;
      case 'local_only':
        route = RouteDecisionType.Local;
        assignedAdapter = 'internal';
        break;
      case 'require_approval':
        route = RouteDecisionType.Blocked;
        assignedAdapter = 'none';
        break;
      case 'allow':
        if (policyResult.route === 'cloud') {
          route = RouteDecisionType.Cloud;
          assignedAdapter = 'cloud';
        } else if (policyResult.route === 'hybrid') {
          route = RouteDecisionType.Hybrid;
          assignedAdapter = 'internal'; // internal adapter orchestrates hybrid
        } else {
          route = RouteDecisionType.Local;
          assignedAdapter = 'internal';
        }
        break;
      default:
        route = RouteDecisionType.Local;
        assignedAdapter = 'internal';
    }

    // Build steps
    const localSteps: string[] = ['retrieve', 'assemble_context'];
    const cloudSteps: string[] = [];

    if (route === RouteDecisionType.Cloud || route === RouteDecisionType.Hybrid) {
      cloudSteps.push('generate');
    }
    if (route !== RouteDecisionType.Cloud) {
      localSteps.push('generate');
    }
    if (route === RouteDecisionType.Hybrid) {
      localSteps.push('synthesize');
    }

    // Compute effective high-water classification from the input data
    // classification plus any high-water sources (workspace/KB/docs/chunks).
    // Previously this just copied the raw input.dataClassification, which
    // silently under-classified runs that pulled in higher-classification
    // context (KBs, documents, memories).
    const hwmSources = input.highWaterSources ?? [
      { sourceType: 'request', sourceId: runId, classification: input.dataClassification },
    ];
    const hwm = this.highWaterMark.compute(hwmSources);

    // Generate a stable policyEvaluationId so the decision can be correlated
    // with the policy_evaluations table downstream (previously omitted).
    const policyEvaluationId = `pe_${uuidv4().slice(0, 8)}`;

    const decision: RouteDecisionRecord = {
      id: `rd_${uuidv4().slice(0, 8)}`,
      runId,
      taskId: '', // Set by caller when task is known
      route,
      assignedAdapter,
      dataClassification: hwm.highWaterMark as DataClassification,
      highWaterSources: hwm.highWaterSources,
      reasons: policyResult.reasons,
      localSteps,
      cloudSteps,
      requiresUserApproval: policyResult.requiredApprovals.length > 0,
      policyEvaluationId,
      policyVersionHash: this.policyService.getPolicyVersionHash(),
      providerId: input.providerId,
      modelId: input.modelId,
      incidentIds: [],
      createdAt: new Date().toISOString(),
    };

    this.decisions.set(runId, decision);
    return decision;
  }

  async getRouteDecision(runId: string): Promise<RouteDecisionRecord | null> {
    return this.decisions.get(runId) ?? null;
  }

  async storeRouteDecision(decision: RouteDecisionRecord): Promise<void> {
    this.decisions.set(decision.runId, decision);
  }
}
