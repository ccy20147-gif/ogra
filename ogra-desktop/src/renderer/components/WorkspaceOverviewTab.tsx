import React from 'react';
import { buttonStyle, secondaryButtonStyle } from '../styles';

interface Workspace {
  id: string;
  name: string;
  type: string;
  defaultClassification: string;
  createdAt: string;
}

interface WorkspaceOverviewTabProps {
  workspaces: Workspace[];
  currentWorkspace: Workspace | null;
  status: string;
  safetySummary: any;
  policies: any[];
  providers: any[];
  recentRuns: any[];
  onCreateWorkspace: () => void;
  onRefreshWorkspaces: () => void;
  onSelectWorkspace: (id: string) => void;
  loading?: boolean;
  /**
   * Optional real-data overrides for the four quick-glance cards.
   * When provided, the card uses the override instead of deriving
   * from `recentRuns` / `safetySummary`. Parent (App.tsx) computes
   * these from the data sources it owns; this component keeps the
   * fallback for callers that only pass the legacy props.
   */
  agentCount?: number;
  memoryTotalCount?: number;
  openIncidentCount?: number;
  cloudCallTotalCount?: number;
}

const cardCx: React.CSSProperties = {
  padding: '12px 14px',
  border: '1px solid #30363d',
  borderRadius: '6px',
  marginBottom: '12px',
  background: '#161b22',
};

const sectionTitle: React.CSSProperties = {
  fontSize: '13px',
  fontWeight: 600,
  color: '#c9d1d9',
  marginBottom: '8px',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
};

const labelValue: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  fontSize: '13px',
  padding: '3px 0',
  borderBottom: '1px solid #21262d',
};

const WorkspaceOverviewTab: React.FC<WorkspaceOverviewTabProps> = ({
  workspaces,
  currentWorkspace,
  status,
  safetySummary,
  policies,
  providers,
  recentRuns,
  onCreateWorkspace,
  onRefreshWorkspaces,
  onSelectWorkspace,
  loading = false,
  agentCount,
  memoryTotalCount,
  openIncidentCount,
  cloudCallTotalCount,
}) => {
  const kbs = safetySummary?.knowledgeBases;
  const kbCount = kbs?.length || 0;
  const kbSuccessCount = kbs?.filter((kb: any) => kb.indexedStatus === 'succeeded').length || 0;
  const totalAssets = safetySummary?.totalAssets ?? 0;

  const classificationDist = safetySummary?.byClassification || {};
  const classKeys = ['Public', 'Internal', 'Confidential', 'Restricted'];

  const activePolicies = policies.filter((p: any) => p.enabled !== false);
  const totalPolicies = policies.length;

  const localProviders = providers.filter((p: any) => p.isLocal).length;
  const cloudProviders = providers.filter((p: any) => !p.isLocal).length;
  const totalModels = providers.reduce((acc: number, p: any) => acc + (p.models?.length || 0), 0);

  // ── Derived data for the 4b summary cards ──
  // Until a dedicated agents IPC lands, fall back to the set of agent
  // ids embedded in the policy/pipeline state. Memory / incidents /
  // cloud-call counts come from safetySummary and recentRuns.
  // When the parent provides the optional override props (agentCount,
  // memoryTotalCount, openIncidentCount, cloudCallTotalCount), those
  // win — they are computed at the App.tsx level where the underlying
  // data sources are owned.
  const policyDerivedAgents: string[] = Array.from(new Set([
    ...(activePolicies || []).map((p: any) => p.targetAgent || p.agentId).filter(Boolean),
    ...(recentRuns || []).map((r: any) => r.routeDecision?.assignedAdapter).filter(Boolean),
  ])) as string[];

  const agentsAvail = agentCount ?? policyDerivedAgents.length;

  const memoryCount =
    memoryTotalCount ??
    ((safetySummary?.memoryStats?.total as number | undefined) ??
      (safetySummary?.memoryStats?.episodic ?? 0) +
        (safetySummary?.memoryStats?.semantic ?? 0) +
        (safetySummary?.memoryStats?.procedural ?? 0));

  // Incidents aren't yet wired through safetySummary, so we count
  // blocked runs as a session-scoped proxy. When the incidents IPC
  // lands this is replaced with `safetySummary.openIncidents`.
  const incidentsFromRuns = (recentRuns || []).filter(
    (r: any) => r.status === 'blocked' || r.routeDecision?.route === 'blocked'
  ).length;
  const incidentCount = openIncidentCount ?? incidentsFromRuns;

  // Ogra-managed cloud calls. The summary already tracks total
  // recentCloudCalls + zeroCloudCallRuns; we surface the count here.
  const cloudCallCount = cloudCallTotalCount ?? (safetySummary?.recentCloudCalls ?? 0);

  return (
    <div>
      {/* Loading indicator */}
      {loading && (
        <div
          role="status"
          aria-label="Loading workspaces"
          style={{
            padding: '20px',
            textAlign: 'center',
            color: '#8b949e',
            fontSize: '13px',
          }}
        >
          <div style={{
            width: '24px', height: '24px',
            border: '2px solid #30363d',
            borderTopColor: '#58a6ff',
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
            margin: '0 auto 8px',
          }} />
          Loading workspaces...
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}

      <div style={{ marginBottom: '20px' }}>
        <h2 style={{ fontSize: '16px', marginBottom: '12px' }}>Workspace Overview</h2>
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          <button onClick={onCreateWorkspace} style={buttonStyle}>
            Create Workspace
          </button>
          <button onClick={onRefreshWorkspaces} style={secondaryButtonStyle}>
            Refresh
          </button>
        </div>
      </div>

      {currentWorkspace && (
        <div style={{
          padding: '12px', border: '1px solid #30363d', borderRadius: '6px',
          marginBottom: '16px', background: '#161b22',
        }}>
          <div style={{ fontWeight: 500, marginBottom: '8px' }}>
            Current: {currentWorkspace.name}
          </div>
          <div style={{ fontSize: '13px', color: '#8b949e' }}>
            Type: {currentWorkspace.type} · Classification: {currentWorkspace.defaultClassification}
          </div>
          <div style={{ fontSize: '13px', color: '#8b949e', marginTop: '4px' }}>
            Status: {status}
          </div>
        </div>
      )}

      {/* 1. Knowledge Base Summary */}
      <div style={cardCx}>
        <div style={sectionTitle}>📚 Knowledge Bases</div>
        <div style={labelValue}>
          <span style={{ color: '#8b949e' }}>Total KBs</span>
          <span style={{ fontWeight: 500 }}>{kbCount}</span>
        </div>
        {kbCount > 0 && (
          <div style={labelValue}>
            <span style={{ color: '#8b949e' }}>Indexed (success)</span>
            <span style={{ fontWeight: 500, color: '#3fb950' }}>{kbSuccessCount}</span>
          </div>
        )}
        <div style={labelValue}>
          <span style={{ color: '#8b949e' }}>Total assets</span>
          <span style={{ fontWeight: 500 }}>{totalAssets}</span>
        </div>
        {kbCount > 0 && (
          <div style={{ marginTop: '8px', fontSize: '12px', color: '#8b949e' }}>
            {kbs.slice(0, 3).map((kb: any) => (
              <div key={kb.id} style={{ padding: '2px 0' }}>
                {kb.name} — {kb.fileCount} files
                <span style={{
                  marginLeft: '6px',
                  color: kb.indexedStatus === 'succeeded' ? '#3fb950' : '#d29922',
                }}>
                  [{kb.indexedStatus}]
                </span>
              </div>
            ))}
            {kbCount > 3 && <div style={{ color: '#484f58', marginTop: '2px' }}>+{kbCount - 3} more</div>}
          </div>
        )}
      </div>

      {/* 2. Active Policies Summary */}
      <div style={cardCx}>
        <div style={sectionTitle}>🔒 Active Policies</div>
        <div style={labelValue}>
          <span style={{ color: '#8b949e' }}>Total policies</span>
          <span style={{ fontWeight: 500 }}>{totalPolicies}</span>
        </div>
        <div style={labelValue}>
          <span style={{ color: '#8b949e' }}>Enabled</span>
          <span style={{ fontWeight: 500, color: '#3fb950' }}>{activePolicies.length}</span>
        </div>
        <div style={labelValue}>
          <span style={{ color: '#8b949e' }}>Disabled</span>
          <span style={{ fontWeight: 500, color: '#f85149' }}>{totalPolicies - activePolicies.length}</span>
        </div>
        {activePolicies.length > 0 && (
          <div style={{ marginTop: '8px', fontSize: '12px', color: '#8b949e' }}>
            {activePolicies.slice(0, 4).map((p: any) => (
              <div key={p.id} style={{ padding: '2px 0' }}>
                {p.name} <span style={{ color: '#484f58' }}>v{p.version}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 3. Model Status */}
      <div style={cardCx}>
        <div style={sectionTitle}>🤖 Model Providers</div>
        <div style={labelValue}>
          <span style={{ color: '#8b949e' }}>Providers</span>
          <span style={{ fontWeight: 500 }}>{providers.length}</span>
        </div>
        <div style={labelValue}>
          <span style={{ color: '#8b949e' }}>Local</span>
          <span style={{ fontWeight: 500 }}>{localProviders}</span>
        </div>
        <div style={labelValue}>
          <span style={{ color: '#8b949e' }}>Cloud</span>
          <span style={{ fontWeight: 500 }}>{cloudProviders}</span>
        </div>
        <div style={labelValue}>
          <span style={{ color: '#8b949e' }}>Total models</span>
          <span style={{ fontWeight: 500 }}>{totalModels}</span>
        </div>
        {providers.length > 0 && (
          <div style={{ marginTop: '8px', fontSize: '12px', color: '#8b949e' }}>
            {providers.slice(0, 3).map((p: any) => (
              <div key={p.id} style={{ padding: '2px 0' }}>
                {p.name}
                <span style={{ color: '#484f58' }}>
                  {' '}({p.isLocal ? 'local' : 'cloud'} · {p.models?.length || 0} models)
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 4. Recent Runs Summary */}
      <div style={cardCx}>
        <div style={sectionTitle}>⚡ Recent Runs</div>
        {recentRuns.length > 0 ? (
          <>
            <div style={labelValue}>
              <span style={{ color: '#8b949e' }}>Total runs</span>
              <span style={{ fontWeight: 500 }}>{recentRuns.length}</span>
            </div>
            <div style={{ marginTop: '8px', fontSize: '12px' }}>
              {recentRuns.slice(0, 5).reverse().map((r: any) => (
                <div key={r.id} style={{
                  padding: '6px 8px', marginBottom: '4px',
                  border: '1px solid #21262d', borderRadius: '4px',
                  background: '#0d1117',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: '#c9d1d9', fontWeight: 500 }}>
                      {r.id?.substring(0, 12)}…
                    </span>
                    <span style={{
                      color: r.status === 'completed' || r.status === 'complete' ? '#3fb950'
                        : r.status === 'error' || r.status === 'failed' || r.status === 'blocked' ? '#f85149'
                        : r.status === 'running' || r.status === 'in_progress' ? '#58a6ff'
                        : '#d29922',
                    }}>
                      {r.status}
                    </span>
                  </div>
                  {r.routeDecision?.route && (
                    <div style={{ color: '#484f58', marginTop: '2px' }}>
                      Route: {r.routeDecision.route}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        ) : (
          <p style={{ fontSize: '13px', color: '#484f58', margin: 0 }}>
            No runs yet. Use the Run tab to execute a task.
          </p>
        )}
      </div>

      {/* 4b. Quick summary cards — derived from the data already in
          the component (runs, safetySummary, policies). No new IPC.
          Each card has a placeholder "real source" note where the
          underlying aggregation is still wired to a stub. */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: '12px',
        marginBottom: '20px',
      }}>
        <SummaryCard
          icon="🤖"
          label="Agents available"
          primary={agentsAvail}
          sub={agentsAvail === 0 ? 'No manifests registered' : `${policyDerivedAgents.slice(0, 2).join(', ')}…`}
        />
        <SummaryCard
          icon="🧠"
          label="Memory status"
          primary={memoryCount}
          sub={
            memoryCount === 0
              ? 'No episodic / semantic / procedural entries yet'
              : `${safetySummary?.memoryStats?.episodic ?? 0} episodic · ${safetySummary?.memoryStats?.semantic ?? 0} semantic`
          }
        />
        <SummaryCard
          icon="⚠️"
          label="Risk & incidents"
          primary={incidentCount}
          sub={incidentCount === 0 ? 'No open incidents' : `${incidentCount} incident${incidentCount === 1 ? '' : 's'} in current session`}
          tone={incidentCount > 0 ? 'warning' : 'neutral'}
        />
        <SummaryCard
          icon="☁️"
          label="Cloud calls"
          primary={cloudCallCount}
          sub={cloudCallCount === 0
            ? '0 Ogra-managed cloud calls this session'
            : `${cloudCallCount} cloud call${cloudCallCount === 1 ? '' : 's'} · ${recentRuns.length} run${recentRuns.length === 1 ? '' : 's'} total`}
          tone={cloudCallCount === 0 ? 'good' : 'neutral'}
        />
      </div>

      {/* 5. Risk / Classification Summary */}
      <div style={cardCx}>
        <div style={sectionTitle}>📊 Data Classification</div>
        {classKeys.map(cls => {
          const count = classificationDist[cls] ?? 0;
          return (
            <div key={cls} style={labelValue}>
              <span style={{
                color: cls === 'Restricted' ? '#f85149'
                  : cls === 'Confidential' ? '#d29922'
                  : cls === 'Internal' ? '#58a6ff'
                  : '#3fb950',
              }}>
                {cls}
              </span>
              <span style={{ fontWeight: 500 }}>{count}</span>
            </div>
          );
        })}
        <div style={{ ...labelValue, borderBottom: 'none', marginTop: '4px' }}>
          <span style={{ color: '#8b949e' }}>Total assets classified</span>
          <span style={{ fontWeight: 600 }}>{totalAssets}</span>
        </div>
      </div>

      {/* Existing Workspaces */}
      <div>
        <h3 style={{ fontSize: '14px', marginBottom: '8px' }}>Existing Workspaces</h3>
        {workspaces.length > 0 ? (
          workspaces.map(ws => (
            <div key={ws.id} style={{
              padding: '12px',
              border: '1px solid #21262d',
              borderRadius: '6px',
              marginBottom: '8px',
              cursor: 'pointer',
              backgroundColor: currentWorkspace?.id === ws.id ? '#161b22' : 'transparent',
            }}
            onClick={() => onSelectWorkspace(ws.id)}
            >
              <div style={{ fontWeight: 500 }}>{ws.name}</div>
              <div style={{ fontSize: '12px', color: '#8b949e', marginTop: '4px' }}>
                {ws.type} · {ws.defaultClassification}
              </div>
            </div>
          ))
        ) : (
          <div style={{
            padding: '16px',
            border: '1px dashed #30363d',
            borderRadius: '6px',
            textAlign: 'center',
            fontSize: '13px',
            color: '#8b949e',
          }}>
            <div style={{ fontSize: '24px', marginBottom: '8px' }}>📁</div>
            <div>No workspaces yet.</div>
            <div style={{ fontSize: '12px', marginTop: '4px', color: '#484f58' }}>
              Click <strong>"Create Workspace"</strong> above to create your first workspace
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default WorkspaceOverviewTab;

/**
 * Compact summary card used in the 4b quick-glance grid. Tones
 * influence the right border accent + primary color so the user can
 * scan for warnings at a glance.
 */
const SummaryCard: React.FC<{
  icon: string;
  label: string;
  primary: number | string;
  sub: string;
  tone?: 'neutral' | 'good' | 'warning' | 'danger';
}> = ({ icon, label, primary, sub, tone = 'neutral' }) => {
  const accent = (
    tone === 'good'    ? '#3fb950' :
    tone === 'warning' ? '#d29922' :
    tone === 'danger'  ? '#f85149' : '#484f58'
  );
  return (
    <div
      style={{
        ...cardCx,
        borderLeft: `3px solid ${accent}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
        <span aria-hidden="true" style={{ fontSize: '14px' }}>{icon}</span>
        <span style={{ fontSize: '11px', color: '#8b949e', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</span>
      </div>
      <div style={{ fontSize: '22px', fontWeight: 600, color: accent, fontVariantNumeric: 'tabular-nums' }}>{primary}</div>
      <div style={{ fontSize: '11px', color: '#8b949e', marginTop: '2px' }}>{sub}</div>
    </div>
  );
};
