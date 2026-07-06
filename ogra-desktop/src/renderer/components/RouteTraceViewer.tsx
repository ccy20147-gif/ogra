import React from 'react';

interface RouteTraceProps {
  runId: string;
  route: string;
  dataClassification: string;
  highWaterSources: string[];
  reasons: string[];
  localSteps: string[];
  cloudSteps: string[];
  requiresUserApproval: boolean;
  providerId?: string;
  modelId?: string;
  cloudPayloadHash?: string;
  createdAt: string;
  /**
   * Explicit cloud-call status from the route decision. Spec §7 requires the
   * trace viewer to distinguish four states:
   *   - 'no_cloud_needed'         — no cloud call was needed.
   *   - 'cloud_blocked'           — cloud call was blocked by policy.
   *   - 'cloud_ogra_controlled'   — cloud call happened through an Ogra-controlled adapter.
   *   - 'unverifiable_outside'    — Ogra cannot prove activity outside its controlled adapters.
   * If omitted, the value is derived from the `route` and `cloudSteps`/`localSteps` fields.
   */
  cloudCallStatus?:
    | 'no_cloud_needed'
    | 'cloud_blocked'
    | 'cloud_ogra_controlled'
    | 'unverifiable_outside';
  events?: Array<{
    eventType: string;
    eventPayload: Record<string, unknown>;
    createdAt: string;
  }>;
}

const stepLabels: Record<string, string> = {
  run_created: 'Run Created',
  policy_precheck: 'Policy Pre-Check',
  retrieval_started: 'Retrieval Started',
  retrieval_completed: 'Retrieval Completed',
  context_policy: 'Context Policy Check',
  route_decision: 'Route Decision',
  risk_classification: 'Risk Classification',
  redaction_preview: 'Redaction Preview',
  approval_requested: 'Approval Requested',
  model_call_started: 'Model Call Started',
  model_call_completed: 'Model Call Completed',
  final_output: 'Final Output',
  audit_complete: 'Audit Complete',
  run_cancelled: 'Cancelled',
  run_failed: 'Failed',
  run_blocked: 'Blocked',
};

const routeColors: Record<string, string> = {
  local: '#238636',
  cloud: '#1f6feb',
  hybrid: '#d29922',
  blocked: '#da3633',
};

/**
 * Maps the spec §7 four cloud-call states to a colour, label, and description
 * so the trace viewer can render the appropriate badge.
 */
const CLOUD_CALL_STATE_META: Record<string, { color: string; label: string; description: string }> = {
  no_cloud_needed: {
    color: '#238636',
    label: 'No cloud call was needed',
    description: 'All steps ran locally. Ogra made no outbound calls through any adapter.',
  },
  cloud_blocked: {
    color: '#da3633',
    label: 'Cloud call was blocked',
    description: 'A cloud call was attempted but blocked by policy or classification.',
  },
  cloud_ogra_controlled: {
    color: '#1f6feb',
    label: 'Cloud call through Ogra-controlled adapter',
    description: 'Ogra brokered this call through one of its controlled adapters and recorded the payload hash.',
  },
  unverifiable_outside: {
    color: '#d29922',
    label: 'Activity outside Ogra-controlled adapters is unverifiable',
    description: 'Ogra cannot prove activity performed outside its controlled adapters (manual copy/paste, screenshots, provider-side retention, other local processes, etc.).',
  },
};

/** Derive a cloud-call state from the route-decision fields when not supplied. */
function deriveCloudCallStatus(trace: RouteTraceProps): keyof typeof CLOUD_CALL_STATE_META {
  if (trace.cloudCallStatus) return trace.cloudCallStatus;
  if (trace.route === 'blocked') return 'cloud_blocked';
  const hasCloud = (trace.cloudSteps?.length || 0) > 0;
  if (hasCloud && trace.providerId) return 'cloud_ogra_controlled';
  if (trace.route === 'cloud') return 'cloud_ogra_controlled';
  if (trace.route === 'hybrid') return 'unverifiable_outside';
  return 'no_cloud_needed';
}

export const RouteTraceViewer: React.FC<{ trace: RouteTraceProps }> = ({ trace }) => {
  const cloudStatus = deriveCloudCallStatus(trace);
  const cloudMeta = CLOUD_CALL_STATE_META[cloudStatus];

  return (
    <div style={{
      backgroundColor: '#161b22',
      border: '1px solid #30363d',
      borderRadius: '8px',
      padding: '16px',
      fontFamily: 'monospace',
      fontSize: '13px',
    }}>
      {/* Route Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        marginBottom: '16px',
        paddingBottom: '12px',
        borderBottom: '1px solid #21262d',
      }}>
        <span style={{ color: '#8b949e' }}>Route:</span>
        <span style={{
          color: '#fff',
          backgroundColor: routeColors[trace.route] || '#30363d',
          padding: '2px 10px',
          borderRadius: '12px',
          fontWeight: 600,
          fontSize: '12px',
          textTransform: 'uppercase',
        }}>
          {trace.route}
        </span>
        <span style={{ color: '#8b949e' }}>ID: {trace.runId.slice(0, 16)}...</span>
      </div>

      {/* Cloud-call status (spec §7) — distinguishes the four required states. */}
      <div
        role="status"
        aria-label={`Cloud call status: ${cloudMeta.label}`}
        style={{
          marginBottom: '12px',
          padding: '10px 12px',
          backgroundColor: '#0d1117',
          border: `1px solid ${cloudMeta.color}`,
          borderLeft: `4px solid ${cloudMeta.color}`,
          borderRadius: '6px',
        }}
      >
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          marginBottom: '4px',
        }}>
          <span style={{
            width: '10px',
            height: '10px',
            borderRadius: '50%',
            backgroundColor: cloudMeta.color,
            flexShrink: 0,
          }} />
          <span style={{
            color: cloudMeta.color,
            fontWeight: 600,
            fontSize: '12px',
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
          }}>
            {cloudMeta.label}
          </span>
        </div>
        <div style={{ fontSize: '11px', color: '#8b949e', lineHeight: 1.5 }}>
          {cloudMeta.description}
        </div>
      </div>

      {/* Reasons */}
      <div style={{ marginBottom: '12px' }}>
        <div style={{ color: '#8b949e', marginBottom: '4px', fontSize: '11px', textTransform: 'uppercase' }}>
          Reasons
        </div>
        {trace.reasons.map((r, i) => (
          <div key={i} style={{ color: '#e1e4e8', marginBottom: '2px' }}>• {r}</div>
        ))}
      </div>

      {/* Classification & Sources */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '12px',
        marginBottom: '12px',
        padding: '12px',
        backgroundColor: '#0d1117',
        borderRadius: '6px',
      }}>
        <div>
          <div style={{ color: '#8b949e', fontSize: '11px' }}>Classification</div>
          <div style={{ color: '#f0883e', fontWeight: 600 }}>{trace.dataClassification}</div>
        </div>
        <div>
          <div style={{ color: '#8b949e', fontSize: '11px' }}>Sources</div>
          <div style={{ color: '#e1e4e8' }}>{trace.highWaterSources.length} sources</div>
        </div>
        {trace.providerId && (
          <div>
            <div style={{ color: '#8b949e', fontSize: '11px' }}>Provider</div>
            <div style={{ color: '#e1e4e8' }}>{trace.providerId}</div>
          </div>
        )}
        {trace.modelId && (
          <div>
            <div style={{ color: '#8b949e', fontSize: '11px' }}>Model</div>
            <div style={{ color: '#e1e4e8' }}>{trace.modelId}</div>
          </div>
        )}
      </div>

      {/* Steps Timeline */}
      {trace.events && trace.events.length > 0 && (
        <div>
          <div style={{
            color: '#8b949e',
            marginBottom: '8px',
            fontSize: '11px',
            textTransform: 'uppercase',
            fontWeight: 600,
          }}>
            Timeline ({trace.events.length} events)
          </div>
          <div style={{ position: 'relative', paddingLeft: '20px' }}>
            {/* Vertical line */}
            <div style={{
              position: 'absolute',
              left: '6px',
              top: '0',
              bottom: '0',
              width: '2px',
              backgroundColor: '#21262d',
            }} />
            {trace.events.map((evt, i) => (
              <div key={i} style={{
                position: 'relative',
                paddingBottom: '12px',
                paddingLeft: '16px',
              }}>
                {/* Dot */}
                <div style={{
                  position: 'absolute',
                  left: '-14px',
                  top: '4px',
                  width: '10px',
                  height: '10px',
                  borderRadius: '50%',
                  backgroundColor: evt.eventType === 'run_failed' || evt.eventType === 'run_blocked'
                    ? '#da3633' : evt.eventType === 'audit_complete'
                      ? '#238636' : '#58a6ff',
                  border: '2px solid #0d1117',
                }} />
                <div style={{ color: '#e1e4e8', fontWeight: 500 }}>
                  {stepLabels[evt.eventType] || evt.eventType}
                </div>
                <div style={{ color: '#8b949e', fontSize: '11px' }}>
                  {new Date(evt.createdAt).toLocaleTimeString()}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Payload Hash */}
      {trace.cloudPayloadHash && (
        <div style={{
          marginTop: '12px',
          padding: '8px',
          backgroundColor: '#0d1117',
          borderRadius: '4px',
          fontSize: '11px',
          color: '#8b949e',
          wordBreak: 'break-all',
        }}>
          Cloud Payload Hash: {trace.cloudPayloadHash}
        </div>
      )}
    </div>
  );
};
