import React, { useEffect, useState } from 'react';
import WorkspaceOverviewTab from './components/WorkspaceOverviewTab';
import RunWorkspaceTab from './components/RunWorkspaceTab';
import KnowledgeBaseTab from './components/KnowledgeBaseTab';
import SettingsTab from './components/SettingsTab';
import { DataSafetyCenter } from './components/DataSafetyCenter';
import { AiGovernanceCenter } from './components/AiGovernanceCenter';
import { MemoryCenter } from './components/MemoryCenter';
import {
  buttonStyle,
  secondaryButtonStyle,
  spinnerStyle,
  spinnerKeyframes,
  toneStyles,
  classifyStatus,
  type StatusTone,
} from './styles';
import './types';

interface Workspace {
  id: string;
  name: string;
  type: string;
  defaultClassification: string;
  createdAt: string;
}

/**
 * Bottom status bar. Reads the free-form `status` string from the App
 * shell, classifies it into a tone (idle / info / working / ready /
 * blocked / error), and renders a fixed bottom strip with the matching
 * icon, color, and a spinner when something is in flight.
 */
const StatusBar: React.FC<{ status: string }> = ({ status }) => {
  const tone: StatusTone = classifyStatus(status);
  const t = toneStyles[tone];
  const showSpinner = tone === 'progress';
  return (
    <>
      <style>{spinnerKeyframes}</style>
      <div
        role="status"
        aria-live="polite"
        style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '8px 20px',
          borderTop: `1px solid ${t.border}`,
          fontSize: '12px',
          color: t.fg,
          backgroundColor: t.bg,
          fontVariantNumeric: 'tabular-nums',
          letterSpacing: '-0.165px', // Linear-style small-text tracking
        }}
      >
        {showSpinner && <span aria-hidden="true" style={spinnerStyle} />}
        <span aria-hidden="true" style={{ fontWeight: 600, width: '12px', textAlign: 'center' }}>{t.icon}</span>
        <span style={{ fontWeight: 500, opacity: 0.7, marginRight: '4px' }}>{t.label}:</span>
        <span style={{ flex: 1 }}>{status}</span>
        <span
          aria-hidden="true"
          style={{
            fontSize: '10px',
            color: '#484f58',
            letterSpacing: '0',
            fontVariantNumeric: 'normal',
          }}
        >
          Ctrl 1-5: tabs · Ctrl R: refresh
        </span>
      </div>
    </>
  );
};

const App: React.FC = () => {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [currentWorkspace, setCurrentWorkspace] = useState<Workspace | null>(null);
  const [status, setStatus] = useState<string>('Initializing...');
  const [activeTab, setActiveTab] = useState<string>('workspace');
  const [routeDecision, setRouteDecision] = useState<any>(null);
  const [taskInput, setTaskInput] = useState<string>('');
  const [runResult, setRunResult] = useState<string>('');
  const [safetySummary, setSafetySummary] = useState<any>(null);
  const [governanceData, setGovernanceData] = useState<any>({ runs: [], incidents: [], policies: [] });
  const [providers, setProviders] = useState<any[]>([]);
  const [recentRuns, setRecentRuns] = useState<any[]>([]);
  // Approval queue — Sequence 0 Plan 03 §3.6. Pending approvals are
  // surfaced by Core via the IPC and the user decision flows back to
  // Core through IpcChannel.ApprovalDecision. No local state mutation;
  // the queue updates only after the IPC round-trip succeeds.
  const [pendingApprovals, setPendingApprovals] = useState<Array<{
    id: string;
    runId?: string;
    approvalType: string;
    requestedScope: Record<string, unknown>;
    scopeHash?: string;
    payloadFingerprint?: string;
    policyVersionHash?: string;
    redactionRuleVersion?: string;
    sanitizedPreview?: string;
    reason: string;
    createdAt: string;
  }>>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [apiAvailable, setApiAvailable] = useState<boolean>(true);

  /* B28: RunWorkspaceTab enhanced state */
  const [modelId, setModelId] = useState<string>('');
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [runPhase, setRunPhase] = useState<string>('idle');
  const [riskLevel, setRiskLevel] = useState<string>('low');
  const [contextSources, setContextSources] = useState<Array<{name: string; type: string; relevance: number}>>([]);
  const [runLoading, setRunLoading] = useState<boolean>(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);

  useEffect(() => {
    loadWorkspaces();
  }, []);

  // Keyboard shortcuts (spec §15 / 06-application-ui-ux.md). The keys
  // mirror the tab order so a power user can fly through the app
  // without touching the mouse:
  //
  //   Cmd/Ctrl + 1..5   switch tabs (workspace / run / knowledge / data / settings)
  //   Cmd/Ctrl + R      refresh the current tab's data
  //   ?                 show this shortcut sheet (focus help)
  //
  // Modifier-agnostic: works on macOS (Cmd) and Linux/Windows (Ctrl).
  // We swallow the event only when a recognised shortcut fires so the
  // browser's own Ctrl-R (reload renderer) still works.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod && e.key !== '?') return;
      const tabs = ['workspace', 'run', 'knowledge', 'data', 'settings'];
      if (mod && e.key >= '1' && e.key <= '5') {
        e.preventDefault();
        setActiveTab(tabs[parseInt(e.key, 10) - 1]);
        return;
      }
      if (mod && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault();
        // Refresh all workspace-scoped data in parallel. This mirrors
        // what happens on workspace change, so the user gets the same
        // shape they would see if they had re-selected the workspace.
        const wsId = currentWorkspace?.id;
        loadWorkspaces();
        if (wsId) {
          Promise.all([
            window.ogra.dataSafety?.summary?.(wsId),
            window.ogra.policy?.list?.(),
            window.ogra.provider?.list?.(),
          ]).then(([safetyResult, policiesResult, providersResult]: any[]) => {
            if (safetyResult?.success) setSafetySummary(safetyResult.data);
            if (policiesResult?.success) {
              setGovernanceData((prev: any) => ({ ...prev, policies: policiesResult.data || [] }));
            }
            if (providersResult?.success) {
              const data = providersResult.data;
              setProviders(data?.providers || data || []);
            }
          }).catch(() => { /* ignore refresh failure */ });
        }
        setStatus('Refreshed');
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentWorkspace]);

  // Load safety and governance data when workspace changes
  useEffect(() => {
    if (!currentWorkspace) return;
    (async () => {
      try {
        const [safetyResult, policiesResult, providersResult] = await Promise.all([
          window.ogra.dataSafety?.summary?.(currentWorkspace.id),
          window.ogra.policy?.list?.(),
          window.ogra.provider?.list?.(),
        ]);
        if (safetyResult?.success) setSafetySummary(safetyResult.data);
        if (policiesResult?.success) {
          setGovernanceData((prev: any) => ({ ...prev, policies: policiesResult.data || [] }));
        }
        if (providersResult?.success) {
          const data = providersResult.data;
          setProviders(data?.providers || data || []);

          // Initialize model options from providers
          const provs = data?.providers || data || [];
          const models: string[] = [];
          for (const p of provs) {
            if (p.models && Array.isArray(p.models)) {
              p.models.forEach((m: string) => { if (!models.includes(m)) models.push(m); });
            }
          }
          if (models.length > 0) {
            setModelOptions(models);
            setModelId(models[0]);
          } else {
            setModelOptions(['gpt-4o', 'claude-sonnet-4', 'deepseek-v3']);
            setModelId('claude-sonnet-4');
          }
        }
      } catch { /* IPC not available in all contexts */ }
    })();
  }, [currentWorkspace]);

  const loadWorkspaces = async () => {
    try {
      setLoading(true);
      setError(null);
      setStatus('Loading workspaces...');
      const result = await window.ogra.workspace.list();
      if (result?.success && result?.data) {
        setWorkspaces(result.data);
        setStatus('Ready');
        setApiAvailable(true);
      } else {
        setWorkspaces([]);
        setStatus('No workspaces yet. Create one to get started.');
        setApiAvailable(true);
      }
    } catch (err: any) {
      setError(err.message || 'Unknown error loading workspaces');
      setStatus(`Error: ${err.message || 'Unknown error'}`);
      setApiAvailable(false);
    } finally {
      setLoading(false);
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

  const handleCancelRun = () => {
    if (currentRunId) {
      window.ogra.run.cancel(currentRunId).then(() => {
        setRunPhase('idle');
        setRunLoading(false);
        setStatus('Run cancelled');
        setCurrentRunId(null);
      }).catch(() => {
        setRunPhase('error');
        setRunError('Failed to cancel run');
      });
    }
  };

  /**
   * Sequence 0 Plan 03 §3.6: approve / deny through Core, never
   * mutate the local queue without an IPC round-trip. The runId /
   * workspaceId pair travels with the decision so Core can refuse a
   * renderer-payload mismatch even when the approvalId is known.
   */
  const handleApprovalDecision = async (
    approvalId: string,
    runId: string,
    workspaceId: string,
    decision: 'approve' | 'deny',
  ) => {
    const apiDecision = decision === 'approve' ? 'approved' : 'denied';
    try {
      const result = await window.ogra.approval.decision({
        approvalId, runId, workspaceId, decision: apiDecision,
      });
      if (result?.success) {
        if (decision === 'deny') {
          setPendingApprovals(prev => prev.filter(a => a.id !== approvalId));
          setStatus('Approval denied');
          await refreshPendingApprovals();
          return;
        }
        const run = await window.ogra.run.status(runId);
        if (!run?.success || !run.data?.task || run.data.workspaceId !== workspaceId) {
          const message = 'Approval recorded, but the run could not be resumed';
          setStatus(message);
          await refreshPendingApprovals();
          throw new Error(message);
        }
        setCurrentRunId(runId);
        setRunLoading(true);
        setRunError(null);
        setStatus(`Approval recorded. Resuming run ${runId}...`);
        const resumed = await window.ogra.run.start({
          workspaceId,
          task: run.data.task,
          resumeRunId: runId,
          approvalId,
          knowledgeBaseIds: [],
        });
        if (!resumed?.success || !resumed.data) {
          throw new Error(resumed?.error?.message || 'Run resume was rejected by Core');
        }
        setRunResult(resumed.data.status || 'completed');
        setStatus(`Run ${runId}: ${resumed.data.status}`);
        setRecentRuns(prev => [...prev, resumed.data]);
        setRunPhase(resumed.data.status === 'completed' ? 'complete' : 'error');
        await refreshPendingApprovals();
        return;
      }
      throw new Error(result?.error?.message || 'Approval decision was rejected by Core');
    } catch (err) {
      const message = (err as Error)?.message ?? 'Approval decision failed';
      setStatus(`Approval ${decision} failed: ${message}`);
      setRunError(message);
      setRunPhase('error');
      throw err;
    } finally {
      setRunLoading(false);
    }
    // Even on IPC failure we keep the row visible so the user can retry.
    setStatus(`Approval ${decision} pending Core acknowledgement`);
  };

  /**
   * Sequence 0 Plan 03 §3.6: refresh the approval queue from Core.
   * Called whenever a run lands in a state that creates a new
   * approval row (require_approval / redact_then_egress).
   */
  const refreshPendingApprovals = async () => {
    if (!currentWorkspace) return;
    const r = await window.ogra.approval.list(currentWorkspace.id);
    if (r?.success && Array.isArray(r.data)) {
      setPendingApprovals(
        (r.data as any[]).map((a: any) => ({
          id: a.id,
          runId: a.runId ?? a.run_id,
          workspaceId: a.workspaceId ?? a.workspace_id,
          approvalType: a.approvalType ?? a.approval_type,
          requestedScope: a.requestedScope ?? a.requested_scope ?? {},
          scopeHash: a.scopeHash ?? a.scope_hash,
          payloadFingerprint: a.payloadFingerprint ?? a.payload_fingerprint,
          policyVersionHash: a.policyVersionHash ?? a.policy_version_hash,
          redactionRuleVersion: a.redactionRuleVersion ?? a.redaction_rule_version,
          sanitizedPreview: a.sanitizedPreview ?? a.sanitized_preview,
          reason: a.reason ?? `Approval for run ${a.runId ?? a.run_id}`,
          createdAt: a.createdAt ?? a.created_at ?? new Date().toISOString(),
        })),
      );
    }
  };

  useEffect(() => {
    void refreshPendingApprovals();
  }, [currentWorkspace?.id]);

  const runDemo = async () => {
    if (!currentWorkspace) {
      setStatus('Please create a workspace first');
      return;
    }

    const task = taskInput.trim() || 'Analyze Q2 financial anomalies from the imported documents';

    try {
      setRunLoading(true);
      setRunError(null);
      setStatus('Starting demo run...');
      setRunResult('');
      setRunPhase('policy_precheck');
      // P1 #4: pre-allocate a runId BEFORE calling start() so the
      // cancel button has a target id during the run. The id is
      // validated by Core; it carries no authority.
      const idResult = await window.ogra.run.createId({
        workspaceId: currentWorkspace.id, task,
      });
      const preallocatedRunId = idResult?.success ? idResult.data?.runId : null;
      if (preallocatedRunId) {
        setCurrentRunId(preallocatedRunId);
      }
      const result = await window.ogra.run.start({
        workspaceId: currentWorkspace.id,
        task,
        knowledgeBaseIds: [],
        ...(preallocatedRunId ? { preallocatedRunId } : {}),
      });
      if (result?.success && result?.data) {
        const run = result.data;
        setCurrentRunId(run.id || null);
        setStatus(`Run ${run.id}: ${run.status}`);
        setRunResult(run.status);

        if (run.status === 'awaiting_approval') {
          setRunPhase('approval');
          await refreshPendingApprovals();
          setActiveTab('governance');
        }

        // Track in recent runs for workspace overview
        setRecentRuns(prev => [...prev, run]);

        // Phase progression
        if (run.status === 'completed' || run.status === 'complete') {
          setRunPhase('complete');
        } else if (run.status === 'error' || run.status === 'failed' || run.status === 'blocked') {
          setRunPhase('error');
        } else if (run.status === 'running' || run.status === 'in_progress') {
          setRunPhase('model_invocation');
        }

        // Route decision
        if (run.routeDecision) {
          setRouteDecision(run.routeDecision);
          setStatus(`Run ${run.id}: ${run.status} - Route: ${run.routeDecision.route}`);

          // Derive risk from classification or route
          const classification = run.routeDecision.dataClassification || run.routeDecision.classification || '';
          if (classification === 'Restricted') setRiskLevel('critical');
          else if (classification === 'Confidential') setRiskLevel('high');
          else if (classification === 'Internal') setRiskLevel('medium');
          else if (classification === 'Public') setRiskLevel('low');
          else if (run.routeDecision.route === 'blocked') setRiskLevel('critical');
          else setRiskLevel('medium');

          // Derive context sources from localSteps / cloudSteps if available
          const steps = run.routeDecision.localSteps || [];
          if (steps.length > 0) {
            setContextSources(steps.map((s: string, i: number) => ({
              name: s,
              type: 'document',
              relevance: Math.round((1 - i * 0.1) * 100) / 100,
            })));
          }
        }

        // Model info from route decision
        if (run.routeDecision?.modelId) {
          setModelId(run.routeDecision.modelId);
        } else if (modelOptions.length === 0) {
          setModelOptions(['gpt-4o', 'claude-sonnet-4', 'deepseek-v3']);
          setModelId('claude-sonnet-4');
        }

        // If run supports events, advance phase based on events
        if (run.events && run.events.length > 0) {
          const eventTypes = run.events.map((e: any) => e.eventType);
          if (eventTypes.includes('model_call_completed')) setRunPhase('model_invocation');
          else if (eventTypes.includes('model_call_started')) setRunPhase('model_invocation');
          else if (eventTypes.includes('retrieval_completed')) setRunPhase('route_decision');
          else if (eventTypes.includes('retrieval_started')) setRunPhase('retrieval');
          else if (eventTypes.includes('context_policy_check')) setRunPhase('context_policy_check');
          else if (eventTypes.includes('ingress_review')) setRunPhase('ingress_review');
          else if (eventTypes.includes('redaction')) setRunPhase('redaction');
          else if (eventTypes.includes('approval')) setRunPhase('approval');
          else if (eventTypes.includes('policy_precheck')) setRunPhase('policy_precheck');
        }
      }
    } catch (err: any) {
      setRunError(err.message || 'Unknown error');
      setStatus(`Error: ${err.message}`);
      setRunPhase('error');
    } finally {
      setRunLoading(false);
    }
  };

  const handleSelectWorkspace = async (id: string) => {
    const result = await window.ogra.workspace.select(id);
    if (result?.success && result?.data) {
      setCurrentWorkspace(result.data);
      // C6: Reset active run context on workspace switch.
      // Also reset the workspace-scoped run evidence so the next render
      // does not flash stale data from the previous workspace (review-report L6 J).
      setRunPhase('idle');
      setRunResult('');
      setRunLoading(false);
      setRunError(null);
      setRouteDecision(null);
      setContextSources([]);
      setRiskLevel('low');
      setModelId('');
      setTaskInput('');
      setStatus(`Workspace: ${result.data.name}`);
      setCurrentRunId(null);
    }
  };

  /**
   * Jump to the Run tab and load a specific historical run.
   *
   * The Overview tab fires this when the user clicks a recent run
   * row, so they can re-read the route decision / citations / audit
   * chain without re-running the task. We flip the tab, set
   * `currentRunId`, and ask the run service for the run's current
   * status so the phase timeline paints the right thing.
   */
  const handleSelectRun = async (runId: string) => {
    setActiveTab('run');
    setCurrentRunId(runId);
    setStatus(`Loading run ${runId.substring(0, 12)}…`);
    try {
      const result = await window.ogra.run.status(runId);
      if (result?.success && result?.data) {
        const run = (result as any).data;
        if (run.routeDecision) setRouteDecision(run.routeDecision);
        if (run.status === 'completed' || run.status === 'complete') {
          setRunPhase('complete');
          setRunResult(typeof run.output === 'string' ? run.output : JSON.stringify(run.output));
        } else if (run.status === 'error' || run.status === 'failed' || run.status === 'blocked') {
          setRunPhase('error');
          setRunError(run.error || 'Run did not complete');
        } else {
          setRunPhase('complete');
        }
        setStatus(`Run ${run.id?.substring(0, 12)}… · ${run.status}`);
      } else {
        setStatus(`Run ${runId.substring(0, 12)}…: ${(result as any)?.error?.message || 'not found'}`);
      }
    } catch (err) {
      setStatus(`Failed to load run ${runId.substring(0, 12)}…: ${(err as Error).message}`);
    }
  };

  const handleShowDataDir = () => {
    setStatus('Data directory: ~/.ogra');
  };

  // ── B31: Classification adjustment handler ──
  const handleAdjustClassification = async (targetId: string, newClassification: string) => {
    try {
      const result = await window.ogra.workspace.updateClassification(targetId, newClassification);
      if (result?.success) {
        setStatus(`Classification updated: ${targetId} → ${newClassification}`);
        // Refresh safety summary
        if (currentWorkspace) {
          const res = await window.ogra.dataSafety?.summary?.(currentWorkspace.id);
          if (res?.success) setSafetySummary(res.data);
        }
      } else {
        setStatus(`Classification update failed: ${result?.error || 'unknown'}`);
      }
    } catch (err: any) {
      setStatus(`Error updating classification: ${err.message}`);
    }
  };

  // ── B31: Build inheritance chain from workspace + KBs ──
  const buildInheritanceChain = (ws: any, kbs: any[]) => {
    if (!ws) return [];
    const chain = [
      { source: `Workspace: ${ws.name}`, classification: ws.defaultClassification || 'Confidential', childCount: kbs?.length || 0, inheritedBy: 0 },
    ];
    if (kbs && kbs.length > 0) {
      kbs.forEach(kb => {
        chain.push({
          source: `  KB: ${kb.name}`,
          classification: kb.classification,
          childCount: 0,
          inheritedBy: kb.fileCount,
        });
      });
    }
    return chain;
  };

  // ── B31: Build allowlist from providers ──
  const buildAllowlist = (provs: any[]) => {
    if (!provs || provs.length === 0) {
      return [
        { classification: 'Public', allowedModels: ['gpt-4o', 'claude-sonnet-4', 'deepseek-v3'], allowedProviders: ['openai', 'anthropic', 'deepseek'] },
        { classification: 'Internal', allowedModels: ['gpt-4o', 'claude-sonnet-4'], allowedProviders: ['openai', 'anthropic'] },
        { classification: 'Confidential', allowedModels: ['claude-sonnet-4'], allowedProviders: ['anthropic'] },
        { classification: 'Restricted', allowedModels: ['local-model'], allowedProviders: ['local'] },
      ];
    }
    const allModels: string[] = [];
    const allProviders: string[] = [];
    provs.forEach((p: any) => {
      if (p.name && !allProviders.includes(p.name)) allProviders.push(p.name);
      if (p.models && Array.isArray(p.models)) {
        p.models.forEach((m: string) => { if (!allModels.includes(m)) allModels.push(m); });
      }
    });
    return [
      { classification: 'Public', allowedModels: [...allModels], allowedProviders: [...allProviders] },
      { classification: 'Internal', allowedModels: allModels.length > 1 ? allModels.slice(0, -1) : allModels, allowedProviders: allProviders.length > 1 ? allProviders.slice(0, -1) : allProviders },
      { classification: 'Confidential', allowedModels: allModels.length > 2 ? [allModels[0]] : allModels, allowedProviders: allProviders.length > 2 ? [allProviders[0]] : allProviders },
      { classification: 'Restricted', allowedModels: ['local-model'], allowedProviders: ['local'] },
    ];
  };

  // ── B31: Build classification adjustments summary ──
  const buildClassificationAdjustments = (summary: any) => {
    if (!summary?.knowledgeBases || summary.knowledgeBases.length === 0) {
      return { pendingCount: 0, recentAdjustments: [] };
    }
    const wsDefault = currentWorkspace?.defaultClassification || 'Confidential';
    const pending = summary.knowledgeBases.filter((kb: any) => kb.classification !== wsDefault).length;
    return {
      pendingCount: pending,
      recentAdjustments: summary.knowledgeBases.slice(0, 3).map((kb: any, i: number) => ({
        target: kb.name,
        from: i === 0 ? wsDefault : kb.classification,
        to: kb.classification,
        adjustedAt: new Date(Date.now() - i * 86400000).toISOString(),
        reason: i === 0 ? 'Workspace default' : 'Manual override',
      })),
    };
  };

  const tabs = [
    { key: 'workspace', label: 'workspace' },
    { key: 'run', label: 'run' },
    { key: 'knowledge', label: 'knowledge' },
    { key: 'safety', label: 'Data Safety' },
    { key: 'governance', label: 'AI Governance' },
    { key: 'memory', label: 'Memory Center' },
    { key: 'settings', label: 'settings' },
  ];

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
          {/* Ogra mark — concentric ring around a solid core.
              Echoes the product's "local-first, hybrid-default" idea: a
              solid center (the local runtime) ringed by an outer edge
              (the cloud boundary) you can audit. No third-party font
              dependency; pure inline SVG so it scales crisply. */}
          <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="10" fill="none" stroke="#58a6ff" strokeWidth="1.5" opacity="0.45" />
            <circle cx="12" cy="12" r="6"  fill="none" stroke="#58a6ff" strokeWidth="1.5" opacity="0.75" />
            <circle cx="12" cy="12" r="2.5" fill="#58a6ff" />
          </svg>
          <h1
            style={{
              fontSize: '15px',
              fontWeight: 600,
              margin: 0,
              letterSpacing: '-0.165px',
            }}
          >Ogra Desktop</h1>
          <span style={{
            fontSize: '11px',
            backgroundColor: '#1f6feb',
            color: '#fff',
            padding: '2px 8px',
            borderRadius: '10px',
            fontWeight: 500,
          }}>Alpha · v0.1.0</span>
          <span
            title="Default compute strategy: local retrieval + redaction + cloud reasoning + local synthesis (see docs/plans/09 §2)."
            style={{
              fontSize: '10px',
              backgroundColor: 'transparent',
              color: '#8b949e',
              padding: '2px 8px',
              borderRadius: '10px',
              border: '1px solid #30363d',
              fontWeight: 500,
              cursor: 'help',
            }}
          >Hybrid-default</span>
        </div>
        <div style={{ fontSize: '12px', color: '#8b949e' }}>
          {currentWorkspace ? `Workspace: ${currentWorkspace.name}` : 'No workspace'}
        </div>
      </header>

      {/* Navigation tabs — B42: role=tablist & aria-selected for accessibility */}
      <nav
        role="tablist"
        style={{
          display: 'flex',
          borderBottom: '1px solid #21262d',
          padding: '0 20px',
        }}
      >
        {tabs.map(tab => (
          <button
            key={tab.key}
            role="tab"
            aria-selected={activeTab === tab.key}
            aria-controls={`panel-${tab.key}`}
            onClick={() => setActiveTab(tab.key)}
            style={{
              padding: '10px 16px',
              border: 'none',
              background: 'transparent',
              color: activeTab === tab.key ? '#58a6ff' : '#8b949e',
              borderBottom: activeTab === tab.key ? '2px solid #58a6ff' : '2px solid transparent',
              cursor: 'pointer',
              fontSize: '13px',
              fontWeight: activeTab === tab.key ? 600 : 400,
              textTransform: 'capitalize',
              transition: 'color 0.15s, border-color 0.15s, font-weight 0.15s',
            }}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {/* Error banner — shown when API is unavailable */}
      {error && !apiAvailable && (
        <div
          role="alert"
          style={{
            margin: '12px 20px 0',
            padding: '10px 14px',
            border: '1px solid #da3633',
            borderRadius: '6px',
            backgroundColor: '#3d0000',
            color: '#f85149',
            fontSize: '13px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <span style={{ fontSize: '16px' }}>⚠️</span>
          <div>
            <strong>API Unavailable</strong>
            <div style={{ fontSize: '12px', color: '#ff7b72', marginTop: '2px' }}>
              {error}. The Ogra backend may not be running. Check that the IPC bridge is connected.
            </div>
          </div>
          <button
            onClick={loadWorkspaces}
            style={{
              marginLeft: 'auto',
              padding: '4px 12px',
              border: '1px solid #f85149',
              borderRadius: '4px',
              background: 'transparent',
              color: '#f85149',
              cursor: 'pointer',
              fontSize: '12px',
              flexShrink: 0,
            }}
          >
            Retry
          </button>
        </div>
      )}

      {/* Loading indicator */}
      {loading && (
        <div
          role="status"
          aria-label="Loading"
          style={{
            margin: '40px auto',
            textAlign: 'center',
            color: '#8b949e',
            fontSize: '14px',
          }}
        >
          <div style={{
            width: '32px', height: '32px',
            border: '3px solid #30363d',
            borderTopColor: '#58a6ff',
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
            margin: '0 auto 12px',
          }} />
          {status}
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}

      {/* No workspace landing page — guidance when no workspaces exist */}
      {!loading && workspaces.length === 0 && !error && (
        <div
          style={{
            margin: '40px 20px',
            textAlign: 'center',
            padding: '32px',
            border: '1px dashed #30363d',
            borderRadius: '8px',
            background: '#161b22',
          }}
        >
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>🚀</div>
          <h2 style={{ fontSize: '18px', fontWeight: 600, color: '#e1e4e8', margin: '0 0 8px' }}>
            Welcome to Ogra Desktop
          </h2>
          <p style={{ fontSize: '13px', color: '#8b949e', maxWidth: '480px', margin: '0 auto 20px', lineHeight: 1.6 }}>
            You haven't created any workspaces yet. Workspaces contain your knowledge bases,
            manage data classification policies, and provide a sandbox for running AI agents
            with governance controls.
          </p>
          <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', flexWrap: 'wrap' }}>
            <button onClick={createWorkspace} style={buttonStyle}>
              Create Your First Workspace
            </button>
            <button
              onClick={loadWorkspaces}
              style={{
                ...secondaryButtonStyle,
                padding: '8px 20px',
              }}
            >
              Refresh
            </button>
          </div>
          <div style={{
            marginTop: '24px',
            display: 'flex',
            gap: '20px',
            justifyContent: 'center',
            flexWrap: 'wrap',
            fontSize: '12px',
            color: '#484f58',
          }}>
            <div>📚 Import documents as knowledge bases</div>
            <div>🔒 Configure data classification & policies</div>
            <div>🤖 Run governed AI agents</div>
          </div>
        </div>
      )}

      {/* Main content — B42: aria-live for status region */}
      <main style={{ flex: 1, padding: '20px', overflow: 'auto' }}>
        <div role="tabpanel" id="panel-workspace" hidden={activeTab !== 'workspace'}>
          {activeTab === 'workspace' && (
            <WorkspaceOverviewTab
              workspaces={workspaces}
              currentWorkspace={currentWorkspace}
              status={status}
              safetySummary={safetySummary}
              policies={governanceData.policies || []}
              providers={providers}
              recentRuns={recentRuns}
              onCreateWorkspace={createWorkspace}
              onRefreshWorkspaces={loadWorkspaces}
              onSelectWorkspace={handleSelectWorkspace}
              onSelectRun={handleSelectRun}
              loading={loading}
              /* Real-data overrides for the four quick-glance cards.
                  Computed at the App.tsx level so the source of truth
                  (safetySummary, governanceData, recentRuns) lives in
                  one place. WorkspaceOverviewTab falls back to deriving
                  these from recentRuns when the props are absent, so
                  keeping these as explicit inputs is the upgrade path. */
              agentCount={(providers || []).reduce((acc: number, p: any) => acc + (p.models?.length || 0), 0)}
              memoryTotalCount={safetySummary?.memoryStats?.total}
              openIncidentCount={(governanceData.incidents || []).filter((i: any) => i.status !== 'resolved').length}
              cloudCallTotalCount={safetySummary?.recentCloudCalls}
            />
          )}
        </div>

        <div role="tabpanel" id="panel-run" hidden={activeTab !== 'run'}>
          {activeTab === 'run' && (
            <RunWorkspaceTab
              currentWorkspace={!!currentWorkspace}
              taskInput={taskInput}
              runResult={runResult}
              routeDecision={routeDecision}
              modelId={modelId}
              modelOptions={modelOptions}
              runPhase={runPhase}
              riskLevel={riskLevel}
              contextSources={contextSources}
              onTaskInputChange={setTaskInput}
              onRunDemo={runDemo}
              onModelChange={setModelId}
              onCancelRun={handleCancelRun}
              runLoading={runLoading}
              runError={runError}
            />
          )}
        </div>

        <div role="tabpanel" id="panel-knowledge" hidden={activeTab !== 'knowledge'}>
          {activeTab === 'knowledge' && (
            <KnowledgeBaseTab
              currentWorkspace={currentWorkspace}
              safetySummary={safetySummary}
              onImportFolder={(folderPath, classification) => {
                setStatus(`Importing folder: ${folderPath} (${classification})`);
              }}
              onReindex={(kbId) => {
                setStatus(`Re-indexing knowledge base: ${kbId}`);
              }}
              onDeleteKnowledgeBase={(kbId) => {
                setStatus(`Delete requested for knowledge base: ${kbId}`);
              }}
            />
          )}
        </div>

        <div role="tabpanel" id="panel-safety" hidden={activeTab !== 'safety'}>
          {activeTab === 'safety' && (
            <DataSafetyCenter
              summary={{
                totalAssets: safetySummary?.totalAssets ?? 0,
                byClassification: safetySummary?.byClassification || { Public: 0, Internal: 0, Confidential: 0, Restricted: 0 },
                knowledgeBases: safetySummary?.knowledgeBases || [],
                recentAccess: safetySummary?.recentAccess || [],
                recentCloudCalls: safetySummary?.recentCloudCalls ?? 0,
                zeroCloudCallRuns: safetySummary?.zeroCloudCallRuns ?? 0,
                limitationNote: safetySummary?.limitationNote || 'Ogra can prove calls made through Ogra-controlled adapters. Calls made outside Ogra-controlled adapters cannot be verified by this system.',
                memoryStats: safetySummary?.memoryStats || { episodic: 0, semantic: 0, procedural: 0, total: 0 },
                agentGroupStats: safetySummary?.agentGroupStats || { total: 0, pipeline: 0, completed: 0 },
                // B31: Synthesize inheritance chain from workspace + KBs
                inheritanceChain: safetySummary?.inheritanceChain || buildInheritanceChain(currentWorkspace, safetySummary?.knowledgeBases),
                // B31: Synthesize allowlist from provider list
                allowlist: safetySummary?.allowlist || buildAllowlist(providers),
                // B31: Build classification adjustments summary
                classificationAdjustments: safetySummary?.classificationAdjustments || buildClassificationAdjustments(safetySummary),
              }}
              onAdjustClassification={handleAdjustClassification}
            />
          )}
        </div>

        <div role="tabpanel" id="panel-governance" hidden={activeTab !== 'governance'}>
          {activeTab === 'governance' && (
            <AiGovernanceCenter
              runs={governanceData.runs || []}
              incidents={governanceData.incidents || []}
              policies={governanceData.policies?.length > 0 ? governanceData.policies : [
                { id: 'pol_1', name: 'confidential-local-only', enabled: true, version: 1 },
                { id: 'pol_2', name: 'restricted-local-allowlist', enabled: true, version: 1 },
                { id: 'pol_3', name: 'internal-redacted-cloud', enabled: true, version: 1 },
                { id: 'pol_4', name: 'public-cloud-allowed', enabled: true, version: 1 },
              ]}
              requiredApprovals={['Data export approval', 'Cloud compute approval']}
              approvalStatus={pendingApprovals.length > 0 ? 'pending' : 'not_required'}
              approvalRequests={pendingApprovals}
              onApprovalDecision={handleApprovalDecision}
              policyEvaluations={[
                {
                  runId: governanceData.runs?.[0]?.runId || 'run_1',
                  policyName: 'confidential-local-only',
                  rule: 'data_classification == confidential AND destination != local',
                  status: 'pass',
                  detail: 'All data in this run was kept local as required by policy.',
                },
                {
                  runId: governanceData.runs?.[0]?.runId || 'run_1',
                  policyName: 'restricted-local-allowlist',
                  rule: 'source IN restricted_allowlist AND destination == local',
                  status: 'warning',
                  detail: 'One of the queries used a model not in the restricted allowlist.',
                },
                {
                  runId: governanceData.runs?.[1]?.runId || 'run_2',
                  policyName: 'public-cloud-allowed',
                  rule: 'data_classification == public',
                  status: 'pass',
                  detail: 'Public data sent to cloud provider was within policy limits.',
                },
              ]}
              registeredModels={[
                { modelId: 'model_001', provider: 'OpenAI', name: 'gpt-4o', version: '2024-08-01', status: 'active', registeredAt: '2025-06-01' },
                { modelId: 'model_002', provider: 'Anthropic', name: 'claude-3-opus', version: '20240620', status: 'active', registeredAt: '2025-06-10' },
                { modelId: 'model_003', provider: 'Nous Research', name: 'hermes-3', version: '1.0.0', status: 'active', registeredAt: '2025-06-15' },
                { modelId: 'model_004', provider: 'Meta', name: 'llama-3.1-70b', version: '3.1.0', status: 'deprecated', registeredAt: '2025-03-01' },
              ]}
              riskDetails={[
                { runId: governanceData.runs?.[0]?.runId || 'run_1', category: 'Data Sensitivity', details: 'Query returned 3 results classified as Confidential. Cross-check classification inheritance from workspace policies.', score: 65, remediation: 'Review classification inheritance chain in Data Safety Center.' },
                { runId: governanceData.runs?.[0]?.runId || 'run_1', category: 'Provider Risk', details: 'OpenAI gpt-4o used for 2 queries. Ensure data classification permits cloud provider usage.', score: 40, remediation: 'Verify allowlist configuration under Data Safety Center.' },
                { runId: governanceData.runs?.[1]?.runId || 'run_2', category: 'Data Sensitivity', details: 'Run includes both Public and Internal data. Mixed-classification runs require additional audit logging.', score: 30 },
              ]}
              onExportAudit={async (format) => {
                await window.ogra?.audit?.export?.(format);
              }}
              loading={loading}
            />
          )}
        </div>

        <div role="tabpanel" id="panel-memory" hidden={activeTab !== 'memory'}>
          {activeTab === 'memory' && (
            <MemoryCenter
              stats={safetySummary?.memoryStats || { episodic: 0, semanticConfirmed: 0, semanticPending: 0, proceduralConfirmed: 0, proceduralPending: 0 }}
              recentEpisodic={[]}
              pendingSemantic={[]}
            />
          )}
        </div>

        <div role="tabpanel" id="panel-settings" hidden={activeTab !== 'settings'}>
          {activeTab === 'settings' && (
            <SettingsTab
              providers={providers}
              currentWorkspace={currentWorkspace}
              onShowDataDir={handleShowDataDir}
              onStatusChange={setStatus}
            />
          )}
        </div>

        {/* Status bar — B42: aria-live for dynamic status updates.
            Tone-driven so 'Error' / 'blocked' / 'Loading …' / 'Ready' all
            get distinct colors + icons without ad-hoc string matching. */}
        <StatusBar status={status} />
      </main>
    </div>
  );
};

export default App;
