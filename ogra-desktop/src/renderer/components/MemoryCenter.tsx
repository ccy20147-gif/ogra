import React from 'react';

interface MemoryCenterProps {
  stats: {
    episodic: number;
    semanticConfirmed: number;
    semanticPending: number;
    proceduralConfirmed: number;
    proceduralPending: number;
  };
  recentEpisodic: Array<{
    id: string;
    eventSummary: string;
    occurredAt: string;
    sourceRunId?: string;
    confidence: number;
  }>;
  pendingSemantic: Array<{
    id: string;
    subject: string;
    relation: string;
    object: string;
    confidence: number;
  }>;
  onConfirmSemantic?: (id: string) => void;
  onConfirmProcedural?: (id: string) => void;
  onDeleteMemory?: (type: string, id: string) => void;
}

export const MemoryCenter: React.FC<MemoryCenterProps> = ({
  stats,
  recentEpisodic,
  pendingSemantic,
  onConfirmSemantic,
  onDeleteMemory,
}) => {
  return (
    <div>
      <div style={{ marginBottom: '20px' }}>
        <h2 style={{ fontSize: '16px', marginBottom: '4px', color: '#e1e4e8' }}>M3 Memory Center</h2>
        <p style={{ fontSize: '12px', color: '#8b949e', margin: 0 }}>
          White-box memory with source-linked entries. Episodic memories are auto-written.
          Semantic and procedural memories require explicit user confirmation.
        </p>
      </div>

      {/* Stats cards */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        gap: '12px',
        marginBottom: '20px',
      }}>
        <div style={cardStyle}>
          <div style={{ fontSize: '24px', fontWeight: 700, color: '#58a6ff' }}>{stats.episodic}</div>
          <div style={{ fontSize: '12px', color: '#8b949e' }}>Episodic (auto)</div>
        </div>
        <div style={cardStyle}>
          <div style={{ fontSize: '24px', fontWeight: 700, color: '#238636' }}>{stats.semanticConfirmed}</div>
          <div style={{ fontSize: '12px', color: '#8b949e' }}>Semantic</div>
        </div>
        {stats.semanticPending > 0 && (
          <div style={{ ...cardStyle, borderColor: '#d29922' }}>
            <div style={{ fontSize: '24px', fontWeight: 700, color: '#d29922' }}>{stats.semanticPending}</div>
            <div style={{ fontSize: '12px', color: '#8b949e' }}>Pending Confirmation</div>
          </div>
        )}
        <div style={cardStyle}>
          <div style={{ fontSize: '24px', fontWeight: 700, color: '#f0883e' }}>{stats.proceduralConfirmed}</div>
          <div style={{ fontSize: '12px', color: '#8b949e' }}>Procedural</div>
        </div>
      </div>

      {/* Recent Episodic Memories */}
      <div style={{ marginBottom: '20px' }}>
        <h3 style={{ fontSize: '14px', marginBottom: '8px', color: '#e1e4e8' }}>Recent Episodic Memories</h3>
        {recentEpisodic.length === 0 ? (
          <div style={{
            color: '#8b949e', fontSize: '13px',
            padding: '12px', border: '1px dashed #30363d', borderRadius: '6px',
          }}>
            <div>No episodic memories yet. Run an agent query to create one.</div>
            <div style={{ marginTop: '6px', fontSize: '11px', color: '#586069' }}>
              Episodic memories are auto-written from completed runs. Semantic and
              procedural memories require explicit user confirmation.
              See{' '}
              <a
                href="https://github.com/ccy20147-gif/ogra/blob/main/docs/plans/08-memory-agentgroup-recipes-v1-requirements.md"
                target="_blank"
                rel="noreferrer"
                style={{ color: '#58a6ff', textDecoration: 'underline' }}
              >
                M3 memory requirements
              </a>{' '}
              for the full model.
            </div>
          </div>
        ) : (
          recentEpisodic.map(m => (
            <div key={m.id} style={{
              padding: '10px 12px',
              border: '1px solid #30363d',
              borderRadius: '6px',
              marginBottom: '6px',
            }}>
              <div style={{ color: '#e1e4e8', fontSize: '13px' }}>{m.eventSummary}</div>
              <div style={{ display: 'flex', gap: '12px', marginTop: '4px', fontSize: '11px', color: '#8b949e' }}>
                <span>Confidence: {Math.round(m.confidence * 100)}%</span>
                {m.sourceRunId && <span>Run: {m.sourceRunId.slice(0, 16)}...</span>}
                <span>{new Date(m.occurredAt).toLocaleString()}</span>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Pending Semantic Confirmations */}
      {pendingSemantic.length > 0 && (
        <div style={{ marginBottom: '20px' }}>
          <h3 style={{ fontSize: '14px', marginBottom: '8px', color: '#d29922' }}>
            Pending Confirmations ({pendingSemantic.length})
          </h3>
          {pendingSemantic.map(m => (
            <div key={m.id} style={{
              padding: '10px 12px',
              border: '1px solid #d29922',
              borderRadius: '6px',
              marginBottom: '6px',
              backgroundColor: '#0d1117',
            }}>
              <div style={{ color: '#e1e4e8', fontSize: '13px' }}>
                <strong>{m.subject}</strong> — <em>{m.relation}</em> — <strong>{m.object}</strong>
              </div>
              <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                <button
                  onClick={() => onConfirmSemantic?.(m.id)}
                  style={{
                    padding: '4px 12px',
                    border: '1px solid #238636',
                    borderRadius: '4px',
                    backgroundColor: '#238636',
                    color: '#fff',
                    cursor: 'pointer',
                    fontSize: '12px',
                  }}
                >
                  Confirm
                </button>
                <button
                  onClick={() => onDeleteMemory?.('semantic', m.id)}
                  style={{
                    padding: '4px 12px',
                    border: '1px solid #30363d',
                    borderRadius: '4px',
                    backgroundColor: 'transparent',
                    color: '#8b949e',
                    cursor: 'pointer',
                    fontSize: '12px',
                  }}
                >
                  Dismiss
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Explanation */}
      <div style={{
        padding: '12px',
        border: '1px solid #30363d',
        borderRadius: '6px',
        fontSize: '12px',
        color: '#8b949e',
        backgroundColor: '#0d1117',
        lineHeight: 1.5,
      }}>
        <strong>How M3 Memory Works</strong><br />
        • <strong>Episodic</strong> — Automatically written as run summaries. Source-linked to specific runs and files.<br />
        • <strong>Semantic</strong> — Stable facts and preferences require user confirmation before writing.<br />
        • <strong>Procedural</strong> — Reusable workflows require user confirmation before saving.<br />
        • All memories can be edited, deleted (preserving tombstone), and have configurable agent access scope.
      </div>
    </div>
  );
};

const cardStyle: React.CSSProperties = {
  padding: '16px',
  backgroundColor: '#0d1117',
  border: '1px solid #30363d',
  borderRadius: '8px',
};
