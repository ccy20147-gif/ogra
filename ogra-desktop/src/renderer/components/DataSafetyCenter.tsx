import React, { useState } from 'react';

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
  /** Optional handler for the new "View Evidence" affordance. The dialog
   *  is rendered internally so a missing handler still shows the
   *  affordance in disabled state. */
  onViewEvidence?: (access: {
    documentId: string;
    fileName: string;
    classification: string;
    accessedAt: string;
  }) => void;
  onAdjustClassification?: (target: string, newClassification: string) => void;
}

const classificationColors: Record<string, string> = {
  Public: '#238636',
  Internal: '#d29922',
  Confidential: '#f0883e',
  Restricted: '#da3633',
};

const CLASSIFICATIONS = ['Public', 'Internal', 'Confidential', 'Restricted'];

export const DataSafetyCenter: React.FC<DataSafetyProps> = ({ summary, onAdjustClassification, onViewEvidence }) => {
  // Local "View Evidence" dialog state. Holds the access record whose
  // evidence is currently shown; null when the dialog is closed.
  const [evidenceAccess, setEvidenceAccess] = useState<{
    documentId: string;
    fileName: string;
    classification: string;
    accessedAt: string;
  } | null>(null);

  const openEvidence = (access: typeof evidenceAccess) => {
    if (!access) return;
    onViewEvidence?.(access);
    setEvidenceAccess(access);
  };
  const closeEvidence = () => setEvidenceAccess(null);

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
                  <button
                  type="button"
                  onClick={() => openEvidence(access)}
                  title="Open the evidence panel for this access event."
                  style={{
                    marginLeft: 'auto', padding: '2px 8px',
                    border: '1px solid #30363d', borderRadius: '3px',
                    background: 'transparent', color: '#58a6ff',
                    fontSize: '10px', cursor: 'pointer',
                  }}
                  >
                  View evidence
                  </button>
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

      {/* ── View-Evidence dialog (F-1) ──
          Inline, role=dialog, no portal needed. Backdrop click closes.
          Shows the access record + a placeholder for evidence rows that
          will be wired to `document_access_events` once a backend IPC
          exposes them. Until then the dialog is informational only. */}
      {evidenceAccess && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Evidence for ${evidenceAccess.fileName}`}
          onClick={closeEvidence}
          style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'rgba(0, 0, 0, 0.6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '20px',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#161b22',
              border: '1px solid #30363d',
              borderRadius: '8px',
              maxWidth: '520px', width: '100%',
              padding: '20px',
              boxShadow: 'rgba(0, 0, 0, 0.5) 0px 8px 24px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: '12px' }}>
              <h3 style={{ fontSize: '14px', color: '#e1e4e8', margin: 0, flex: 1 }}>
                Evidence — {evidenceAccess.fileName}
              </h3>
              <button
                type="button"
                onClick={closeEvidence}
                aria-label="Close evidence panel"
                style={{
                  padding: '2px 8px', border: '1px solid #30363d',
                  borderRadius: '4px', background: 'transparent',
                  color: '#8b949e', cursor: 'pointer', fontSize: '12px',
                }}
              >
                ✕
              </button>
            </div>
            <dl style={{ margin: 0, fontSize: '12px', lineHeight: 1.6 }}>
              <Row k="Document ID" v={evidenceAccess.documentId} mono />
              <Row k="Classification" v={evidenceAccess.classification} />
              <Row k="Accessed at" v={new Date(evidenceAccess.accessedAt).toLocaleString()} />
              <Row k="Run ID" v="(not yet wired to a specific run)" />
              <Row k="Audit event IDs" v="(not yet wired to document_access_events)" />
            </dl>
            <p style={{ fontSize: '11px', color: '#8b949e', marginTop: '12px', marginBottom: 0 }}>
              When the renderer-side `document_access_events` IPC is exposed,
              the two placeholder rows above will be filled with real run
              and audit event references. Click outside this panel to close.
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

/** Compact key/value row used inside the evidence dialog. */
const Row: React.FC<{ k: string; v: string; mono?: boolean }> = ({ k, v, mono }) => (
  <div style={{ display: 'flex', gap: '12px', margin: '2px 0' }}>
    <dt style={{ width: '110px', flexShrink: 0, color: '#8b949e' }}>{k}</dt>
    <dd style={{ margin: 0, color: '#e1e4e8', fontFamily: mono ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : 'inherit', wordBreak: 'break-all' }}>{v}</dd>
  </div>
);

const cardStyle: React.CSSProperties = {
  padding: '16px',
  backgroundColor: '#0d1117',
  border: '1px solid #30363d',
  borderRadius: '8px',
};
