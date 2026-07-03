import React, { useState, useEffect, useCallback, useRef } from 'react';
import { buttonStyle, secondaryButtonStyle } from '../styles';

const inputStyle: React.CSSProperties = {
  padding: '6px 10px',
  borderRadius: '4px',
  border: '1px solid #30363d',
  background: '#0d1117',
  color: '#c9d1d9',
  fontSize: '13px',
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  cursor: 'pointer',
};

const cardStyle: React.CSSProperties = {
  padding: '12px',
  border: '1px solid #30363d',
  borderRadius: '6px',
  marginBottom: '8px',
  background: '#161b22',
};

const smallText: React.CSSProperties = {
  fontSize: '12px',
  color: '#8b949e',
  marginTop: '4px',
};

const badgeStyle = (color: string, bg: string): React.CSSProperties => ({
  marginLeft: '8px',
  padding: '1px 6px',
  borderRadius: '4px',
  fontSize: '10px',
  fontWeight: 500,
  backgroundColor: bg,
  color,
});

const KB_CLASSIFICATIONS = ['Public', 'Internal', 'Confidential', 'Restricted'];

interface KnowledgeBase {
  id: string;
  name: string;
  classification: string;
  fileCount: number;
  indexedStatus: string;
}

interface IndexingProgressEvent {
  knowledgeBaseId: string;
  status: string;
  filesDiscovered: number;
  filesIndexed: number;
  filesSkipped: number;
  chunksIndexed: number;
  warnings: string[];
  errors: string[];
  startedAt: string;
  completedAt?: string;
}

interface KnowledgeBaseTabProps {
  currentWorkspace: { id: string; name: string; type?: string; defaultClassification?: string } | null;
  safetySummary?: any;
  onImportFolder?: (folderPath: string, classification: string) => void;
  onReindex?: (kbId: string) => void;
  onDeleteKnowledgeBase?: (kbId: string) => void;
}

const KnowledgeBaseTab: React.FC<KnowledgeBaseTabProps> = ({
  currentWorkspace,
  safetySummary,
  onImportFolder,
  onReindex,
  onDeleteKnowledgeBase,
}) => {
  // ── State ──────────────────────────────────────────────
  const [folderPath, setFolderPath] = useState('');
  const [folderClassification, setFolderClassification] = useState(
    currentWorkspace?.defaultClassification || 'Confidential'
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [kbList, setKbList] = useState<KnowledgeBase[]>([]);
  const [expandedKbId, setExpandedKbId] = useState<string | null>(null);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [importLoading, setImportLoading] = useState(false);
  const [progressMap, setProgressMap] = useState<Record<string, IndexingProgressEvent>>({});

  const unsubRef = useRef<(() => void) | null>(null);

  // Update classification when workspace changes
  useEffect(() => {
    if (currentWorkspace?.defaultClassification) {
      setFolderClassification(currentWorkspace.defaultClassification);
    }
  }, [currentWorkspace?.defaultClassification]);

  // ── Load knowledge base list when workspace changes ──
  useEffect(() => {
    if (!currentWorkspace) {
      setKbList([]);
      return;
    }
    (async () => {
      try {
        const result = await window.ogra.knowledge.listBases(currentWorkspace.id);
        if (result?.success && result?.data) {
          setKbList(result.data as KnowledgeBase[]);
        }
      } catch { /* ignore */ }
    })();
  }, [currentWorkspace]);

  // Also update from safetySummary when it arrives
  useEffect(() => {
    if (safetySummary?.knowledgeBases?.length > 0) {
      setKbList(prev => {
        const existingIds = new Set(prev.map(kb => kb.id));
        const newKbs = safetySummary.knowledgeBases.filter(
          (kb: any) => !existingIds.has(kb.id)
        );
        if (newKbs.length === 0) return prev;
        return [...prev, ...newKbs];
      });
    }
  }, [safetySummary]);

  // ── Subscribe to indexing progress ──
  useEffect(() => {
    const cb = (data: unknown) => {
      const event = data as IndexingProgressEvent;
      setProgressMap(prev => ({ ...prev, [event.knowledgeBaseId]: event }));
    };
    unsubRef.current = window.ogra.onIndexingProgress(cb);
    return () => {
      unsubRef.current?.();
    };
  }, []);

  // ── Import folder handler ──
  const handleImportFolder = useCallback(async () => {
    if (!currentWorkspace || !folderPath.trim()) return;
    setImportLoading(true);
    setImportStatus(null);
    try {
      const result = await window.ogra.folder.import({
        workspaceId: currentWorkspace.id,
        folderPath: folderPath.trim(),
        classification: folderClassification,
      });
      if (result?.success && result?.data) {
        const data = result.data as any;
        setImportStatus(
          `Imported ${data.filesSupported} files (${data.filesSkipped} skipped). KB ID: ${data.knowledgeBaseId}`
        );
        // Start indexing automatically
        if (data.knowledgeBaseId) {
          window.ogra.indexing.start(data.knowledgeBaseId).catch(() => {});
        }
        // Refresh KB list
        const listResult = await window.ogra.knowledge.listBases(currentWorkspace.id);
        if (listResult?.success && listResult?.data) {
          setKbList(listResult.data as KnowledgeBase[]);
        }
        // Optional callback
        onImportFolder?.(folderPath.trim(), folderClassification);
      } else {
        setImportStatus(`Error: ${result?.error || 'Import failed'}`);
      }
    } catch (err: any) {
      setImportStatus(`Error: ${err.message || 'Unknown error'}`);
    } finally {
      setImportLoading(false);
    }
  }, [currentWorkspace, folderPath, folderClassification, onImportFolder]);

  // ── Re-index handler ──
  const handleReindex = useCallback(async (kbId: string) => {
    try {
      await window.ogra.indexing.start(kbId);
      onReindex?.(kbId);
    } catch { /* ignore */ }
  }, [onReindex]);

  // ── Filter KBs by search query ──
  const filteredKbList = searchQuery.trim()
    ? kbList.filter(kb =>
        kb.name.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : kbList;

  // ── Get progress for a KB ──
  const getProgress = (kbId: string) => progressMap[kbId];

  // ── Render ──
  return (
    <div>
      <h2 style={{ fontSize: '16px', marginBottom: '12px' }}>Knowledge Bases</h2>
      <p style={{ color: '#8b949e', fontSize: '13px', marginBottom: '12px' }}>
        Import a folder to create a knowledge base. Supported: .md, .txt, .ts, .py, .go, .json, and more.
      </p>

      {currentWorkspace ? (
        <>
          {/* ═══ Import Folder Section ═══ */}
          <div style={{ display: 'flex', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' }}>
            <input
              type="text"
              placeholder="/path/to/folder"
              value={folderPath}
              onChange={e => setFolderPath(e.target.value)}
              style={{ ...inputStyle, flex: '1 1 200px', minWidth: '160px' }}
            />
            <select
              value={folderClassification}
              onChange={e => setFolderClassification(e.target.value)}
              style={{ ...selectStyle, flex: '0 0 auto' }}
            >
              {KB_CLASSIFICATIONS.map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <button
              style={buttonStyle}
              onClick={handleImportFolder}
              disabled={importLoading || !folderPath.trim()}
            >
              {importLoading ? 'Importing...' : 'Import & Index'}
            </button>
          </div>

          {importStatus && (
            <div style={{
              fontSize: '12px', color: importStatus.startsWith('Error') ? '#f85149' : '#238636',
              marginBottom: '8px', padding: '4px 8px', background: '#0d1117',
              borderRadius: '4px',
            }}>
              {importStatus}
            </div>
          )}

          {/* ═══ Search Section ═══ */}
          <div style={{ marginTop: '12px', marginBottom: '12px' }}>
            <input
              type="text"
              placeholder="Search knowledge bases..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              style={{ ...inputStyle, width: '100%', maxWidth: '400px', boxSizing: 'border-box' }}
            />
          </div>

          {/* ═══ Knowledge Base List ═══ */}
          {filteredKbList.length > 0 && (
            <div style={{ marginTop: '4px' }}>
              <h3 style={{ fontSize: '14px', marginBottom: '8px', color: '#c9d1d9' }}>
                Indexed Knowledge Bases ({filteredKbList.length})
              </h3>
              {filteredKbList.map(kb => {
                const progress = getProgress(kb.id);
                const isIndexing = progress?.status === 'queued' || progress?.status === 'running';

                return (
                  <div key={kb.id} style={cardStyle}>
                    {/* Title row */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ fontWeight: 500, fontSize: '13px', cursor: 'pointer' }}
                        onClick={() => setExpandedKbId(expandedKbId === kb.id ? null : kb.id)}
                      >
                        {kb.name}
                        <span style={{ marginLeft: '6px', fontSize: '10px', color: '#58a6ff' }}>
                          {expandedKbId === kb.id ? '▲' : '▼'}
                        </span>
                      </div>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button
                          style={{ ...secondaryButtonStyle, fontSize: '11px', padding: '3px 8px' }}
                          onClick={() => handleReindex(kb.id)}
                          disabled={isIndexing}
                          title="Re-index this knowledge base"
                        >
                          {isIndexing ? 'Indexing...' : 'Re-index'}
                        </button>
                        {onDeleteKnowledgeBase && (
                          <button
                            style={{
                              ...secondaryButtonStyle, fontSize: '11px', padding: '3px 8px',
                              borderColor: '#f85149', color: '#f85149',
                            }}
                            onClick={() => onDeleteKnowledgeBase(kb.id)}
                            title="Delete this knowledge base"
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Summary row */}
                    <div style={smallText}>
                      {kb.fileCount} files · {kb.classification}
                      <span style={badgeStyle(
                        kb.indexedStatus === 'succeeded' || kb.indexedStatus === 'completed'
                          ? '#238636' : kb.indexedStatus === 'failed' ? '#f85149' : '#d29922',
                        kb.indexedStatus === 'succeeded' || kb.indexedStatus === 'completed'
                          ? '#23863622' : kb.indexedStatus === 'failed' ? '#f8514922' : '#d2992222',
                      )}>
                        {kb.indexedStatus}
                      </span>
                      {isIndexing && (
                        <span style={{ marginLeft: '8px', color: '#58a6ff', fontSize: '11px' }}>
                          Indexing in progress...
                        </span>
                      )}
                    </div>

                    {/* ═══ Indexing Progress Bar ═══ */}
                    {progress && (
                      <div style={{ marginTop: '8px' }}>
                        <div style={{
                          height: '4px', borderRadius: '2px', background: '#30363d',
                          overflow: 'hidden',
                        }}>
                          <div style={{
                            height: '100%', borderRadius: '2px',
                            background: progress.errors?.length > 0 ? '#f85149' : '#238636',
                            width: progress.filesDiscovered > 0
                              ? `${Math.min(100, Math.round((progress.filesIndexed / progress.filesDiscovered) * 100))}%`
                              : '0%',
                            transition: 'width 0.3s ease',
                          }} />
                        </div>
                        <div style={{ fontSize: '11px', color: '#8b949e', marginTop: '4px' }}>
                          {progress.filesIndexed} / {progress.filesDiscovered} files indexed ·
                          {progress.chunksIndexed} chunks
                          {progress.errors?.length > 0 && (
                            <span style={{ color: '#f85149', marginLeft: '4px' }}>
                              · {progress.errors.length} errors
                            </span>
                          )}
                          {progress.warnings?.length > 0 && (
                            <span style={{ color: '#d29922', marginLeft: '4px' }}>
                              · {progress.warnings.length} warnings
                            </span>
                          )}
                        </div>
                      </div>
                    )}

                    {/* ═══ Expanded Details ═══ */}
                    {expandedKbId === kb.id && (
                      <div style={{
                        marginTop: '10px', padding: '10px', background: '#0d1117',
                        borderRadius: '4px', border: '1px solid #21262d',
                      }}>
                        <div style={{ fontSize: '12px', color: '#c9d1d9' }}>
                          <div><strong>ID:</strong> {kb.id}</div>
                          <div><strong>Classification:</strong> {kb.classification}</div>
                          <div><strong>Files:</strong> {kb.fileCount}</div>
                          <div><strong>Status:</strong> {kb.indexedStatus}</div>
                          {progress && (
                            <>
                              <div><strong>Files discovered:</strong> {progress.filesDiscovered}</div>
                              <div><strong>Files indexed:</strong> {progress.filesIndexed}</div>
                              <div><strong>Chunks indexed:</strong> {progress.chunksIndexed}</div>
                              {progress.startedAt && (
                                <div><strong>Started:</strong> {new Date(progress.startedAt).toLocaleString()}</div>
                              )}
                              {progress.completedAt && (
                                <div><strong>Completed:</strong> {new Date(progress.completedAt).toLocaleString()}</div>
                              )}
                            </>
                          )}
                          {progress?.warnings && progress.warnings.length > 0 && (
                            <div style={{ marginTop: '6px' }}>
                              <strong style={{ color: '#d29922' }}>Warnings:</strong>
                              <ul style={{ margin: '4px 0 0 16px', padding: 0, fontSize: '11px', color: '#d29922' }}>
                                {progress.warnings.map((w, i) => <li key={i}>{w}</li>)}
                              </ul>
                            </div>
                          )}
                          {progress?.errors && progress.errors.length > 0 && (
                            <div style={{ marginTop: '6px' }}>
                              <strong style={{ color: '#f85149' }}>Errors:</strong>
                              <ul style={{ margin: '4px 0 0 16px', padding: 0, fontSize: '11px', color: '#f85149' }}>
                                {progress.errors.map((e, i) => <li key={i}>{e}</li>)}
                              </ul>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {!importLoading && filteredKbList.length === 0 && (
            <p style={{ color: '#8b949e', fontSize: '13px', marginTop: '12px' }}>
              No knowledge bases yet. Enter a folder path above and click Import & Index.
            </p>
          )}
        </>
      ) : (
        <p style={{ color: '#8b949e', fontSize: '13px' }}>
          Create a workspace first to import knowledge bases.
        </p>
      )}
    </div>
  );
};

export default KnowledgeBaseTab;
