import React, { useState } from 'react';

interface RiskDetail {
  runId: string;
  category: string;
  details: string;
  remediation?: string;
  score?: number;
}

interface PolicyEvaluation {
  runId: string;
  policyName: string;
  rule: string;
  status: 'pass' | 'fail' | 'warning' | 'error';
  detail: string;
}

interface RegisteredModel {
  modelId: string;
  provider: string;
  name: string;
  version: string;
  status: 'active' | 'deprecated' | 'blocked' | 'pending';
  registeredAt?: string;
}

interface GovernanceProps {
  runs: Array<{
    runId: string;
    riskLevel: string;
    riskReasons: string[];
    requiredApprovals: string[];
    approvalStatus: string;
    createdAt: string;
  }>;
  incidents: Array<{
    id: string;
    incidentType: string;
    severity: string;
    summary: string;
    status: string;
    createdAt: string;
  }>;
  policies: Array<{
    id: string;
    name: string;
    enabled: boolean;
    version: number;
  }>;
  /** Pending approvals for the active workspace */
  requiredApprovals?: string[];
  approvalStatus?: 'pending' | 'approved' | 'denied' | 'not_required';
  /** Policy evaluation results for each run */
  policyEvaluations?: PolicyEvaluation[];
  /** Registered models in the workspace */
  registeredModels?: RegisteredModel[];
  /** Detailed risk information for runs */
  riskDetails?: RiskDetail[];
  /** Export audit evidence callback */
  onExportAudit?: (format: 'json' | 'csv' | 'pdf') => void;
  /** Loading state for governance data */
  loading?: boolean;
}

const riskColors: Record<string, string> = {
  low: '#238636',
  medium: '#d29922',
  high: '#da3633',
  blocked: '#8b949e',
};

const severityColors: Record<string, string> = {
  low: '#238636',
  medium: '#d29922',
  high: '#da3633',
  critical: '#f00',
};

const approvalStatusColors: Record<string, string> = {
  pending: '#d29922',
  approved: '#238636',
  denied: '#da3633',
  not_required: '#8b949e',
};

const modelStatusColors: Record<string, string> = {
  active: '#238636',
  deprecated: '#8b949e',
  blocked: '#da3633',
  pending: '#d29922',
};

const policyStatusColors: Record<string, string> = {
  pass: '#238636',
  fail: '#da3633',
  warning: '#d29922',
  error: '#f85149',
};

const exportButtonStyle: React.CSSProperties = {
  padding: '4px 10px',
  border: '1px solid #30363d',
  borderRadius: '4px',
  backgroundColor: '#21262d',
  color: '#c9d1d9',
  fontSize: '11px',
  cursor: 'pointer',
  fontWeight: 500,
};

const sectionCardStyle: React.CSSProperties = {
  padding: '10px 12px',
  border: '1px solid #30363d',
  borderRadius: '6px',
  marginBottom: '6px',
};

const badgeStyle: React.CSSProperties = {
  padding: '2px 8px',
  borderRadius: '10px',
  fontSize: '10px',
  color: '#fff',
  fontWeight: 600,
  textTransform: 'uppercase',
};

export const AiGovernanceCenter: React.FC<GovernanceProps> = ({
  runs, incidents, policies, requiredApprovals, approvalStatus,
  policyEvaluations = [], registeredModels = [], riskDetails = [],
  onExportAudit,
  loading = false,
}) => {
  const [expandedRunIds, setExpandedRunIds] = useState<Record<string, boolean>>({});
  const [expandedRiskRunIds, setExpandedRiskRunIds] = useState<Record<string, boolean>>({});
  const [exporting, setExporting] = useState<string | null>(null);

  const toggleRunExpand = (runId: string) => {
    setExpandedRunIds(prev => ({ ...prev, [runId]: !prev[runId] }));
  };

  const toggleRiskExpand = (runId: string) => {
    setExpandedRiskRunIds(prev => ({ ...prev, [runId]: !prev[runId] }));
  };

  const handleExport = async (format: 'json' | 'csv' | 'pdf') => {
    if (!onExportAudit) return;
    setExporting(format);
    try {
      await onExportAudit(format);
    } finally {
      setExporting(null);
    }
  };

  return (
    <div>
      <div style={{ marginBottom: '20px' }}>
        <h2 style={{ fontSize: '16px', marginBottom: '4px', color: '#e1e4e8' }}>AI Governance Center</h2>
        <p style={{ fontSize: '12px', color: '#8b949e', margin: 0 }}>
          Run risk summaries, approvals, incidents, policy registry, and model/provider registry.
        </p>
      </div>

      {/* Loading indicator */}
      {loading && (
        <div
          role="status"
          aria-label="Loading governance data"
          style={{
            padding: '24px',
            textAlign: 'center',
            color: '#8b949e',
            fontSize: '13px',
          }}
        >
          <div style={{
            width: '28px', height: '28px',
            border: '2px solid #30363d',
            borderTopColor: '#58a6ff',
            borderRadius: '50%',
            animation: 'gov-spin 0.8s linear infinite',
            margin: '0 auto 10px',
          }} />
          Loading governance data...
          <style>{`@keyframes gov-spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}

      {!loading && (<>

      {/* 1. Recent Runs with Risk Details */}
      <div style={{ marginBottom: '20px' }}>
        <h3 style={{ fontSize: '14px', marginBottom: '8px', color: '#e1e4e8' }}>Recent Runs</h3>
        {runs.length === 0 ? (
          <div style={{ color: '#8b949e', fontSize: '13px', padding: '12px', border: '1px dashed #30363d', borderRadius: '6px' }}>
            No runs yet. Create a workspace and run a query to see governance summary.
          </div>
        ) : (
          runs.map(run => (
            <div key={run.runId}>
              <div style={{
                padding: '10px 12px',
                border: '1px solid #30363d',
                borderRadius: '6px',
                marginBottom: '4px',
                cursor: 'pointer',
              }}
                onClick={() => toggleRunExpand(run.runId)}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                  <div style={{ color: '#e1e4e8', fontWeight: 500, fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ color: '#8b949e', fontSize: '10px' }}>{expandedRunIds[run.runId] ? '▼' : '▶'}</span>
                    Run {run.runId.slice(0, 16)}...
                  </div>
                  <span style={{
                    ...badgeStyle,
                    backgroundColor: riskColors[run.riskLevel] || '#30363d',
                  }}>
                    {run.riskLevel}
                  </span>
                </div>
                <div style={{ fontSize: '12px', color: '#8b949e' }}>
                  {run.riskReasons.slice(0, 2).map((r, i) => (
                    <div key={i}>• {r}</div>
                  ))}
                  {run.riskReasons.length > 2 && <div>+{run.riskReasons.length - 2} more</div>}
                </div>

                {/* 5. Risk Details Panel (expandable within each run) */}
                {expandedRunIds[run.runId] && (
                  <div style={{ marginTop: '10px', borderTop: '1px solid #30363d', paddingTop: '10px' }}>
                    {riskDetails
                      .filter(rd => rd.runId === run.runId)
                      .map((rd, i) => (
                        <div key={i} style={{ ...sectionCardStyle, marginBottom: '4px', padding: '8px 10px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                            <span style={{ color: '#e1e4e8', fontSize: '12px', fontWeight: 600 }}>{rd.category}</span>
                            {rd.score !== undefined && (
                              <span style={{ fontSize: '11px', color: rd.score >= 70 ? '#da3633' : rd.score >= 40 ? '#d29922' : '#238636' }}>
                                Score: {rd.score}
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize: '11px', color: '#8b949e', marginBottom: rd.remediation ? '6px' : '0' }}>
                            {rd.details}
                          </div>
                          {rd.remediation && (
                            <div style={{ fontSize: '11px', color: '#58a6ff', fontStyle: 'italic' }}>
                              Remediation: {rd.remediation}
                            </div>
                          )}
                        </div>
                      ))}
                    {riskDetails.filter(rd => rd.runId === run.runId).length === 0 && (
                      <div style={{ fontSize: '11px', color: '#8b949e', fontStyle: 'italic' }}>
                        No detailed risk assessment available for this run.
                      </div>
                    )}

                    {/* Approval info per run */}
                    {run.requiredApprovals.length > 0 && (
                      <div style={{ marginTop: '8px' }}>
                        <div style={{ fontSize: '11px', color: '#8b949e', marginBottom: '4px' }}>Required Approvals:</div>
                        {run.requiredApprovals.map((a, i) => (
                          <div key={i} style={{
                            display: 'inline-block',
                            padding: '2px 6px',
                            margin: '2px 4px 2px 0',
                            border: '1px solid #30363d',
                            borderRadius: '4px',
                            fontSize: '10px',
                            color: '#c9d1d9',
                          }}>
                            {a}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* 5. Risk Details standalone section (clickable) */}
              {riskDetails.filter(rd => rd.runId === run.runId).length > 0 && (
                <div
                  style={{
                    marginBottom: '6px',
                    marginLeft: '16px',
                    padding: '6px 10px',
                    borderLeft: '2px solid #d29922',
                    borderRadius: '0 4px 4px 0',
                    cursor: 'pointer',
                    fontSize: '11px',
                    color: '#c9d1d9',
                  }}
                  onClick={() => toggleRiskExpand(run.runId)}
                >
                  <span style={{ color: '#d29922', marginRight: '4px' }}>{expandedRiskRunIds[run.runId] ? '▼' : '▶'}</span>
                  Risk Details ({riskDetails.filter(rd => rd.runId === run.runId).length} items)
                  {expandedRiskRunIds[run.runId] && (
                    <div style={{ marginTop: '6px' }}>
                      {riskDetails
                        .filter(rd => rd.runId === run.runId)
                        .map((rd, i) => (
                          <div key={i} style={{ ...sectionCardStyle, marginBottom: '3px', padding: '6px 8px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '2px' }}>
                              <span style={{ color: '#e1e4e8', fontWeight: 600, fontSize: '11px' }}>{rd.category}</span>
                              {rd.score !== undefined && (
                                <span style={{ fontSize: '10px', color: rd.score >= 70 ? '#da3633' : rd.score >= 40 ? '#d29922' : '#238636' }}>
                                  Score: {rd.score}
                                </span>
                              )}
                            </div>
                            <div style={{ fontSize: '10px', color: '#8b949e' }}>{rd.details}</div>
                            {rd.remediation && (
                              <div style={{ fontSize: '10px', color: '#58a6ff', marginTop: '2px' }}>→ {rd.remediation}</div>
                            )}
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* 2. Policy Evaluation Results */}
      {policyEvaluations.length > 0 && (
        <div style={{ marginBottom: '20px' }}>
          <h3 style={{ fontSize: '14px', marginBottom: '8px', color: '#e1e4e8' }}>
            Policy Evaluation Results
            <span style={{ marginLeft: '8px', fontSize: '11px', color: '#8b949e', fontWeight: 400 }}>
              ({policyEvaluations.length} rules evaluated)
            </span>
          </h3>
          {policyEvaluations.map((pe, i) => (
            <div key={i} style={{
              ...sectionCardStyle,
              borderLeft: `3px solid ${policyStatusColors[pe.status] || '#8b949e'}`,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ color: '#e1e4e8', fontWeight: 500, fontSize: '12px' }}>{pe.policyName}</span>
                  <span style={{ fontSize: '10px', color: '#8b949e' }}>rule: {pe.rule}</span>
                </div>
                <span style={{
                  ...badgeStyle,
                  backgroundColor: policyStatusColors[pe.status] || '#8b949e',
                  fontSize: '9px',
                }}>
                  {pe.status}
                </span>
              </div>
              <div style={{ fontSize: '11px', color: '#8b949e' }}>
                {pe.detail}
              </div>
              {pe.runId && (
                <div style={{ fontSize: '10px', color: '#484f58', marginTop: '4px' }}>
                  Run: {pe.runId.slice(0, 16)}...
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 3. Model Registry */}
      {registeredModels.length > 0 && (
        <div style={{ marginBottom: '20px' }}>
          <h3 style={{ fontSize: '14px', marginBottom: '8px', color: '#e1e4e8' }}>
            Model Registry
            <span style={{ marginLeft: '8px', fontSize: '11px', color: '#8b949e', fontWeight: 400 }}>
              ({registeredModels.length} models)
            </span>
          </h3>
          {registeredModels.map((m, i) => (
            <div key={i} style={sectionCardStyle}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ color: '#e1e4e8', fontWeight: 500, fontSize: '13px' }}>{m.name}</span>
                  <span style={{ fontSize: '10px', color: '#8b949e' }}>v{m.version}</span>
                </div>
                <span style={{
                  ...badgeStyle,
                  backgroundColor: modelStatusColors[m.status] || '#8b949e',
                }}>
                  {m.status}
                </span>
              </div>
              <div style={{ display: 'flex', gap: '12px', fontSize: '11px', color: '#8b949e' }}>
                <span>Provider: {m.provider}</span>
                <span>ID: {m.modelId.slice(0, 20)}...</span>
                {m.registeredAt && <span>Registered: {m.registeredAt}</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 1. Enhanced Approval Status Display */}
      {requiredApprovals && requiredApprovals.length > 0 && (
        <div style={{ marginBottom: '20px' }}>
          <h3 style={{ fontSize: '14px', marginBottom: '8px', color: '#e1e4e8' }}>
            Pending Approvals
            <span style={{
              marginLeft: '8px', padding: '2px 8px', borderRadius: '10px', fontSize: '10px',
              backgroundColor: approvalStatusColors[approvalStatus || 'pending'] + '22',
              color: approvalStatusColors[approvalStatus || 'pending'],
              fontWeight: 600,
              textTransform: 'uppercase',
              border: `1px solid ${approvalStatusColors[approvalStatus || 'pending']}44`,
            }}>
              {approvalStatus || 'pending'}
            </span>
          </h3>
          <div style={{ fontSize: '12px', color: '#8b949e', marginBottom: '8px' }}>
            {requiredApprovals.length} approval{requiredApprovals.length !== 1 ? 's' : ''} required for the active workspace
          </div>
          {requiredApprovals.map((a, i) => (
            <div key={i} style={{
              padding: '8px 12px', border: '1px solid #30363d', borderRadius: '4px',
              marginBottom: '6px', fontSize: '13px', color: '#e1e4e8',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <span>{a}</span>
              <span style={{
                fontSize: '10px',
                padding: '2px 6px',
                borderRadius: '4px',
                backgroundColor: approvalStatus === 'approved' ? '#23863622' : approvalStatus === 'denied' ? '#da363322' : '#d2992222',
                color: approvalStatus === 'approved' ? '#238636' : approvalStatus === 'denied' ? '#da3633' : '#d29922',
                fontWeight: 500,
              }}>
                {approvalStatus === 'approved' ? 'Approved' : approvalStatus === 'denied' ? 'Denied' : 'Awaiting'}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Incidents */}
      <div style={{ marginBottom: '20px' }}>
        <h3 style={{ fontSize: '14px', marginBottom: '8px', color: '#e1e4e8' }}>
          Incidents {incidents.length > 0 && <span style={{ color: '#da3633' }}>({incidents.length})</span>}
        </h3>
        {incidents.length === 0 ? (
          <div style={{ color: '#8b949e', fontSize: '13px', padding: '12px', border: '1px dashed #30363d', borderRadius: '6px' }}>
            No incidents recorded.
          </div>
        ) : (
          incidents.map(inc => (
            <div key={inc.id} style={{
              padding: '10px 12px',
              border: `1px solid ${inc.status === 'open' ? '#da3633' : '#30363d'}`,
              borderRadius: '6px',
              marginBottom: '6px',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{
                    padding: '2px 8px',
                    borderRadius: '10px',
                    fontSize: '10px',
                    backgroundColor: severityColors[inc.severity] || '#8b949e',
                    color: '#fff',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                  }}>
                    {inc.severity}
                  </span>
                  <span style={{ color: '#e1e4e8', fontSize: '13px' }}>{inc.incidentType}</span>
                </div>
                <span style={{
                  padding: '2px 6px',
                  borderRadius: '4px',
                  fontSize: '10px',
                  backgroundColor: inc.status === 'open' ? '#da363322' : '#23863622',
                  color: inc.status === 'open' ? '#da3633' : '#238636',
                  fontWeight: 500,
                }}>
                  {inc.status}
                </span>
              </div>
              <div style={{ fontSize: '12px', color: '#8b949e' }}>{inc.summary}</div>
              {inc.createdAt && (
                <div style={{ fontSize: '10px', color: '#484f58', marginTop: '4px' }}>
                  {inc.createdAt}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Policy Registry */}
      <div style={{ marginBottom: '20px' }}>
        <h3 style={{ fontSize: '14px', marginBottom: '8px', color: '#e1e4e8' }}>Policy Registry</h3>
        {policies.map(p => (
          <div key={p.id} style={{
            padding: '8px 12px',
            border: '1px solid #30363d',
            borderRadius: '6px',
            marginBottom: '4px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}>
            <div>
              <span style={{ color: '#e1e4e8', fontWeight: 500 }}>{p.name}</span>
              <span style={{ color: '#8b949e', fontSize: '12px', marginLeft: '8px' }}>v{p.version}</span>
              <span style={{ color: '#484f58', fontSize: '10px', marginLeft: '8px' }}>{p.id}</span>
            </div>
            <span style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              backgroundColor: p.enabled ? '#238636' : '#30363d',
            }} />
          </div>
        ))}
      </div>

      {/* 4. Audit Evidence Export */}
      {onExportAudit && (
        <div style={{ marginBottom: '20px' }}>
          <h3 style={{ fontSize: '14px', marginBottom: '8px', color: '#e1e4e8' }}>Audit Evidence Export</h3>
          <div style={{
            padding: '10px 12px',
            border: '1px solid #30363d',
            borderRadius: '6px',
          }}>
            <div style={{ fontSize: '12px', color: '#8b949e', marginBottom: '8px' }}>
              Export governance audit evidence combining runs, incidents, policies, and model registry data for compliance reporting.
            </div>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {(['json', 'csv', 'pdf'] as const).map(format => (
                <button
                  key={format}
                  onClick={() => handleExport(format)}
                  disabled={exporting === format}
                  style={{
                    ...exportButtonStyle,
                    opacity: exporting === format ? 0.6 : 1,
                    cursor: exporting === format ? 'not-allowed' : 'pointer',
                  }}
                >
                  {exporting === format ? 'Exporting...' : `Export ${format.toUpperCase()}`}
                </button>
              ))}
            </div>
            <div style={{ fontSize: '10px', color: '#484f58', marginTop: '8px' }}>
              Data points: {runs.length} runs, {incidents.length} incidents, {policies.length} policies, {registeredModels.length} models
            </div>
          </div>
        </div>
      )}

      </>)} {/* end !loading */}

      {/* Empty state when no data loaded yet */}
      {!loading && runs.length === 0 && incidents.length === 0 && policyEvaluations.length === 0 && (
        <div
          role="status"
          style={{
            padding: '28px',
            border: '1px dashed #30363d',
            borderRadius: '8px',
            textAlign: 'center',
            background: '#161b22',
            marginBottom: '20px',
          }}
        >
          <div style={{ fontSize: '36px', marginBottom: '10px' }}>⚖️</div>
          <h3 style={{ fontSize: '15px', fontWeight: 600, color: '#e1e4e8', margin: '0 0 6px' }}>
            No Governance Data
          </h3>
          <p style={{ fontSize: '13px', color: '#8b949e', maxWidth: '420px', margin: '0 auto', lineHeight: 1.6 }}>
            Run tasks from the "run" tab to populate governance data including risk assessments,
            policy evaluations, and compliance records.
          </p>
        </div>
      )}
    </div>
  );
};
