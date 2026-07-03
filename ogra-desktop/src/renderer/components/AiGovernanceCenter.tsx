import React from 'react';

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

export const AiGovernanceCenter: React.FC<GovernanceProps> = ({ runs, incidents, policies }) => {
  return (
    <div>
      <div style={{ marginBottom: '20px' }}>
        <h2 style={{ fontSize: '16px', marginBottom: '4px', color: '#e1e4e8' }}>AI Governance Center</h2>
        <p style={{ fontSize: '12px', color: '#8b949e', margin: 0 }}>
          Run risk summaries, approvals, incidents, policy registry, and model/provider registry.
        </p>
      </div>

      {/* Recent Runs */}
      <div style={{ marginBottom: '20px' }}>
        <h3 style={{ fontSize: '14px', marginBottom: '8px', color: '#e1e4e8' }}>Recent Runs</h3>
        {runs.length === 0 ? (
          <div style={{ color: '#8b949e', fontSize: '13px', padding: '12px', border: '1px dashed #30363d', borderRadius: '6px' }}>
            No runs yet. Create a workspace and run a query to see governance summary.
          </div>
        ) : (
          runs.map(run => (
            <div key={run.runId} style={{
              padding: '10px 12px',
              border: '1px solid #30363d',
              borderRadius: '6px',
              marginBottom: '6px',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <div style={{ color: '#e1e4e8', fontWeight: 500, fontSize: '13px' }}>
                  Run {run.runId.slice(0, 16)}...
                </div>
                <span style={{
                  padding: '2px 8px',
                  borderRadius: '10px',
                  fontSize: '11px',
                  backgroundColor: riskColors[run.riskLevel] || '#30363d',
                  color: '#fff',
                  fontWeight: 600,
                  textTransform: 'uppercase',
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
            </div>
          ))
        )}
      </div>

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
            </div>
          ))
        )}
      </div>

      {/* Policy Registry */}
      <div>
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
    </div>
  );
};
