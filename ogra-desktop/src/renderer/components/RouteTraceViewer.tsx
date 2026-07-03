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

export const RouteTraceViewer: React.FC<{ trace: RouteTraceProps }> = ({ trace }) => {
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
