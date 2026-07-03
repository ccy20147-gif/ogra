import React, { useEffect, useState, useCallback } from 'react';
import { buttonStyle, secondaryButtonStyle } from '../styles';

interface SettingsTabProps {
  providers: any[];
  currentWorkspace?: any;
  onShowDataDir: () => void;
  onStatusChange?: (msg: string) => void;
  onProvidersChange?: () => void;
}

/* ── Shared style constants matching codebase theme ── */
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

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px',
  border: '1px solid #30363d',
  borderRadius: '4px',
  background: '#0d1117',
  color: '#e1e4e8',
  fontSize: '13px',
  marginBottom: '6px',
  boxSizing: 'border-box',
};

const labelStyle: React.CSSProperties = {
  fontSize: '12px',
  color: '#8b949e',
  marginBottom: '2px',
  display: 'block',
};

const badgeStyle: React.CSSProperties = {
  display: 'inline-block',
  padding: '1px 6px',
  borderRadius: '10px',
  fontSize: '11px',
  fontWeight: 500,
  marginLeft: '6px',
};

/* ── Sub-components ── */

interface ProviderFormData {
  name: string;
  endpoint: string;
  isLocal: boolean;
  dataRetentionPolicy?: string;
  region?: string;
}

const emptyProviderForm = (): ProviderFormData => ({
  name: '',
  endpoint: 'http://localhost:11434',
  isLocal: true,
  dataRetentionPolicy: '',
  region: '',
});

const ProviderManagement: React.FC<{
  providers: any[];
  onRefresh: () => void;
  onStatus: (msg: string) => void;
}> = ({ providers, onRefresh, onStatus }) => {
  const [showAddForm, setShowAddForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<ProviderFormData>(emptyProviderForm());
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{id: string; message: string; success: boolean} | null>(null);

  const resetForm = () => { setForm(emptyProviderForm()); setEditId(null); setShowAddForm(false); };

  const handleAdd = async () => {
    try {
      const result = await window.ogra.provider_update(form);
      if ((result as any)?.success) {
        onStatus(`Provider "${form.name}" added successfully`);
        resetForm();
        onRefresh();
      } else {
        onStatus(`Failed to add provider: ${(result as any)?.error?.message || 'unknown'}`);
      }
    } catch (err: any) {
      onStatus(`Error adding provider: ${err.message}`);
    }
  };

  const handleEdit = async (p: any) => {
    setForm({
      name: p.name || '',
      endpoint: p.endpoint || '',
      isLocal: p.isLocal ?? true,
      dataRetentionPolicy: p.dataRetentionPolicy || '',
      region: p.region || '',
    });
    setEditId(p.id);
    setShowAddForm(true);
  };

  const handleUpdate = async () => {
    if (!editId) return;
    try {
      const result = await window.ogra.provider_update({ id: editId, ...form });
      if ((result as any)?.success) {
        onStatus(`Provider "${form.name}" updated`);
        resetForm();
        onRefresh();
      } else {
        onStatus(`Failed to update provider: ${(result as any)?.error?.message || 'unknown'}`);
      }
    } catch (err: any) {
      onStatus(`Error updating provider: ${err.message}`);
    }
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    setTestResult(null);
    try {
      const result = await window.ogra.provider.testConnection(id);
      if ((result as any)?.success) {
        const data = (result as any).data;
        setTestResult({ id, success: data?.success, message: data?.message || 'Connection successful' });
        onStatus(data?.success ? `Connection to ${id} successful` : `Connection to ${id} failed: ${data?.message}`);
      } else {
        setTestResult({ id, success: false, message: (result as any)?.error?.message || 'Test failed' });
        onStatus(`Connection test failed for ${id}`);
      }
    } catch (err: any) {
      setTestResult({ id, success: false, message: err.message });
      onStatus(`Connection test error: ${err.message}`);
    } finally {
      setTestingId(null);
    }
  };

  return (
    <div style={cardCx}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <div style={sectionTitle}>Provider Management</div>
        <button style={{ ...secondaryButtonStyle, fontSize: '12px', padding: '4px 10px' }}
          onClick={() => { setShowAddForm(!showAddForm); if (showAddForm) resetForm(); }}>
          {showAddForm ? 'Cancel' : '+ Add Provider'}
        </button>
      </div>

      {/* Add/Edit form */}
      {showAddForm && (
        <div style={{
          padding: '10px', border: '1px solid #30363d', borderRadius: '4px',
          marginBottom: '10px', background: '#0d1117',
        }}>
          <label style={labelStyle}>Name</label>
          <input style={inputStyle} placeholder="e.g. My OpenAI Endpoint"
            value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
          <label style={labelStyle}>Endpoint URL</label>
          <input style={inputStyle} placeholder="http://localhost:11434"
            value={form.endpoint} onChange={e => setForm(f => ({ ...f, endpoint: e.target.value }))} />
          <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: '6px' }}>
            <input type="checkbox" checked={form.isLocal}
              onChange={e => setForm(f => ({ ...f, isLocal: e.target.checked }))} />
            Local provider
          </label>
          {!form.isLocal && (
            <>
              <label style={labelStyle}>Region</label>
              <input style={inputStyle} placeholder="e.g. us-east-1"
                value={form.region || ''} onChange={e => setForm(f => ({ ...f, region: e.target.value }))} />
              <label style={labelStyle}>Data Retention Policy</label>
              <input style={inputStyle} placeholder="e.g. 30 days"
                value={form.dataRetentionPolicy || ''} onChange={e => setForm(f => ({ ...f, dataRetentionPolicy: e.target.value }))} />
            </>
          )}
          <button style={{ ...buttonStyle, fontSize: '12px', padding: '5px 12px', marginTop: '4px' }}
            onClick={editId ? handleUpdate : handleAdd}
            disabled={!form.name || !form.endpoint}>
            {editId ? 'Update Provider' : 'Add Provider'}
          </button>
        </div>
      )}

      {/* Provider list */}
      {providers.length > 0 ? (
        providers.map((p: any) => (
          <div key={p.id} style={{
            padding: '8px 10px', border: '1px solid #21262d', borderRadius: '4px',
            marginBottom: '6px', fontSize: '13px', background: '#0d1117',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <span style={{ fontWeight: 500 }}>{p.name}</span>
                <span style={p.isLocal ? { ...badgeStyle, background: '#1b3a1b', color: '#3fb950' }
                  : { ...badgeStyle, background: '#1b2a3a', color: '#58a6ff' }}>
                  {p.isLocal ? 'local' : 'cloud'}
                </span>
              </div>
              <div style={{ display: 'flex', gap: '4px' }}>
                <button style={{ ...secondaryButtonStyle, fontSize: '11px', padding: '2px 8px' }}
                  onClick={() => handleTest(p.id)} disabled={testingId === p.id}>
                  {testingId === p.id ? '...' : 'Test'}
                </button>
                <button style={{ ...secondaryButtonStyle, fontSize: '11px', padding: '2px 8px' }}
                  onClick={() => handleEdit(p)}>
                  Edit
                </button>
              </div>
            </div>
            <div style={{ color: '#8b949e', fontSize: '12px', marginTop: '2px' }}>
              {p.kind} · {p.endpoint}
              {p.region ? ` · ${p.region}` : ''}
            </div>
            {testResult?.id === p.id && (
              <div style={{
                fontSize: '12px', marginTop: '4px',
                color: testResult.success ? '#3fb950' : '#f85149',
              }}>
                {testResult.success ? '✓' : '✗'} {testResult.message}
              </div>
            )}
          </div>
        ))
      ) : (
        <div style={{ fontSize: '13px', color: '#8b949e', padding: '8px 0' }}>
          No providers configured. Add one above.
        </div>
      )}
    </div>
  );
};

const ApiKeyManagement: React.FC<{
  providers: any[];
  onRefresh: () => void;
  onStatus: (msg: string) => void;
}> = ({ providers, onRefresh, onStatus }) => {
  const [secrets, setSecrets] = useState<any[]>([]);
  const [showAddKey, setShowAddKey] = useState(false);
  const [newKey, setNewKey] = useState({ providerId: '', value: '', displayName: '' });

  const loadSecrets = useCallback(async () => {
    try {
      const result = await window.ogra.secret.list();
      if ((result as any)?.success) {
        setSecrets((result as any).data || []);
      }
    } catch { /* IPC unavailable */ }
  }, []);

  useEffect(() => { loadSecrets(); }, [loadSecrets]);

  const handleAddKey = async () => {
    if (!newKey.providerId || !newKey.value) return;
    try {
      const result = await window.ogra.secret.create({
        providerId: newKey.providerId,
        value: newKey.value,
        displayName: newKey.displayName || newKey.providerId,
      });
      if ((result as any)?.success) {
        onStatus('API key added');
        setNewKey({ providerId: '', value: '', displayName: '' });
        setShowAddKey(false);
        loadSecrets();
      } else {
        onStatus(`Failed to add key: ${(result as any)?.error?.message || 'unknown'}`);
      }
    } catch (err: any) {
      onStatus(`Error adding key: ${err.message}`);
    }
  };

  const handleDeleteKey = async (id: string) => {
    try {
      const result = await window.ogra.secret_delete(id);
      if ((result as any)?.success) {
        onStatus('API key deleted');
        loadSecrets();
      } else {
        onStatus(`Failed to delete key: ${(result as any)?.error?.message || 'unknown'}`);
      }
    } catch (err: any) {
      onStatus(`Error deleting key: ${err.message}`);
    }
  };

  return (
    <div style={cardCx}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <div style={sectionTitle}>API Key Management</div>
        <button style={{ ...secondaryButtonStyle, fontSize: '12px', padding: '4px 10px' }}
          onClick={() => { setShowAddKey(!showAddKey); }}>
          {showAddKey ? 'Cancel' : '+ Add Key'}
        </button>
      </div>

      {showAddKey && (
        <div style={{
          padding: '10px', border: '1px solid #30363d', borderRadius: '4px',
          marginBottom: '10px', background: '#0d1117',
        }}>
          <label style={labelStyle}>Provider</label>
          <select style={inputStyle}
            value={newKey.providerId}
            onChange={e => setNewKey(k => ({ ...k, providerId: e.target.value }))}>
            <option value="">— Select provider —</option>
            {providers.map(p => (
              <option key={p.id} value={p.id}>{p.name} ({p.kind})</option>
            ))}
          </select>
          <label style={labelStyle}>Display Name</label>
          <input style={inputStyle} placeholder="e.g. Production API Key"
            value={newKey.displayName} onChange={e => setNewKey(k => ({ ...k, displayName: e.target.value }))} />
          <label style={labelStyle}>API Key Value</label>
          <input style={inputStyle} type="password" placeholder="sk-..."
            value={newKey.value} onChange={e => setNewKey(k => ({ ...k, value: e.target.value }))} />
          <button style={{ ...buttonStyle, fontSize: '12px', padding: '5px 12px', marginTop: '4px' }}
            onClick={handleAddKey} disabled={!newKey.providerId || !newKey.value}>
            Save Key
          </button>
        </div>
      )}

      {secrets.length > 0 ? (
        secrets.map((s: any) => {
          const provider = providers.find((p: any) => p.id === s.providerId);
          return (
            <div key={s.id} style={{
              padding: '8px 10px', border: '1px solid #21262d', borderRadius: '4px',
              marginBottom: '6px', fontSize: '13px', background: '#0d1117',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <div>
                <div style={{ fontWeight: 500 }}>{s.displayName}</div>
                <div style={{ color: '#8b949e', fontSize: '12px' }}>
                  {provider?.name || s.providerId} · {s.maskedValue}
                  {s.lastUsedAt ? ` · Last used: ${new Date(s.lastUsedAt).toLocaleDateString()}` : ''}
                </div>
              </div>
              <button style={{ ...secondaryButtonStyle, fontSize: '11px', padding: '2px 8px', color: '#f85149' }}
                onClick={() => handleDeleteKey(s.id)}>
                Delete
              </button>
            </div>
          );
        })
      ) : (
        <div style={{ fontSize: '13px', color: '#8b949e', padding: '8px 0' }}>
          No API keys stored. Add a key for cloud providers.
        </div>
      )}
    </div>
  );
};

const ModelConfiguration: React.FC<{ providers: any[] }> = ({ providers }) => {
  const models: any[] = [];
  const seenIds = new Set<string>();
  for (const p of providers) {
    if (p.models && Array.isArray(p.models)) {
      for (const m of p.models) {
        const key = m.id || m.name || m;
        if (!seenIds.has(key)) {
          seenIds.add(key);
          models.push(typeof m === 'string' ? { name: m, providerName: p.name } : { ...m, providerName: p.name });
        }
      }
    }
  }

  return (
    <div style={cardCx}>
      <div style={sectionTitle}>Model Configuration</div>
      {models.length > 0 ? (
        models.map((m: any) => (
          <div key={m.id || m.name} style={{
            padding: '8px 10px', border: '1px solid #21262d', borderRadius: '4px',
            marginBottom: '6px', fontSize: '13px', background: '#0d1117',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <div>
              <div style={{ fontWeight: 500 }}>{m.displayName || m.name}</div>
              <div style={{ color: '#8b949e', fontSize: '12px' }}>
                {m.providerName} · {m.modality || 'text'}
                {m.localOnly ? <span style={{ ...badgeStyle, background: '#1b3a1b', color: '#3fb950' }}>local only</span> : null}
                {m.enabled === false ? <span style={{ ...badgeStyle, background: '#3d1f00', color: '#d29922' }}>disabled</span> : null}
              </div>
            </div>
            <div style={{ color: '#484f58', fontSize: '11px' }}>{m.id}</div>
          </div>
        ))
      ) : (
        <div style={{ fontSize: '13px', color: '#8b949e', padding: '8px 0' }}>
          No models registered. Configure a provider to see available models.
        </div>
      )}
    </div>
  );
};

const WorkspaceConfig: React.FC<{
  currentWorkspace?: any;
  onStatus: (msg: string) => void;
}> = ({ currentWorkspace, onStatus }) => {
  const [workspaces, setWorkspaces] = useState<any[]>([]);

  const loadWorkspaces = useCallback(async () => {
    try {
      const result = await window.ogra.workspace.list();
      if ((result as any)?.success) {
        setWorkspaces((result as any).data || []);
      }
    } catch { /* ipc unavailable */ }
  }, []);

  useEffect(() => { loadWorkspaces(); }, [loadWorkspaces]);

  const handleSelectWorkspace = async (id: string) => {
    try {
      const result = await window.ogra.workspace.select(id);
      if ((result as any)?.success) {
        onStatus(`Workspace switched to "${(result as any).data?.name}"`);
        loadWorkspaces();
      } else {
        onStatus(`Failed to switch workspace: ${(result as any)?.error?.message || 'unknown'}`);
      }
    } catch (err: any) {
      onStatus(`Error: ${err.message}`);
    }
  };

  const handleCreateWorkspace = async () => {
    try {
      const result = await window.ogra.workspace.create({
        name: `Workspace ${Date.now() % 10000}`,
        type: 'project',
        defaultClassification: 'Internal',
      });
      if ((result as any)?.success) {
        onStatus(`Workspace "${(result as any).data?.name}" created`);
        loadWorkspaces();
      } else {
        onStatus(`Failed to create workspace: ${(result as any)?.error?.message || 'unknown'}`);
      }
    } catch (err: any) {
      onStatus(`Error: ${err.message}`);
    }
  };

  return (
    <div style={cardCx}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <div style={sectionTitle}>Workspace Configuration</div>
        <button style={{ ...secondaryButtonStyle, fontSize: '12px', padding: '4px 10px' }}
          onClick={handleCreateWorkspace}>
          + New Workspace
        </button>
      </div>

      {currentWorkspace && (
        <div style={{
          padding: '8px 10px', border: '1px solid #1f6feb', borderRadius: '4px',
          marginBottom: '8px', fontSize: '13px', background: '#0d1a2e',
        }}>
          <div style={{ fontWeight: 500, color: '#58a6ff' }}>Current: {currentWorkspace.name}</div>
          <div style={{ color: '#8b949e', fontSize: '12px', marginTop: '2px' }}>
            {currentWorkspace.type} · {currentWorkspace.defaultClassification}
          </div>
        </div>
      )}

      {workspaces.filter((w: any) => w.id !== currentWorkspace?.id).length > 0 ? (
        <>
          <div style={{ fontSize: '12px', color: '#8b949e', marginBottom: '6px' }}>
            Other Workspaces
          </div>
          {workspaces.filter((w: any) => w.id !== currentWorkspace?.id).map((ws: any) => (
            <div key={ws.id} style={{
              padding: '6px 10px', border: '1px solid #21262d', borderRadius: '4px',
              marginBottom: '4px', fontSize: '13px', background: '#0d1117',
              cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }} onClick={() => handleSelectWorkspace(ws.id)}>
              <div>
                <span style={{ fontWeight: 500 }}>{ws.name}</span>
                <span style={{ color: '#8b949e', fontSize: '12px', marginLeft: '6px' }}>
                  {ws.type} · {ws.defaultClassification}
                </span>
              </div>
              <span style={{ color: '#58a6ff', fontSize: '11px' }}>Switch</span>
            </div>
          ))}
        </>
      ) : (
        <div style={{ fontSize: '13px', color: '#8b949e', padding: '4px 0' }}>
          {workspaces.length <= 1 ? 'No other workspaces. Create one to get started.' : 'All workspaces shown.'}
        </div>
      )}
    </div>
  );
};

/* ── Main component ── */

const SettingsTab: React.FC<SettingsTabProps> = ({
  providers,
  currentWorkspace,
  onShowDataDir,
  onStatusChange,
}) => {
  const [localProviders, setLocalProviders] = useState<any[]>(providers);
  const [localMsg, setLocalMsg] = useState<string>('');

  // Sync local providers when prop changes
  useEffect(() => {
    setLocalProviders(providers);
  }, [providers]);

  const refreshProviders = useCallback(async () => {
    try {
      const result = await window.ogra.provider.list();
      if ((result as any)?.success) {
        const data = (result as any).data;
        setLocalProviders(data?.providers || data || []);
      }
    } catch { /* ipc unavailable */ }
  }, []);

  const handleStatus = (msg: string) => {
    setLocalMsg(msg);
    onStatusChange?.(msg);
  };

  return (
    <div>
      <h2 style={{ fontSize: '16px', marginBottom: '12px' }}>Settings</h2>

      {/* Transient local status */}
      {localMsg && (
        <div style={{
          padding: '6px 10px', marginBottom: '10px', borderRadius: '4px',
          fontSize: '12px', color: '#58a6ff', border: '1px solid #1f6feb',
          background: '#0d1a2e',
        }}>
          {localMsg}
          <button style={{
            float: 'right', background: 'none', border: 'none', color: '#8b949e',
            cursor: 'pointer', fontSize: '12px', padding: '0',
          }} onClick={() => setLocalMsg('')}>✕</button>
        </div>
      )}

      <ProviderManagement
        providers={localProviders}
        onRefresh={refreshProviders}
        onStatus={handleStatus}
      />

      <ApiKeyManagement
        providers={localProviders}
        onRefresh={refreshProviders}
        onStatus={handleStatus}
      />

      <ModelConfiguration providers={localProviders} />

      <WorkspaceConfig
        currentWorkspace={currentWorkspace}
        onStatus={handleStatus}
      />

      {/* Data Management */}
      <div style={cardCx}>
        <div style={sectionTitle}>Data Directory</div>
        <div style={{ fontSize: '13px', color: '#8b949e', marginBottom: '8px' }}>
          View the Ogra application data directory where configurations, secrets,
          and knowledge bases are stored.
        </div>
        <button style={secondaryButtonStyle} onClick={onShowDataDir}>
          Show Data Directory
        </button>
      </div>
    </div>
  );
};

export default SettingsTab;
