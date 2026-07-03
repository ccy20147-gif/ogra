import React from 'react';

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
  };
}

const classificationColors: Record<string, string> = {
  Public: '#238636',
  Internal: '#d29922',
  Confidential: '#f0883e',
  Restricted: '#da3633',
};

export const DataSafetyCenter: React.FC<DataSafetyProps> = ({ summary }) => {
  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: '20px' }}>
        <h2 style={{ fontSize: '16px', marginBottom: '4px', color: '#e1e4e8' }}>Data Safety Center</h2>
        <p style={{ fontSize: '12px', color: '#8b949e', margin: 0 }}>
          Data asset map, classification summary, provider/model allowlist, and cloud call ledger.
        </p>
      </div>

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
    </div>
  );
};

const cardStyle: React.CSSProperties = {
  padding: '16px',
  backgroundColor: '#0d1117',
  border: '1px solid #30363d',
  borderRadius: '8px',
};
