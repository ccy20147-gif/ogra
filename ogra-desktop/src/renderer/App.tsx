import React, { useEffect, useState } from 'react';
import { RouteTraceViewer } from './components/RouteTraceViewer';
import { DataSafetyCenter } from './components/DataSafetyCenter';
import { AiGovernanceCenter } from './components/AiGovernanceCenter';

// Window-level type for the preload API
declare global {
  interface Window {
    ogra: any;
  }
}

interface Workspace {
  id: string;
  name: string;
  type: string;
  defaultClassification: string;
  createdAt: string;
}

const App: React.FC = () => {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [currentWorkspace, setCurrentWorkspace] = useState<Workspace | null>(null);
  const [status, setStatus] = useState<string>('Initializing...');
  const [activeTab, setActiveTab] = useState<string>('workspace');

  useEffect(() => {
    loadWorkspaces();
  }, []);

  const loadWorkspaces = async () => {
    try {
      setStatus('Loading workspaces...');
      const result = await window.ogra.workspace.list();
      if (result?.success && result?.data) {
        setWorkspaces(result.data);
        setStatus('Ready');
      } else {
        setStatus('No workspaces yet. Create one to get started.');
      }
    } catch (err: any) {
      setStatus(`Error: ${err.message || 'Unknown error'}`);
    }
  };

  const createWorkspace = async () => {
    try {
      setStatus('Creating workspace...');
      const result = await window.ogra.workspace.create({
        name: 'Finance Review',
        type: 'project',
        defaultClassification: 'Confidential',
      });
      if (result?.success && result?.data) {
        setCurrentWorkspace(result.data);
        setWorkspaces(prev => [...prev, result.data]);
        setStatus(`Workspace "${result.data.name}" created`);
      }
    } catch (err: any) {
      setStatus(`Error: ${err.message}`);
    }
  };

  const runDemo = async () => {
    if (!currentWorkspace) {
      setStatus('Please create a workspace first');
      return;
    }

    try {
      setStatus('Starting demo run...');
      const result = await window.ogra.run.start({
        workspaceId: currentWorkspace.id,
        task: 'Analyze Q2 financial anomalies from the imported documents',
        knowledgeBaseIds: [],
      });
      if (result?.success && result?.data) {
        const run = result.data;
        setStatus(`Run ${run.id}: ${run.status}`);
        if (run.routeDecision) {
          setStatus(`Run ${run.id}: ${run.status} - Route: ${run.routeDecision.route}`);
        }
      }
    } catch (err: any) {
      setStatus(`Error: ${err.message}`);
    }
  };

  return (
    <div style={{
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      backgroundColor: '#0f1117',
      color: '#e1e4e8',
    }}>
      {/* Header */}
      <header style={{
        padding: '12px 20px',
        borderBottom: '1px solid #21262d',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <h1 style={{ fontSize: '18px', fontWeight: 600, margin: 0 }}>Ogra Desktop</h1>
          <span style={{
            fontSize: '11px',
            backgroundColor: '#1f6feb',
            color: '#fff',
            padding: '2px 8px',
            borderRadius: '10px',
            fontWeight: 500,
          }}>Alpha</span>
        </div>
        <div style={{ fontSize: '12px', color: '#8b949e' }}>
          {currentWorkspace ? `Workspace: ${currentWorkspace.name}` : 'No workspace'}
        </div>
      </header>

      {/* Navigation tabs */}
      <nav style={{
        display: 'flex',
        borderBottom: '1px solid #21262d',
        padding: '0 20px',
      }}>
        {['workspace', 'run', 'knowledge', 'safety', 'governance'].map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              padding: '10px 16px',
              border: 'none',
              background: 'transparent',
              color: activeTab === tab ? '#58a6ff' : '#8b949e',
              borderBottom: activeTab === tab ? '2px solid #58a6ff' : '2px solid transparent',
              cursor: 'pointer',
              fontSize: '13px',
              fontWeight: activeTab === tab ? 600 : 400,
              textTransform: 'capitalize',
            }}
          >
            {tab === 'safety' ? 'Data Safety' : tab === 'governance' ? 'AI Governance' : tab}
          </button>
        ))}
      </nav>

      {/* Main content */}
      <main style={{ flex: 1, padding: '20px', overflow: 'auto' }}>
        {activeTab === 'workspace' && (
          <div>
            <div style={{ marginBottom: '20px' }}>
              <h2 style={{ fontSize: '16px', marginBottom: '12px' }}>Workspace Overview</h2>
              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                <button onClick={createWorkspace} style={buttonStyle}>
                  Create Workspace
                </button>
                <button onClick={loadWorkspaces} style={{ ...buttonStyle, backgroundColor: '#21262d' }}>
                  Refresh
                </button>
              </div>
            </div>

            {workspaces.length > 0 && (
              <div>
                <h3 style={{ fontSize: '14px', marginBottom: '8px' }}>Existing Workspaces</h3>
                {workspaces.map(ws => (
                  <div key={ws.id} style={{
                    padding: '12px',
                    border: '1px solid #21262d',
                    borderRadius: '6px',
                    marginBottom: '8px',
                    cursor: 'pointer',
                    backgroundColor: currentWorkspace?.id === ws.id ? '#161b22' : 'transparent',
                  }}
                  onClick={async () => {
                    const result = await window.ogra.workspace.select(ws.id);
                    if (result?.success && result?.data) {
                      setCurrentWorkspace(result.data);
                    }
                  }}
                  >
                    <div style={{ fontWeight: 500 }}>{ws.name}</div>
                    <div style={{ fontSize: '12px', color: '#8b949e', marginTop: '4px' }}>
                      {ws.type} · {ws.defaultClassification}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'run' && (
          <div>
            <h2 style={{ fontSize: '16px', marginBottom: '12px' }}>Run Workspace</h2>
            <button onClick={runDemo} style={buttonStyle} disabled={!currentWorkspace}>
              Run Demo Query
            </button>
            {!currentWorkspace && (
              <p style={{ color: '#8b949e', fontSize: '13px', marginTop: '12px' }}>
                Create a workspace first to start a run.
              </p>
            )}
          </div>
        )}

        {activeTab === 'knowledge' && (
          <div>
            <h2 style={{ fontSize: '16px', marginBottom: '12px' }}>Knowledge Bases</h2>
            <p style={{ color: '#8b949e', fontSize: '13px' }}>
              Import a folder to create a knowledge base. Supported: .md, .txt, .ts, .py, .go, .json, and more.
            </p>
          </div>
        )}

        {activeTab === 'safety' && (
          <DataSafetyCenter summary={{
            totalAssets: 1,
            byClassification: { Public: 0, Internal: 1, Confidential: 0, Restricted: 0 },
            knowledgeBases: [],
            recentAccess: [],
            recentCloudCalls: 0,
            zeroCloudCallRuns: 0,
            limitationNote: 'Ogra can prove calls made through Ogra-controlled adapters. This does not cover manual copy/paste, screenshots, tools launched outside Ogra, provider-side retention after approved calls, or other local processes.',
            memoryStats: { episodic: 0, semantic: 0, procedural: 0, total: 0 },
            agentGroupStats: { total: 0, pipeline: 0, completed: 0 },
          }} />
        )}

        {activeTab === 'governance' && (
          <AiGovernanceCenter
            runs={[]}
            incidents={[]}
            policies={[
              { id: 'pol_1', name: 'confidential-local-only', enabled: true, version: 1 },
              { id: 'pol_2', name: 'restricted-local-allowlist', enabled: true, version: 1 },
              { id: 'pol_3', name: 'internal-redacted-cloud', enabled: true, version: 1 },
              { id: 'pol_4', name: 'public-cloud-allowed', enabled: true, version: 1 },
            ]}
          />
        )}

        {/* Status bar */}
        <div style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          padding: '8px 20px',
          borderTop: '1px solid #21262d',
          fontSize: '12px',
          color: '#8b949e',
          backgroundColor: '#0f1117',
        }}>
          {status}
        </div>
      </main>
    </div>
  );
};

const buttonStyle: React.CSSProperties = {
  padding: '8px 16px',
  border: '1px solid #30363d',
  borderRadius: '6px',
  backgroundColor: '#238636',
  color: '#fff',
  cursor: 'pointer',
  fontSize: '13px',
  fontWeight: 500,
};

export default App;
