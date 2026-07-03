import { AuditService } from './audit-service';
import { RiskLevel, IncidentType } from '../shared/types';

export interface RunRiskSummary {
  runId: string;
  riskLevel: string;
  riskReasons: string[];
  requiredApprovals: string[];
  approvalStatus: string;
  createdAt: string;
}

export interface IncidentRecord {
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
}

/**
 * AI Governance Center service.
 *
 * Provides:
 * - run risk summaries
 * - incident tracking
 * - policy evaluation history
 * - model/provider registry views
 */
export class GovernanceService {
  private incidents: Map<string, IncidentRecord> = new Map();

  constructor(private auditService: AuditService) {}

  async getRunRisk(runId: string): Promise<RunRiskSummary | null> {
    const events = await this.auditService.getEvents(runId);

    const riskEvent = events.find(e => e.eventType === 'risk_classification');
    const routeEvent = events.find(e => e.eventType === 'route_decision');

    if (!routeEvent) return null;

    const payload = routeEvent.eventPayload as any;
    const route = payload.route as string;
    const reasons = payload.reasons as string[] ?? [];

    let riskLevel: string;
    let requiredApprovals: string[] = [];

    if (route === 'blocked') {
      riskLevel = RiskLevel.Blocked;
    } else if (route === 'cloud') {
      riskLevel = RiskLevel.Medium;
      requiredApprovals = ['allow_cloud'];
    } else if (reasons.some(r => r.toLowerCase().includes('confidential'))) {
      riskLevel = RiskLevel.High;
    } else {
      riskLevel = RiskLevel.Low;
    }

    return {
      runId,
      riskLevel,
      riskReasons: reasons,
      requiredApprovals,
      approvalStatus: 'not_required',
      createdAt: new Date().toISOString(),
    };
  }

  async createIncident(req: {
    workspaceId: string;
    runId: string;
    incidentType: string;
    severity: string;
    summary: string;
    evidenceEventIds: string[];
  }): Promise<IncidentRecord> {
    const incident: IncidentRecord = {
      id: `inc_${Date.now()}`,
      ...req,
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    this.incidents.set(incident.id, incident);
    return incident;
  }

  async getIncidents(workspaceId?: string): Promise<IncidentRecord[]> {
    const all = Array.from(this.incidents.values());
    if (workspaceId) {
      return all.filter(i => i.workspaceId === workspaceId);
    }
    return all;
  }

  async resolveIncident(id: string): Promise<void> {
    const incident = this.incidents.get(id);
    if (incident) {
      incident.status = 'resolved';
      incident.resolvedAt = new Date().toISOString();
    }
  }
}
