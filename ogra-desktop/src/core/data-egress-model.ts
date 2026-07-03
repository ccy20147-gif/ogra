import { DataClassification, RiskLevel, RunEventType } from '../shared/types';
import { PolicyEvaluationInput } from './policy-service';

/**
 * Data Egress Model for Ogra Desktop.
 *
 * Documents what Ogra controls and does not control
 * in terms of data egress paths. This is used by
 * Data Safety Center to explain the scope of
 * "0 Ogra-managed cloud calls".
 */
export interface EgressPath {
  name: string;
  description: string;
  controlled: boolean;
  mitigation: string;
  visibleInUI: boolean;
}

export class DataEgressModel {
  /**
   * Returns the complete list of modeled egress paths.
   */
  getModeledPaths(): EgressPath[] {
    return [
      {
        name: 'model_payloads',
        description: 'Content sent to model providers through Ogra-controlled adapters',
        controlled: true,
        mitigation: 'Policy evaluation, payload hashing, audit trail, redaction',
        visibleInUI: true,
      },
      {
        name: 'embedding_requests',
        description: 'Content sent to embedding providers through Ogra adapters',
        controlled: true,
        mitigation: 'Policy evaluation before embedding, payload hashing',
        visibleInUI: true,
      },
      {
        name: 'ogra_exports',
        description: 'File exports initiated through Ogra UI',
        controlled: true,
        mitigation: 'Audit event on export, policy check before export',
        visibleInUI: true,
      },
      {
        name: 'user_copy_paste',
        description: 'User manually copies data from Ogra and pastes elsewhere',
        controlled: false,
        mitigation: 'Cannot be prevented by Ogra. User responsibility.',
        visibleInUI: true,
      },
      {
        name: 'screenshots',
        description: 'User or OS takes screenshots of Ogra windows',
        controlled: false,
        mitigation: 'Cannot be prevented by Ogra. OS-level action.',
        visibleInUI: true,
      },
      {
        name: 'clipboard',
        description: 'Content placed on system clipboard',
        controlled: false,
        mitigation: 'Ogra does not intercept clipboard. User responsibility.',
        visibleInUI: true,
      },
      {
        name: 'provider_side_retention',
        description: 'Data retained by third-party model providers after an approved cloud call',
        controlled: false,
        mitigation: 'Provider metadata shows retention policy. User must evaluate provider trust.',
        visibleInUI: true,
      },
      {
        name: 'os_network_traffic',
        description: 'OS-level network traffic from non-Ogra processes',
        controlled: false,
        mitigation: 'Ogra only controls its own outbound calls.',
        visibleInUI: true,
      },
      {
        name: 'telemetry_crash_reports',
        description: 'Application telemetry or crash report data',
        controlled: false,
        mitigation: 'Disabled by default in Alpha. Would require explicit user consent.',
        visibleInUI: true,
      },
      {
        name: 'local_agent_network',
        description: 'Network requests from locally-launched agent runtimes',
        controlled: false,
        mitigation: 'Depends on adapter capability. Limited in Alpha. User must review agent permissions.',
        visibleInUI: true,
      },
      {
        name: 'browser_tools',
        description: 'Data accessed or sent through browser automation tools',
        controlled: false,
        mitigation: 'Not implemented in Alpha. Would require explicit policy when added.',
        visibleInUI: true,
      },
      {
        name: 'mcp_tools',
        description: 'Data sent through MCP tool integrations',
        controlled: false,
        mitigation: 'Not implemented in Alpha. Would require manifest, permission, and audit when added.',
        visibleInUI: true,
      },
      {
        name: 'remote_a2a_agents',
        description: 'Data sent to remote A2A-compatible agents',
        controlled: false,
        mitigation: 'Not implemented in Alpha. Would require policy, route decision, and audit when added.',
        visibleInUI: true,
      },
      {
        name: 'stdout_stderr',
        description: 'Output from local agent runtimes sent to stdout/stderr',
        controlled: false,
        mitigation: 'Ogra captures stdout/stderr transcript when adapter supports it. Cannot prevent external capture.',
        visibleInUI: true,
      },
    ];
  }

  /**
   * Returns the controlled egress paths summary for UI display.
   */
  getControlledSummary(): { total: number; controlled: number; uncontrolled: number } {
    const paths = this.getModeledPaths();
    return {
      total: paths.length,
      controlled: paths.filter(p => p.controlled).length,
      uncontrolled: paths.filter(p => !p.controlled).length,
    };
  }

  /**
   * Generates the standard "0 Ogra-managed cloud calls" copy.
   */
  getZeroCloudCallsCopy(): string {
    return 'Ogra can prove calls made through Ogra-controlled adapters. This does not cover manual copy/paste, screenshots, tools launched outside Ogra, provider-side retention after approved calls, or other local processes.';
  }
}
