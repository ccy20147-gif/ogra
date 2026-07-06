import { AuditService } from './audit-service';
import { DatabaseService } from './database-service';
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
  private db: DatabaseService | null;

  constructor(private auditService: AuditService, dbService?: DatabaseService) {
    this.db = dbService ?? null;
  }

  async getRunRisk(runId: string): Promise<RunRiskSummary | null> {
    const events = await this.auditService.getEvents(runId);

    const riskEvent = events.find(e => e.eventType === 'risk_classification');
    const routeEvent = events.find(e => e.eventType === 'route_decision');
    const piWarnings = events.filter(e => e.eventType === 'prompt_injection_warning');

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

    // When DB is available, also query document_access_events for incident detection
    if (this.db) {
      const accessEvents = this.db.getRawDB().prepare(
        `SELECT dae.id, dae.document_id, dae.access_type, dae.classification_snapshot, dae.created_at, d.file_name
         FROM document_access_events dae
         LEFT JOIN documents d ON dae.document_id = d.id
         WHERE dae.run_id = ?
         ORDER BY dae.created_at DESC`
      ).all(runId) as any[];

      for (const access of accessEvents) {
        // Detect incidents for blocked access or high-classification access
        if (access.access_type === 'blocked') {
          if (!reasons.includes('Blocked document access detected')) {
            reasons.push('Blocked document access detected');
          }
          if (riskLevel !== RiskLevel.Blocked && riskLevel !== RiskLevel.High) {
            riskLevel = RiskLevel.High;
            requiredApprovals = ['allow_cloud'];
          }
        }
        // If a confidential/restricted document was included in cloud payload, flag it
        if (access.access_type === 'included_in_cloud_payload') {
          let snapshotClass = '';
          if (access.classification_snapshot) {
            try {
              const snapshot = JSON.parse(access.classification_snapshot);
              snapshotClass = snapshot.classification || '';
            } catch {
              snapshotClass = access.classification_snapshot;
            }
          }
          if (
            snapshotClass === 'Confidential' || snapshotClass === 'Restricted' ||
            access.access_type === 'included_in_cloud_payload'
          ) {
            if (!reasons.includes(`Confidential document accessed by run`)) {
              reasons.push(`Confidential document accessed by run`);
            }
            if (riskLevel !== RiskLevel.Blocked && riskLevel !== RiskLevel.High) {
              riskLevel = RiskLevel.High;
            }
          }
        }
      }
    }

    // Include prompt injection warnings in risk reasons
    if (piWarnings.length > 0) {
      reasons.push(`${piWarnings.length} prompt injection warning(s) detected in retrieved content`);
      if (riskLevel !== RiskLevel.Blocked && riskLevel !== RiskLevel.High) {
        riskLevel = RiskLevel.Medium;
      }
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
    if (this.db) {
      const record = this.db.createIncident({
        id: `inc_${Date.now()}`,
        workspaceId: req.workspaceId,
        runId: req.runId,
        incidentType: req.incidentType,
        severity: req.severity,
        summary: req.summary,
        evidenceEventIds: req.evidenceEventIds,
      });
      return record;
    }
    // Fallback: in-memory (no persistence)
    const incident: IncidentRecord = {
      id: `inc_${Date.now()}`,
      ...req,
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    return incident;
  }

  async getIncidents(workspaceId?: string): Promise<IncidentRecord[]> {
    if (this.db) {
      return this.db.listIncidents(workspaceId);
    }
    return [];
  }

  async resolveIncident(id: string): Promise<void> {
    if (this.db) {
      this.db.resolveIncident(id);
    }
  }
}
