/**
 * Core-owned agent manifest contract for Tool Broker invocations.
 *
 * A run stores a canonical snapshot of this data.  Callers never provide a
 * manifest to the broker: Core creates it from the enabled InternalAgent
 * capability set when it creates the run, then the gateway verifies it before
 * any lease or effect is created.
 */
import * as crypto from 'crypto';
import { canonicalJSON } from './audit-envelope';

export interface AgentPermissions {
  canUseCloud: boolean;
  canWriteToDisk: boolean;
  canAccessNetwork: boolean;
  allowedTools: string[];
}

export interface ParsedAgentManifest {
  permissions: AgentPermissions;
  canonicalToolIds: string[];
}

export interface InternalAgentManifestSnapshot {
  manifestJson: string;
  manifestHash: string;
}

const CANONICAL_TOOL_ID = /^tid_[a-f0-9]{64}$/;

function asUniqueCanonicalToolIds(value: unknown): string[] | null {
  if (!Array.isArray(value)
      || value.some((toolId) => typeof toolId !== 'string' || !CANONICAL_TOOL_ID.test(toolId))
      || new Set(value).size !== value.length) {
    return null;
  }
  return [...value];
}

/** Build the only M1 trusted manifest. It intentionally has no implicit tools. */
export function buildInternalAgentManifest(toolIds: string[]): InternalAgentManifestSnapshot {
  const canonicalToolIds = asUniqueCanonicalToolIds(toolIds);
  if (!canonicalToolIds) {
    throw new Error('InternalAgent manifest contains an invalid canonical ToolId');
  }
  const manifest = {
    schemaVersion: 'ogra.agent-manifest.v1',
    agent: { id: 'internal_agent', kind: 'internal' },
    capabilities: { tools: canonicalToolIds },
    permissions: {
      canUseCloud: false,
      canWriteToDisk: false,
      canAccessNetwork: false,
      allowedTools: canonicalToolIds,
    },
  };
  const manifestJson = canonicalJSON(manifest);
  return {
    manifestJson,
    manifestHash: crypto.createHash('sha256').update(manifestJson).digest('hex'),
  };
}

/**
 * Parse the closed manifest shape used by the tool policy boundary. A missing
 * or empty tool list is structurally valid but grants no capability; callers
 * must separately require their requested canonical tool to be present.
 */
export function parseAgentManifest(manifestJson: string): ParsedAgentManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const capabilities = record.capabilities;
  const permissions = record.permissions;
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)
      || !permissions || typeof permissions !== 'object' || Array.isArray(permissions)) {
    return null;
  }
  const canonicalToolIds = asUniqueCanonicalToolIds(
    (capabilities as Record<string, unknown>).tools,
  );
  const perms = permissions as Record<string, unknown>;
  const allowedTools = asUniqueCanonicalToolIds(perms.allowedTools);
  if (!canonicalToolIds || !allowedTools
      || typeof perms.canUseCloud !== 'boolean'
      || typeof perms.canWriteToDisk !== 'boolean'
      || typeof perms.canAccessNetwork !== 'boolean'
      || canonicalJSON(canonicalToolIds) !== canonicalJSON(allowedTools)) {
    return null;
  }
  return {
    canonicalToolIds,
    permissions: {
      canUseCloud: perms.canUseCloud,
      canWriteToDisk: perms.canWriteToDisk,
      canAccessNetwork: perms.canAccessNetwork,
      allowedTools,
    },
  };
}

export function hashAgentManifest(manifestJson: string): string {
  return crypto.createHash('sha256').update(manifestJson).digest('hex');
}
