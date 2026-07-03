import { v4 as uuidv4 } from 'uuid';
import { PolicyService, PolicyEvaluationInput } from './policy-service';
import { DataClassification, RouteDecisionType, RunEventType } from '../shared/types';
import { AuditService } from './audit-service';

export interface RouteDecisionRecord {
  id: string;
  runId: string;
  route: string;
  dataClassification: DataClassification;
  highWaterSources: string[];
  reasons: string[];
  localSteps: string[];
  cloudSteps: string[];
  requiresUserApproval: boolean;
  approvalId?: string;
  policyEvaluationId?: string;
  providerId?: string;
  modelId?: string;
  cloudPayloadSummary?: string;
  cloudPayloadHash?: string;
  incidentIds: string[];
  auditEventId: string;
  createdAt: string;
}

/**
 * Route Decision Service.
 *
 * Determines the route for every run based on policy evaluation.
 * Route decisions are created BEFORE model invocation.
 */
export class RouteService {
  private decisions: Map<string, RouteDecisionRecord> = new Map();

  constructor(private policyService: PolicyService) {}

  async evaluateRoute(input: PolicyEvaluationInput): Promise<RouteDecisionRecord> {
    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const policyResult = await this.policyService.evaluate(input);

    // Determine route type
    let route: string;
    switch (policyResult.decision) {
      case 'blocked':
        route = RouteDecisionType.Blocked;
        break;
      case 'local_only':
        route = RouteDecisionType.Local;
        break;
      case 'require_approval':
        route = RouteDecisionType.Blocked;
        break;
      case 'allow':
        if (policyResult.route === 'cloud') route = RouteDecisionType.Cloud;
        else if (policyResult.route === 'hybrid') route = RouteDecisionType.Hybrid;
        else route = RouteDecisionType.Local;
        break;
      default:
        route = RouteDecisionType.Local;
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

    const decision: RouteDecisionRecord = {
      id: `rd_${uuidv4().slice(0, 8)}`,
      runId,
      route,
      dataClassification: input.dataClassification,
      highWaterSources: [],
      reasons: policyResult.reasons,
      localSteps,
      cloudSteps,
      requiresUserApproval: policyResult.requiredApprovals.length > 0,
      providerId: input.providerId,
      modelId: input.modelId,
      incidentIds: [],
      auditEventId: '',
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
