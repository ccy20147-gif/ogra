import React from 'react';
import { RouteTraceViewer } from './RouteTraceViewer';
import { buttonStyle, secondaryButtonStyle } from '../styles';

/* ─── Types ──────────────────────────────────────────── */

interface ContextSource {
  name: string;
  type: string;
  relevance: number;
}

interface CitationInfo {
  file: string;
  lineStart?: number;
  lineEnd?: number;
  classification?: string;
  snippet?: string;
}

interface RunWorkspaceTabProps {
  currentWorkspace: boolean;
  taskInput: string;
  runResult: string;
  routeDecision: any;

  /* B28 new props */
  modelId: string;
  modelOptions: string[];
  runPhase: string;         // idle | created | policy_check | risk_classification | route_decision | rag_retrieval | approval_redaction | model_call | final_output | audit_complete | complete | error
  riskLevel: string;        // low | medium | high | critical
  contextSources: ContextSource[];
  citations?: CitationInfo[];

  onTaskInputChange: (value: string) => void;
  onRunDemo: () => void;
  onCancelRun: () => void;
  onModelChange?: (model: string) => void;
  runLoading?: boolean;
  runError?: string | null;
}

/* ─── Constants ───────────────────────────────────────── */

/** Full 9-stage Run Timeline as specified in 06-application-ui-ux.md §6 */
const PHASES: { key: string; label: string }[] = [
  { key: 'created', label: 'Created' },
  { key: 'policy_check', label: 'Policy Check' },
  { key: 'risk_classification', label: 'Risk Class' },
  { key: 'route_decision', label: 'Route Decision' },
  { key: 'rag_retrieval', label: 'RAG Retrieval' },
  { key: 'approval_redaction', label: 'Approval' },
  { key: 'model_call', label: 'Model Call' },
  { key: 'final_output', label: 'Final Output' },
  { key: 'audit_complete', label: 'Audit' },
  { key: 'complete', label: 'Complete' },
];

const ROUTE_COLORS: Record<string, string> = {
  local: '#238636',
  cloud: '#1f6feb',
  hybrid: '#d29922',
  blocked: '#da3633',
};

const RISK_COLORS: Record<string, { bg: string; fg: string; label: string }> = {
  low:      { bg: '#1a3d1a', fg: '#3fb950', label: 'Low' },
  medium:   { bg: '#3d2e00', fg: '#d29922', label: 'Medium' },
  high:     { bg: '#3d1a00', fg: '#f0883e', label: 'High' },
  critical: { bg: '#3d0000', fg: '#f85149', label: 'Critical' },
};

/* ─── Sub-components ──────────────────────────────────── */

/** 1. Model selection dropdown */
const ModelSelector: React.FC<{
  modelId: string;
  modelOptions: string[];
  onChange?: (m: string) => void;
}> = ({ modelId, modelOptions, onChange }) => (
  <div style={{ marginBottom: '12px' }}>
    <label style={{ fontSize: '13px', color: '#8b949e', display: 'block', marginBottom: '4px' }}>
      AI Model
    </label>
    <select
      value={modelId}
      onChange={e => onChange?.(e.target.value)}
      style={{
        width: '100%', padding: '7px 10px', borderRadius: '4px',
        border: '1px solid #30363d', background: '#0d1117', color: '#c9d1d9',
        fontSize: '13px', cursor: 'pointer',
      }}
    >
      {modelOptions.length === 0 && (
        <option value="">No models available</option>
      )}
      {modelOptions.map(m => (
        <option key={m} value={m}>{m}</option>
      ))}
    </select>
  </div>
);

/** 2. Route decision summary card */
const RouteSummaryCard: React.FC<{
  routeDecision: any;
  riskLevel: string;
}> = ({ routeDecision, riskLevel }) => {
  if (!routeDecision) return null;

  const route = routeDecision.route || routeDecision.routeType || 'unknown';
  const classification = routeDecision.dataClassification || routeDecision.classification || 'N/A';
  const reasons: string[] = routeDecision.reasons || [];

  const routeColor = ROUTE_COLORS[route] || '#6e7681';
  const risk = RISK_COLORS[riskLevel] || RISK_COLORS.low;

  return (
    <div style={{
      marginTop: '12px', padding: '12px', border: '1px solid #30363d',
      borderRadius: '8px', background: '#161b22',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
        {/* Route badge */}
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: '6px',
          background: routeColor + '22', color: routeColor,
          padding: '4px 12px', borderRadius: '14px',
          fontSize: '12px', fontWeight: 600, textTransform: 'uppercase',
        }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: routeColor }} />
          {route}
        </span>

        {/* Risk badge */}
        <span style={{
          background: risk.bg, color: risk.fg,
          padding: '3px 10px', borderRadius: '10px',
          fontSize: '11px', fontWeight: 600,
        }}>
          {risk.label} Risk
        </span>

        {/* Classification */}
        <span style={{ fontSize: '11px', color: '#8b949e', marginLeft: 'auto' }}>
          Classification: <strong style={{ color: '#f0883e' }}>{classification}</strong>
        </span>
      </div>

      {/* Reasons */}
      {reasons.length > 0 && (
        <div style={{ fontSize: '12px', color: '#8b949e', marginBottom: 0 }}>
          <div style={{ fontWeight: 500, color: '#c9d1d9', marginBottom: '4px', fontSize: '11px', textTransform: 'uppercase' }}>
            Reasons
          </div>
          {reasons.map((r: string, i: number) => (
            <div key={i} style={{ padding: '2px 0', color: '#e1e4e8' }}>• {r}</div>
          ))}
        </div>
      )}
    </div>
  );
};

/** 3. Stage timeline (horizontal) */
const PhaseTimeline: React.FC<{ currentPhase: string }> = ({ currentPhase }) => {
  // resolve phase index; treat 'error' as terminal like 'complete'
  const activeIdx = currentPhase === 'error'
    ? PHASES.findIndex(p => p.key === 'complete')
    : PHASES.findIndex(p => p.key === currentPhase);

  return (
    <div style={{ marginTop: '16px' }}>
      <div style={{ fontSize: '11px', fontWeight: 600, color: '#8b949e', textTransform: 'uppercase', marginBottom: '8px' }}>
        Run Timeline
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
        {PHASES.map((phase, idx) => {
          const done = idx < activeIdx;
          const active = idx === activeIdx;
          const color = currentPhase === 'error' && idx === activeIdx ? '#da3633' : done ? '#238636' : active ? '#58a6ff' : '#30363d';

          return (
            <React.Fragment key={phase.key}>
              {/* Step node */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1, minWidth: 0 }}>
                <div style={{
                  width: 20, height: 20, borderRadius: '50%',
                  backgroundColor: done || active ? color : '#0d1117',
                  border: `2px solid ${color}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '9px', fontWeight: 700, color: '#fff',
                  transition: 'all 0.2s',
                }}>
                  {done ? '✓' : active ? (currentPhase === 'error' ? '✗' : idx + 1) : idx + 1}
                </div>
                <span style={{
                  fontSize: '10px', color: active ? '#e1e4e8' : '#8b949e',
                  marginTop: '4px', textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  fontWeight: active ? 600 : 400, maxWidth: '90px',
                }}>
                  {phase.label}
                </span>
              </div>
              {/* Connector line */}
              {idx < PHASES.length - 1 && (
                <div style={{
                  flex: '0 0 16px', height: 2,
                  backgroundColor: idx < activeIdx ? '#238636' : '#30363d',
                  marginBottom: 20,
                }} />
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
};

/** 4. Context sources panel */
const ContextSourcesPanel: React.FC<{
  sources: ContextSource[];
}> = ({ sources }) => {
  if (!sources || sources.length === 0) return null;

  return (
    <div style={{ marginTop: '12px' }}>
      <div style={{ fontSize: '11px', fontWeight: 600, color: '#8b949e', textTransform: 'uppercase', marginBottom: '6px' }}>
        Context Sources ({sources.length})
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {sources.map((src, i) => (
          <div key={i} style={{
            display: 'flex', alignItems: 'center', gap: '8px',
            padding: '8px 10px', borderRadius: '6px',
            background: '#0d1117', border: '1px solid #21262d',
            fontSize: '12px',
          }}>
            {/* Type badge */}
            <span style={{
              background: '#1f6feb22', color: '#58a6ff',
              padding: '2px 8px', borderRadius: '10px',
              fontSize: '10px', fontWeight: 600, textTransform: 'uppercase',
              flexShrink: 0,
            }}>
              {src.type}
            </span>
            {/* Name */}
            <span style={{ color: '#e1e4e8', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {src.name}
            </span>
            {/* Relevance bar */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
              <div style={{ width: 50, height: 4, borderRadius: 2, background: '#21262d', overflow: 'hidden' }}>
                <div style={{
                  width: `${Math.min(Math.max(src.relevance * 100, 0), 100)}%`,
                  height: '100%',
                  borderRadius: 2,
                  background: src.relevance > 0.7 ? '#238636' : src.relevance > 0.4 ? '#d29922' : '#6e7681',
                  transition: 'width 0.3s',
                }} />
              </div>
              <span style={{ color: '#8b949e', fontSize: '10px', width: 32, textAlign: 'right' }}>
                {Math.round(src.relevance * 100)}%
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

/** 5. Improved citation display with file, line range, classification badge */
const CitationList: React.FC<{
  citations?: CitationInfo[];
  routeDecision?: any;
}> = ({ citations, routeDecision }) => {
  // Support both prop-driven citations and legacy routeDecision.localSteps
  const hasCitations = citations && citations.length > 0;
  const hasLegacy = routeDecision?.localSteps?.length > 0;

  if (!hasCitations && !hasLegacy) return null;

  return (
    <div style={{
      marginTop: '12px', padding: '12px', border: '1px solid #30363d',
      borderRadius: '8px', background: '#0d1117', fontSize: '12px',
    }}>
      <div style={{ fontWeight: 600, marginBottom: '8px', color: '#c9d1d9', fontSize: '11px', textTransform: 'uppercase' }}>
        Citations
      </div>

      {/* New citation format */}
      {hasCitations && citations!.map((cit, i) => (
        <div key={i} style={{
          display: 'flex', alignItems: 'center', gap: '8px',
          padding: '6px 0', borderBottom: i < citations!.length - 1 ? '1px solid #21262d' : 'none',
        }}>
          {/* Classification badge */}
          {cit.classification && (
            <span style={{
              background: cit.classification === 'Public' ? '#23863622'
                : cit.classification === 'Internal' ? '#1f6feb22'
                : cit.classification === 'Confidential' ? '#d2992222'
                : '#da363322',
              color: cit.classification === 'Public' ? '#3fb950'
                : cit.classification === 'Internal' ? '#58a6ff'
                : cit.classification === 'Confidential' ? '#d29922'
                : '#f85149',
              padding: '1px 6px', borderRadius: '8px', fontSize: '9px', fontWeight: 600,
              flexShrink: 0,
            }}>
              {cit.classification}
            </span>
          )}
          {/* File path */}
          <span style={{ color: '#58a6ff', fontFamily: 'monospace', fontSize: '11px', flexShrink: 0 }}>
            {cit.file}
          </span>
          {/* Line range */}
          {cit.lineStart !== undefined && (
            <span style={{ color: '#8b949e', fontSize: '10px', flexShrink: 0 }}>
              :{cit.lineStart}{cit.lineEnd !== undefined ? `–${cit.lineEnd}` : ''}
            </span>
          )}
          {/* Snippet */}
          {cit.snippet && (
            <span style={{ color: '#8b949e', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, fontSize: '11px' }}>
              "{cit.snippet}"
            </span>
          )}
        </div>
      ))}

      {/* Legacy format */}
      {!hasCitations && hasLegacy && routeDecision.localSteps.map((step: string, i: number) => (
        <div key={i} style={{ padding: '3px 0', color: '#8b949e' }}>
          <span style={{ color: '#6e7681', marginRight: 4 }}>#{i + 1}</span>
          {step}
        </div>
      ))}
    </div>
  );
};

/* ─── Main Component ────────────────────────────────── */

const RunWorkspaceTab: React.FC<RunWorkspaceTabProps> = ({
  currentWorkspace,
  taskInput,
  runResult,
  routeDecision,
  modelId,
  modelOptions,
  runPhase,
  riskLevel,
  contextSources,
  citations,
  onTaskInputChange,
  onRunDemo,
  onModelChange,
  onCancelRun,
  runLoading = false,
  runError = null,
}) => {
  return (
    <div>
      <h2 style={{ fontSize: '16px', marginBottom: '12px' }}>Run Workspace</h2>

      {/* Task Input */}
      <div style={{ marginBottom: '12px' }}>
        <label style={{ fontSize: '13px', color: '#8b949e', display: 'block', marginBottom: '4px' }}>
          Task Description
        </label>
        <textarea
          value={taskInput}
          onChange={e => onTaskInputChange(e.target.value)}
          placeholder="Describe what you want the agent to do..."
          rows={3}
          style={{
            width: '100%', padding: '8px 10px', borderRadius: '4px',
            border: '1px solid #30363d', background: '#0d1117', color: '#c9d1d9',
            fontSize: '13px', resize: 'vertical', boxSizing: 'border-box',
          }}
        />
      </div>

      {/* 1. Model Selector */}
      <ModelSelector
        modelId={modelId}
        modelOptions={modelOptions}
        onChange={onModelChange}
      />

      {/* Run / Stop buttons */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
        <button onClick={onRunDemo} style={buttonStyle} disabled={!currentWorkspace || runLoading}>
          {runLoading ? 'Running...' : (taskInput.trim() ? 'Run Task' : 'Run Demo Query')}
        </button>
        {runPhase !== 'idle' && runPhase !== 'complete' && runPhase !== 'error' && (
          <button
            onClick={onCancelRun}
            style={{ ...secondaryButtonStyle, color: '#f85149', borderColor: '#da3633' }}
          >
            Cancel
          </button>
        )}
      </div>

      {/* No workspace prompt */}
      {!currentWorkspace && (
        <div style={{
          padding: '16px',
          border: '1px dashed #30363d',
          borderRadius: '6px',
          textAlign: 'center',
          fontSize: '13px',
          color: '#8b949e',
          marginTop: '12px',
        }}>
          <div style={{ fontSize: '24px', marginBottom: '8px' }}>🔒</div>
          <div>Create a workspace first to start a run.</div>
          <div style={{ fontSize: '12px', marginTop: '4px', color: '#484f58' }}>
            Go to the "workspace" tab and create your first workspace.
          </div>
        </div>
      )}

      {/* Run loading indicator */}
      {runLoading && (
        <div
          role="status"
          aria-label="Running task"
          style={{
            marginTop: '12px',
            padding: '12px',
            border: '1px solid #30363d',
            borderRadius: '6px',
            background: '#161b22',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
          }}
        >
          <div style={{
            width: '20px', height: '20px',
            border: '2px solid #30363d',
            borderTopColor: '#58a6ff',
            borderRadius: '50%',
            animation: 'run-spin 0.8s linear infinite',
            flexShrink: 0,
          }} />
          <div>
            <div style={{ fontSize: '13px', color: '#e1e4e8' }}>Executing task...</div>
            <div style={{ fontSize: '11px', color: '#8b949e', marginTop: '2px' }}>
              Running AI agent with selected model
            </div>
          </div>
          <style>{`@keyframes run-spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}

      {/* Run error state */}
      {runError && (
        <div
          role="alert"
          style={{
            marginTop: '12px',
            padding: '10px 14px',
            border: '1px solid #da3633',
            borderRadius: '6px',
            backgroundColor: '#3d0000',
            color: '#f85149',
            fontSize: '13px',
            display: 'flex',
            alignItems: 'flex-start',
            gap: '8px',
          }}
        >
          <span style={{ flexShrink: 0 }}>❌</span>
          <div>
            <strong>Run Failed</strong>
            <div style={{ fontSize: '12px', color: '#ff7b72', marginTop: '2px' }}>
              {runError}
            </div>
          </div>
        </div>
      )}

      {/* No model available empty state */}
      {currentWorkspace && modelOptions.length === 0 && !runLoading && !runError && (
        <div style={{
          padding: '12px',
          border: '1px dashed #d29922',
          borderRadius: '6px',
          fontSize: '13px',
          color: '#d29922',
          background: '#3d2e00',
          marginTop: '12px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        }}>
          <span>⚠️</span>
          <div>
            <strong>No models available</strong>
            <div style={{ fontSize: '12px', color: '#d29922', marginTop: '2px' }}>
              No providers with models are configured. Default models (gpt-4o, claude-sonnet-4, deepseek-v3) will be used as fallback.
            </div>
          </div>
        </div>
      )}

      {/* 3. Phase Timeline (shown when run is active or done) */}
      {runPhase !== 'idle' && runPhase !== '' && (
        <PhaseTimeline currentPhase={runPhase} />
      )}

      {/* Run Status */}
      {runResult && (
        <div style={{
          marginTop: '12px', padding: '10px', border: '1px solid #30363d',
          borderRadius: '6px', background: '#161b22',
        }}>
          <div style={{ fontSize: '13px', fontWeight: 500, marginBottom: '4px' }}>
            Result: <span style={{ color: runResult.includes('error') || runResult.includes('blocked') ? '#f85149' : '#3fb950' }}>
              {runResult}
            </span>
          </div>
          <div style={{ fontSize: '12px', color: '#8b949e' }}>
            Task: {taskInput || '(demo query)'}
          </div>
        </div>
      )}

      {/* 2. Route Decision Summary Card + Risk Badge */}
      {routeDecision && (
        <RouteSummaryCard routeDecision={routeDecision} riskLevel={riskLevel} />
      )}

      {/* 5. Context Sources Panel */}
      <ContextSourcesPanel sources={contextSources} />

      {/* 6. Improved Citation Display */}
      <CitationList citations={citations} routeDecision={routeDecision} />

      {/* Route Trace (detailed, collapsible) */}
      {routeDecision && (
        <details style={{ marginTop: '16px' }}>
          <summary style={{
            fontSize: '13px', fontWeight: 600, color: '#58a6ff',
            cursor: 'pointer', marginBottom: '8px',
          }}>
            Route Decision Detail
          </summary>
          <RouteTraceViewer trace={routeDecision} />
        </details>
      )}
    </div>
  );
};

export default RunWorkspaceTab;
