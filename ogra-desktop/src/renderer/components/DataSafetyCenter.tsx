import React from 'react';

interface InheritanceChainItem {
  source: string;
  classification: string;
  childCount?: number;
  inheritedBy?: number;
}

interface AllowlistEntry {
  classification: string;
  allowedModels: string[];
  allowedProviders: string[];
}

interface ClassificationAdjustment {
  pendingCount: number;
  recentAdjustments: Array<{
    target: string;
    from: string;
    to: string;
    adjustedAt: string;
    reason: string;
  }>;
}

interface DataSafetyProps {
  summary: {
    totalAssets: number;
    byClassification: Record<string, number>;
    knowledgeBases: Array<{
      id: string;
      name: string;
      classification: string;
      fileCount: number;
      indexedStatus: string;
    }>;
    recentAccess: Array<{
      documentId: string;
      fileName: string;
      classification: string;
      accessedAt: string;
    }>;
    recentCloudCalls: number;
    zeroCloudCallRuns: number;
    limitationNote: string;
    memoryStats: {
      episodic: number;
      semantic: number;
      procedural: number;
      total: number;
    };
    agentGroupStats: {
      total: number;
      pipeline: number;
      completed: number;
    };
    // --- B31 Enhanced fields (optional, backward compatible) ---
    inheritanceChain?: InheritanceChainItem[];
    allowlist?: AllowlistEntry[];
    classificationAdjustments?: ClassificationAdjustment;
  };
  onAdjustClassification?: (target: string, newClassification: string) => void;
}

const classificationColors: Record<string, string> = {
  Public: '#238636',
  Internal: '#d29922',
  Confidential: '#f0883e',
  Restricted: '#da3633',
};

const CLASSIFICATIONS = ['Public', 'Internal', 'Confidential', 'Restricted'];

export const DataSafetyCenter: React.FC<DataSafetyProps> = ({ summary, onAdjustClassification }) => {
  const hasNoData = summary.totalAssets === 0
    && summary.knowledgeBases.length === 0
    && summary.recentAccess.length === 0
    && summary.recentCloudCalls === 0
    && summary.zeroCloudCallRuns === 0
    && summary.memoryStats.total === 0
    && summary.agentGroupStats.total === 0;

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: '20px' }}>
        <h2 style={{ fontSize: '16px', marginBottom: '4px', color: '#e1e4e8' }}>Data Safety Center</h2>
        <p style={{ fontSize: '12px', color: '#8b949e', margin: 0 }}>
          Data asset map, classification summary, provider/model allowlist, and cloud call ledger.
        </p>
      </div>

      {/* Empty state when no data exists */}
      {hasNoData && (
        <div
          role="status"
          style={{
            marginBottom: '20px',
            padding: '32px',
            border: '1px dashed #30363d',
            borderRadius: '8px',
            textAlign: 'center',
            background: '#161b22',
          }}
        >
          <div style={{ fontSize: '40px', marginBottom: '12px' }}>🛡️</div>
          <h3 style={{ fontSize: '16px', fontWeight: 600, color: '#e1e4e8', margin: '0 0 8px' }}>
            No Data Safety Information
          </h3>
          <p style={{ fontSize: '13px', color: '#8b949e', maxWidth: '400px', margin: '0 auto', lineHeight: 1.6 }}>
            Create a workspace, import knowledge bases, and run queries to see data safety metrics,
            classification summaries, and cloud call tracking.
          </p>
        </div>
      )}

      {!hasNoData && (<>

      {/* Overview Cards */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: '12px',
        marginBottom: '20px',
      }}>
        <div style={cardStyle}>
          <div style={{ fontSize: '24px', fontWeight: 700, color: '#e1e4e8' }}>{summary.totalAssets}</div>
          <div style={{ fontSize: '12px', color: '#8b949e' }}>Total Assets</div>
        </div>
        <div style={cardStyle}>
          <div style={{ fontSize: '24px', fontWeight: 700, color: '#238636' }}>{summary.zeroCloudCallRuns}</div>
          <div style={{ fontSize: '12px', color: '#8b949e' }}>0 Cloud Call Runs</div>
        </div>
        <div style={cardStyle}>
          <div style={{ fontSize: '24px', fontWeight: 700, color: '#da3633' }}>{summary.recentCloudCalls}</div>
          <div style={{ fontSize: '12px', color: '#8b949e' }}>Cloud Calls</div>
        </div>
      </div>

      {/* Classification Breakdown */}
      <div style={{ marginBottom: '20px' }}>
        <h3 style={{ fontSize: '14px', marginBottom: '8px', color: '#e1e4e8' }}>By Classification</h3>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {Object.entries(summary.byClassification).map(([cls, count]) => (
            <div key={cls} style={{
              padding: '8px 12px',
              backgroundColor: '#0d1117',
              border: '1px solid #30363d',
              borderRadius: '6px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}>
              <span style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                backgroundColor: classificationColors[cls] || '#8b949e',
              }} />
              <span style={{ color: '#e1e4e8', fontWeight: 500 }}>{cls}</span>
              <span style={{ color: '#8b949e' }}>{count}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Asset Breakdown */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
        gap: '8px',
        marginBottom: '20px',
      }}>
        <div style={{ ...cardStyle, borderColor: '#58a6ff' }}>
          <div style={{ fontSize: '20px', fontWeight: 700, color: '#58a6ff' }}>{summary.memoryStats.total}</div>
          <div style={{ fontSize: '12px', color: '#8b949e' }}>Memories (M3)</div>
          <div style={{ fontSize: '10px', color: '#8b949e', marginTop: '4px' }}>
            {summary.memoryStats.episodic} episodic · {summary.memoryStats.semantic} semantic · {summary.memoryStats.procedural} procedural
          </div>
        </div>
        <div style={{ ...cardStyle, borderColor: '#f0883e' }}>
          <div style={{ fontSize: '20px', fontWeight: 700, color: '#f0883e' }}>{summary.agentGroupStats.total}</div>
          <div style={{ fontSize: '12px', color: '#8b949e' }}>Agent Group Runs</div>
          <div style={{ fontSize: '10px', color: '#8b949e', marginTop: '4px' }}>
            {summary.agentGroupStats.completed} completed · {summary.agentGroupStats.pipeline} pipeline
          </div>
        </div>
      </div>

      {/* ── Inheritance Chain (B31 Feature 1) ── */}
      {summary.inheritanceChain && summary.inheritanceChain.length > 0 && (
        <div style={{ marginBottom: '20px' }}>
          <h3 style={{ fontSize: '14px', marginBottom: '8px', color: '#e1e4e8' }}>Classification Inheritance Chain</h3>
          <div style={{
            padding: '12px',
            background: '#0d1117',
            border: '1px solid #30363d',
            borderRadius: '6px',
          }}>
            {summary.inheritanceChain.map((item, i) => (
              <div key={i} style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '4px 0',
                borderBottom: i < summary.inheritanceChain!.length - 1 ? '1px dashed #21262d' : 'none',
              }}>
                <span style={{
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  backgroundColor: classificationColors[item.classification] || '#8b949e',
                }} />
                <div style={{ flex: 1 }}>
                  <span style={{ color: '#e1e4e8', fontSize: '13px' }}>{item.source}</span>
                  <span style={{
                    marginLeft: '8px',
                    padding: '1px 6px',
                    borderRadius: '4px',
                    fontSize: '11px',
                    backgroundColor: (classificationColors[item.classification] || '#8b949e') + '33',
                    color: classificationColors[item.classification] || '#8b949e',
                    fontWeight: 500,
                  }}>
                    {item.classification}
                  </span>
                </div>
                <span style={{ fontSize: '11px', color: '#8b949e' }}>
                  {item.childCount !== undefined && `${item.childCount} children`}
                  {item.inheritedBy !== undefined && (item.childCount !== undefined ? ' · ' : '') + `${item.inheritedBy} inherited`}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Model / Provider Allowlist (B31 Feature 2) ── */}
      {summary.allowlist && summary.allowlist.length > 0 && (
        <div style={{ marginBottom: '20px' }}>
          <h3 style={{ fontSize: '14px', marginBottom: '8px', color: '#e1e4e8' }}>Model & Provider Allowlist</h3>
          {summary.allowlist.map((entry, i) => (
            <div key={i} style={{
              padding: '10px 12px',
              border: `1px solid ${classificationColors[entry.classification] || '#30363d'}`,
              borderRadius: '6px',
              marginBottom: '6px',
              background: '#161b22',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                <span style={{
                  width: '8px', height: '8px', borderRadius: '50%',
                  backgroundColor: classificationColors[entry.classification] || '#8b949e',
                }} />
                <span style={{ color: '#e1e4e8', fontWeight: 600, fontSize: '13px' }}>{entry.classification}</span>
              </div>
              <div style={{ fontSize: '12px', color: '#8b949e', marginLeft: '16px' }}>
                <div><strong style={{ color: '#c9d1d9' }}>Models:</strong> {entry.allowedModels.join(', ') || '—'}</div>
                <div><strong style={{ color: '#c9d1d9' }}>Providers:</strong> {entry.allowedProviders.join(', ') || '—'}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Knowledge Bases */}
      {summary.knowledgeBases.length > 0 && (
        <div style={{ marginBottom: '20px' }}>
          <h3 style={{ fontSize: '14px', marginBottom: '8px', color: '#e1e4e8' }}>Knowledge Bases</h3>
          {summary.knowledgeBases.map(kb => (
            <div key={kb.id} style={{
              padding: '10px 12px',
              border: '1px solid #30363d',
              borderRadius: '6px',
              marginBottom: '6px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}>
              <div>
                <div style={{ color: '#e1e4e8', fontWeight: 500 }}>{kb.name}</div>
                <div style={{ fontSize: '12px', color: '#8b949e' }}>{kb.fileCount} files · {kb.indexedStatus}</div>
              </div>
              <span style={{
                padding: '2px 8px',
                borderRadius: '10px',
                fontSize: '11px',
                backgroundColor: classificationColors[kb.classification] || '#30363d',
                color: '#fff',
                fontWeight: 500,
              }}>
                {kb.classification}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* ── Recent Access (B31 Feature 3 — enhanced) ── */}
      {summary.recentAccess && summary.recentAccess.length > 0 && (
        <div style={{ marginBottom: '20px' }}>
          <h3 style={{ fontSize: '14px', marginBottom: '8px', color: '#e1e4e8' }}>
            Recent Access <span style={{ fontSize: '11px', color: '#8b949e', fontWeight: 400 }}>(last {summary.recentAccess.length})</span>
          </h3>
          {summary.recentAccess.map((access, i) => (
            <div key={access.documentId + i} style={{
              padding: '8px 12px', border: '1px solid #30363d', borderRadius: '4px',
              marginBottom: '6px', fontSize: '13px', background: '#161b22',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{
                  width: '6px', height: '6px', borderRadius: '50%', flexShrink: 0,
                  backgroundColor: classificationColors[access.classification] || '#8b949e',
                }} />
                <span style={{ color: '#e1e4e8', flex: 1 }}>{access.fileName}</span>
              </div>
              <div style={{ fontSize: '12px', color: '#8b949e', marginTop: '2px', marginLeft: '14px' }}>
                <span style={{
                  padding: '1px 5px', borderRadius: '3px', fontSize: '10px',
                  backgroundColor: (classificationColors[access.classification] || '#8b949e') + '33',
                  color: classificationColors[access.classification] || '#8b949e',
                  marginRight: '6px',
                }}>
                  {access.classification}
                </span>
                {new Date(access.accessedAt).toLocaleString()}
                <span style={{ marginLeft: '8px', fontSize: '10px', color: '#484f58' }}>ID: {access.documentId.slice(0, 12)}…</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Classification Adjustments (B31 Feature 4) ── */}
      {summary.classificationAdjustments && (
        <div style={{ marginBottom: '20px' }}>
          <h3 style={{ fontSize: '14px', marginBottom: '8px', color: '#e1e4e8' }}>
            Classification Adjustments
            {summary.classificationAdjustments.pendingCount > 0 && (
              <span style={{
                marginLeft: '8px', padding: '1px 6px', borderRadius: '8px',
                fontSize: '11px', backgroundColor: '#da363333', color: '#ff7b72',
                fontWeight: 600,
              }}>
                {summary.classificationAdjustments.pendingCount} pending
              </span>
            )}
          </h3>

          {/* Quick-adjust controls */}
          {onAdjustClassification && (
            <div style={{
              padding: '10px 12px', border: '1px solid #30363d', borderRadius: '6px',
              marginBottom: '8px', background: '#161b22',
            }}>
              <div style={{ fontSize: '12px', color: '#8b949e', marginBottom: '6px' }}>
                Quick reclassify knowledge bases:
              </div>
              {summary.knowledgeBases.slice(0, 5).map(kb => (
                <div key={kb.id} style={{
                  display: 'flex', alignItems: 'center', gap: '6px',
                  padding: '4px 0', borderBottom: '1px solid #21262d',
                  fontSize: '12px',
                }}>
                  <span style={{ color: '#c9d1d9', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {kb.name}
                  </span>
                  <span style={{
                    padding: '1px 5px', borderRadius: '3px', fontSize: '10px',
                    backgroundColor: (classificationColors[kb.classification] || '#8b949e') + '33',
                    color: classificationColors[kb.classification] || '#8b949e',
                  }}>
                    {kb.classification}
                  </span>
                  <select
                    onChange={(e) => onAdjustClassification(kb.id, e.target.value)}
                    defaultValue=""
                    style={{
                      padding: '2px 4px', borderRadius: '3px', fontSize: '11px',
                      border: '1px solid #30363d', background: '#0d1117', color: '#c9d1d9',
                      cursor: 'pointer',
                    }}
                  >
                    <option value="" disabled>→</option>
                    {CLASSIFICATIONS.map(c => (
                      <option key={c} value={c} disabled={c === kb.classification}>{c}</option>
                    ))}
                  </select>
                </div>
              ))}
              {summary.knowledgeBases.length > 5 && (
                <div style={{ fontSize: '11px', color: '#484f58', marginTop: '4px', textAlign: 'center' }}>
                  + {summary.knowledgeBases.length - 5} more (scroll full list above)
                </div>
              )}
            </div>
          )}

          {/* Recent adjustment history */}
          {summary.classificationAdjustments.recentAdjustments.length > 0 && (
            <div style={{
              padding: '8px 12px', border: '1px solid #30363d', borderRadius: '6px',
              background: '#0d1117',
            }}>
              <div style={{ fontSize: '12px', color: '#8b949e', marginBottom: '4px' }}>Recent changes:</div>
              {summary.classificationAdjustments.recentAdjustments.slice(0, 5).map((adj, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: '4px',
                  fontSize: '12px', padding: '3px 0',
                  borderBottom: i < Math.min(summary.classificationAdjustments!.recentAdjustments.length, 5) - 1 ? '1px solid #21262d' : 'none',
                }}>
                  <span style={{ color: '#c9d1d9', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {adj.target}
                  </span>
                  <span style={{ color: classificationColors[adj.from] || '#8b949e', fontSize: '11px' }}>{adj.from}</span>
                  <span style={{ color: '#8b949e' }}>→</span>
                  <span style={{ color: classificationColors[adj.to] || '#58a6ff', fontSize: '11px', fontWeight: 500 }}>{adj.to}</span>
                  <span style={{ fontSize: '10px', color: '#484f58', marginLeft: '4px' }}>
                    {new Date(adj.adjustedAt).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Limitation Note */}
      <div style={{
        padding: '12px',
        border: '1px solid #30363d',
        borderRadius: '6px',
        fontSize: '12px',
        color: '#8b949e',
        backgroundColor: '#0d1117',
        lineHeight: 1.5,
      }}>
        {summary.limitationNote}
      </div>
      </>)}
    </div>
  );
};

const cardStyle: React.CSSProperties = {
  padding: '16px',
  backgroundColor: '#0d1117',
  border: '1px solid #30363d',
  borderRadius: '8px',
};
