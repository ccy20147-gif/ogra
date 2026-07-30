/**
 * Sequence 1C Milestone 1 — Tool Broker types.
 *
 * Mirror of plan 11 §5 (Unified Tool Contract). The values here
 * are the SOLE serialization shape between Core (proposer /
 * invoker / audit) and Tool Host (executor). Anything not in this
 * shape is forbidden to flow across the boundary.
 */
import * as crypto from 'crypto';
import { canonicalJSON } from './audit-envelope';

export type ToolSourceKind = 'builtin' | 'skill' | 'mcp';
export type ToolTransport =
  | 'in_process'
  | 'isolated_worker'
  | 'mcp_stdio'
  | 'mcp_http';
export type ToolEffectClass =
  | 'read_only'
  | 'local_mutation'
  | 'external_mutation';
export type ToolRiskTier = 'low' | 'medium' | 'high' | 'blocked';
export type ToolVersionStatus =
  | 'discovered'
  | 'pending_review'
  | 'enabled'
  | 'stale'
  | 'revoked';
export type ToolDescriptorLifecycle =
  | 'discovered'
  | 'pending_review'
  | 'enabled'
  | 'stale'
  | 'revoked';
export type ToolApprovalMode = 'none' | 'allowlist' | 'each_call'
  | 'workflow_step' | 'administrative';

export interface ToolVersionDescriptor {
  id: string;
  descriptorId: string;
  sourceVersion: string;
  descriptorHash: string;
  inputSchema: Record<string, unknown>;
  inputSchemaHash: string;
  outputSchema?: Record<string, unknown>;
  outputSchemaHash?: string;
  effectClass: ToolEffectClass;
  permissions: Record<string, unknown>;
  recoveryCapabilities: Record<string, unknown>;
  provenance: Record<string, unknown>;
  transport: ToolTransport;
  riskTier: ToolRiskTier;
  status: ToolVersionStatus;
}

export interface ToolDescriptor {
  id: string;
  sourceKind: ToolSourceKind;
  sourceRef: string;
  logicalName: string;
  owner: string;
  latestVersionId: string | null;
  lifecycleState: ToolDescriptorLifecycle;
}

export interface WorkspaceToolBinding {
  id: string;
  workspaceId: string;
  toolVersionId: string;
  enabled: boolean;
  bindingHash: string;
  policyId: string | null;
  approvalMode: ToolApprovalMode;
  constraints: Record<string, unknown>;
}

/**
 * Canonical ToolId derivation. Production code MUST use this
 * helper; a string of `source_kind:source_ref#descriptor_id@version`
 * prevents name collisions across catalogs. UI may show
 * `toolDescriptor.logicalName`, but every policy / approval /
 * invocation references the canonical id.
 */
export function canonicalToolId(
  sourceKind: ToolSourceKind,
  sourceRef: string,
  descriptorId: string,
  version: string,
): string {
  // This identifier is an authorization handle, not a display label. Keep
  // source provenance in the derivation without serializing sourceRef (which
  // may be an implementation-specific URI) into policy or audit projections.
  // The fixed prefix also keeps the value valid in ActionLedger targets.
  const material = canonicalJSON({ sourceKind, sourceRef, descriptorId, version });
  return `tid_${crypto.createHash('sha256').update(material).digest('hex')}`;
}

/**
 * Display-only logical name for the built-in read-only vertical slice.
 * It MUST NOT be used as a policy, approval, invocation, or ledger key.
 */
export const KNOWLEDGE_SEARCH_LOGICAL_NAME = 'knowledge.search';

/**
 * Derive the opaque authorization id from a pinned descriptor/version pair.
 */
export function canonicalToolIdFor(
  descriptor: Pick<ToolDescriptor, 'sourceKind' | 'sourceRef' | 'id'>,
  version: Pick<ToolVersionDescriptor, 'descriptorId' | 'sourceVersion'>,
): string {
  if (version.descriptorId !== descriptor.id) {
    throw new Error('canonicalToolIdFor: version does not belong to descriptor');
  }
  return canonicalToolId(
    descriptor.sourceKind,
    descriptor.sourceRef,
    descriptor.id,
    version.sourceVersion,
  );
}

/**
 * T1/T2 executor allowlist. This deliberately recognizes a pinned source
 * identity, never a logical name alone: another catalog may publish a
 * `knowledge.search`, but it cannot obtain the built-in executor.
 */
export function isTrustedToolExecutionCapability(
  descriptor: Pick<ToolDescriptor, 'sourceKind' | 'sourceRef'>,
  version: Pick<ToolVersionDescriptor, 'effectClass' | 'transport'>,
): boolean {
  return descriptor.sourceKind === 'builtin'
    && descriptor.sourceRef === 'core:knowledge'
    && version.effectClass === 'read_only'
    && version.transport === 'in_process';
}

export function isAuthorizedCanonicalToolId(
  toolId: string,
  descriptor: ToolDescriptor,
  version: ToolVersionDescriptor,
): boolean {
  return isTrustedToolExecutionCapability(descriptor, version)
    && toolId === canonicalToolIdFor(descriptor, version);
}
