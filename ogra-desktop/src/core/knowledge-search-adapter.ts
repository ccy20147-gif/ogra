/**
 * Sequence 1C Milestone 1 — knowledge.search read-only vertical slice.
 *
 * Built-in read-only adapter for Ogra's local knowledge base. The
 * Tool Host is the SOLE executor; it NEVER opens SQLite directly
 * and NEVER holds the workspace secret bundle. It calls into the
 * Core-owned `KnowledgeQueryPort`, which production wires to the
 * real RAG engine; tests inject a fake port.
 *
 * The adapter is invoked from `ToolHost.dispatch()` under the Core
 * run, AFTER the plan-10 effect has been created and the
 * pre-callback CAS has transitioned the effect to `in_flight`.
 *
 * Sanitization:
 *   - Caller-supplied `workspaceId` is REJECTED. Core injects it
 *     via cfg.workspaceId. This prevents the IP / approval path
 *     from leaking the workspace id through arguments.
 *   - Snippet bytes are bounded by `cfg.maxSnippetBytes` so a
 *     malicious or oversized RAG response cannot exfiltrate.
 *   - Every hit carries `snippetHash` (sha256 of the canonical
 *     snippet). Raw bytes do not cross the ToolHost → Core
 *     boundary; only the bounded snippet is returned.
 */
import * as crypto from 'crypto';
import { canonicalJSON } from './audit-envelope';
import {
  KNOWLEDGE_SEARCH_LOGICAL_NAME, canonicalToolIdFor,
  isAuthorizedCanonicalToolId,
  ToolDescriptor, ToolVersionDescriptor,
  ToolSourceKind, ToolDescriptorLifecycle, ToolTransport,
  ToolEffectClass, ToolRiskTier, ToolVersionStatus,
} from './tool-broker-types';
import { OgraError, OgraErrorCode } from '../shared/errors';
import { DataClassification } from '../shared/types';

// Re-export for callers that should not reach into tool-broker-types.
export { KNOWLEDGE_SEARCH_LOGICAL_NAME } from './tool-broker-types';

/** The descriptor schema, binding authority, and SQL policy gate share this cap. */
export const MAX_KNOWLEDGE_SEARCH_KB_IDS = 32;

export interface KnowledgeSearchInput {
  query: string;
  /** Optional top-K override; clamped to [1, 20]. */
  topK?: number;
  /** Caller-supplied workspace id is REJECTED — Core injects it. */
  workspaceId?: string;
  maxClassification?: 'public' | 'internal' | 'confidential';
  knowledgeBaseIds?: string[];
  maxBytes?: number;
}

export interface KnowledgeSearchHit {
  knowledgeBaseId: string;
  documentId: string;
  chunkId: string;
  snippet: string;
  snippetHash: string;
  classification: DataClassification;
  score: number;
}

export interface KnowledgeSearchResult {
  /** Display-only result type. Authorization uses ToolInvocationProposal.toolId. */
  type: typeof KNOWLEDGE_SEARCH_LOGICAL_NAME;
  workspaceId: string;
  knowledgeBaseIds: string[];
  maxClassification: DataClassification;
  queryDigest: string;
  topK: number;
  totalHits: number;
  hits: KnowledgeSearchHit[];
}

/**
 * KnowledgeQueryPort — the narrow API the Tool Host is allowed
 * to call. Production Core implements it by delegating to
 * RagEngine with workspace scope injection. The adapter receives
 * ONLY refs / hashes / classification; raw RAG bytes are bounded
 * at the port boundary.
 */
export interface KnowledgeQueryPort {
  search(input: {
    workspaceId: string;
    knowledgeBaseIds: string[];
    query: string;
    topK: number;
    maxBytes: number;
    maxClassification: DataClassification;
    /**
     * Core-only execution identity. This is deliberately separate from
     * KnowledgeSearchInput, so it is never agent-provided, schema-validated,
     * or included in the sealed tool arguments.
     */
    runId?: string;
  }): Promise<KnowledgeSearchResult>;
}

export interface KnowledgeSearchAdapterInputs {
  /** Core-injected. The adapter MUST be bound to a workspace. */
  workspaceId: string;
  /** Core-injected. Closed list of enabled KB ids for the workspace. */
  enabledKnowledgeBaseIds: string[];
  /** Hard cap on snippet bytes per hit. */
  maxSnippetBytes: number;
}

/** Core-only metadata carried beside a ToolHost proposal, never inside it. */
export interface ToolExecutionContext {
  runId?: string;
}

export interface KnowledgeSearchBindingAuthority {
  workspaceId: string;
  toolVersionId: string;
  preparedToolVersionId: string;
  bindingHash: string;
  preparedBindingHash: string;
  policyId: string | null;
  approvalMode: string;
  constraints: unknown;
}

export interface KnowledgeSearchHitAuthority {
  classification: DataClassification;
}

export function truncateUtf8ToBytes(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return encoded.subarray(0, end).toString('utf8');
}

export function authorizedKnowledgeBaseScope(
  input: KnowledgeSearchInput,
  enabledKnowledgeBaseIds: readonly string[],
): string[] {
  const allowed = new Set(enabledKnowledgeBaseIds);
  const requested = input.knowledgeBaseIds ?? enabledKnowledgeBaseIds;
  return [...new Set(requested.filter((id) => allowed.has(id)))];
}

export function effectiveSnippetByteCap(
  input: KnowledgeSearchInput,
  bindingMaxSnippetBytes: number,
): number {
  return Math.min(input.maxBytes ?? bindingMaxSnippetBytes, bindingMaxSnippetBytes);
}

/**
 * Bind a schema-valid result to the prepared invocation authority. This exact
 * verifier is used before live receipt sealing and by every tool recovery path.
 */
export function verifyKnowledgeSearchResultAuthority(input: {
  result: KnowledgeSearchResult;
  arguments: KnowledgeSearchInput;
  expectedWorkspaceId: string;
  binding: KnowledgeSearchBindingAuthority;
  lookupHitAuthority: (hit: KnowledgeSearchHit) => KnowledgeSearchHitAuthority | null;
}): void {
  const reject = (): never => {
    throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
      'knowledge.search result does not match sealed invocation authority');
  };
  if (!input.binding.constraints || typeof input.binding.constraints !== 'object'
      || Array.isArray(input.binding.constraints)) reject();
  const constraints = input.binding.constraints as Record<string, unknown>;
  const enabled = constraints.enabledKnowledgeBaseIds;
  const bindingMaxBytes = constraints.maxSnippetBytes;
  if (!Array.isArray(enabled) || enabled.length === 0
      || enabled.length > MAX_KNOWLEDGE_SEARCH_KB_IDS
      || enabled.some((id) => typeof id !== 'string' || id.length === 0)
      || new Set(enabled).size !== enabled.length
      || !Number.isInteger(bindingMaxBytes) || (bindingMaxBytes as number) < 1
      || (bindingMaxBytes as number) > 4096) reject();

  const computedBindingHash = crypto.createHash('sha256').update(canonicalJSON({
    workspaceId: input.binding.workspaceId,
    toolVersionId: input.binding.toolVersionId,
    policyId: input.binding.policyId,
    approvalMode: input.binding.approvalMode,
    constraints,
  })).digest('hex');
  if (input.binding.workspaceId !== input.expectedWorkspaceId
      || input.binding.toolVersionId !== input.binding.preparedToolVersionId
      || computedBindingHash !== input.binding.bindingHash
      || computedBindingHash !== input.binding.preparedBindingHash) reject();

  const expectedKnowledgeBaseIds = authorizedKnowledgeBaseScope(
    input.arguments, enabled as string[],
  );
  const expectedQueryDigest = crypto.createHash('sha256')
    .update(canonicalJSON(input.arguments.query)).digest('hex');
  const expectedTopK = input.arguments.topK ?? 5;
  const expectedClassification = input.arguments.maxClassification === 'public'
    ? DataClassification.Public
    : input.arguments.maxClassification === 'internal'
      ? DataClassification.Internal
      : DataClassification.Confidential;
  const snippetByteCap = effectiveSnippetByteCap(
    input.arguments, bindingMaxBytes as number,
  );
  const rank: Record<DataClassification, number> = {
    [DataClassification.Public]: 0,
    [DataClassification.Internal]: 1,
    [DataClassification.Confidential]: 2,
    [DataClassification.Restricted]: 3,
  };
  if (input.result.workspaceId !== input.expectedWorkspaceId
      || input.result.queryDigest !== expectedQueryDigest
      || input.result.topK !== expectedTopK
      || input.result.maxClassification !== expectedClassification
      || input.result.totalHits !== input.result.hits.length
      || input.result.totalHits > expectedTopK
      || input.result.knowledgeBaseIds.length !== expectedKnowledgeBaseIds.length
      || input.result.knowledgeBaseIds.some(
        (id, index) => id !== expectedKnowledgeBaseIds[index],
      )) reject();

  const resultKnowledgeBaseIds = new Set(input.result.knowledgeBaseIds);
  const seenChunks = new Set<string>();
  for (const hit of input.result.hits) {
    if (!resultKnowledgeBaseIds.has(hit.knowledgeBaseId)
        || seenChunks.has(hit.chunkId)
        || rank[hit.classification] > rank[expectedClassification]
        || Buffer.byteLength(hit.snippet, 'utf8') > snippetByteCap
        || crypto.createHash('sha256').update(canonicalJSON(hit.snippet)).digest('hex')
          !== hit.snippetHash) reject();
    seenChunks.add(hit.chunkId);
    const authority = input.lookupHitAuthority(hit);
    if (!authority || authority.classification !== hit.classification) reject();
  }
}

/**
 * knowledge.search adapter. Validates canonical toolId, hashes the
 * query, narrows scope to Core-injected workspace + allowed KBs,
 * then delegates to the KnowledgeQueryPort.
 *
 * The ToolHost's constructor accepts KBs=[] (so an OgraCore test
 * path that never touches the broker can still build); the gate
 * runs at dispatch() time, not at construction, so that the
 * broker can be lazily bound to a real workspace + KB list.
 */
export class KnowledgeSearchAdapter {
  constructor(
    private readonly port: KnowledgeQueryPort,
    private readonly cfg: KnowledgeSearchAdapterInputs,
  ) {
    if (!cfg.workspaceId) {
      throw new OgraError(OgraErrorCode.PERMISSION_DENIED,
        'knowledge.search: workspace is required');
    }
    // KBs are validated lazily inside invoke() so the host can
    // be constructed with empty KBs and bound at first use.
  }

  private assertReady(): void {
    if (!Array.isArray(this.cfg.enabledKnowledgeBaseIds)) {
      throw new OgraError(OgraErrorCode.PERMISSION_DENIED,
        'knowledge.search: at least one allowed KB id is required');
    }
    // An unbound host carries the placeholder '__t1_unbound__' +
    // []; if dispatch is attempted before ensureKnowledgeSearchBinding
    // ran, fail closed. A real binding sets a non-placeholder
    // workspaceId and a non-empty KB list.
    if (this.cfg.workspaceId === '__t1_unbound__'
        || this.cfg.enabledKnowledgeBaseIds.length === 0
        || this.cfg.enabledKnowledgeBaseIds.length > MAX_KNOWLEDGE_SEARCH_KB_IDS
        || new Set(this.cfg.enabledKnowledgeBaseIds).size
          !== this.cfg.enabledKnowledgeBaseIds.length) {
      throw new OgraError(OgraErrorCode.PERMISSION_DENIED,
        'knowledge.search: not bound to a workspace + KB; call OgraCore.ensureKnowledgeSearchBinding first');
    }
  }

  /**
   * Map Core-validated arguments to an invocation. Canonical ToolId
   * authorization occurs at ToolHost.dispatch, where descriptor/version
   * identity is available.
   * The adapter strips any caller-supplied workspaceId (Core
   * injects one). The result is fully sealed (input hashed, only
   * refs/digests returned to Core).
   */
  async invoke(
    input: KnowledgeSearchInput,
    context: ToolExecutionContext = {},
  ): Promise<KnowledgeSearchResult> {
    // Lazy readiness gate — see assertReady() above.
    this.assertReady();
    if (typeof input?.query !== 'string'
        || input.query.length === 0) {
      throw new OgraError(OgraErrorCode.PERMISSION_DENIED,
        'knowledge.search: query must be a non-empty string');
    }
    // Caller-supplied workspaceId is REJECTED at the adapter
    // boundary — Core injects the right one via cfg.workspaceId.
    if (input.workspaceId !== undefined) {
      throw new OgraError(OgraErrorCode.PERMISSION_DENIED,
        'knowledge.search: caller-supplied workspaceId is not honored');
    }
    const topK = Math.min(
      Math.max(1, input.topK ?? 5),
      20,
    );
    // The binding is the authority for the default scope. An Agent may narrow
    // it by proposing a subset, but omission must not turn an otherwise
    // authorized deterministic search into an empty no-op (nor require the
    // Agent to reconstruct Core-owned binding state).
    const kbIds = authorizedKnowledgeBaseScope(
      input, this.cfg.enabledKnowledgeBaseIds,
    );
    const queryDigest = crypto.createHash('sha256')
      .update(canonicalJSON(input.query)).digest('hex');
    const maxClassification = input.maxClassification === 'public'
      ? DataClassification.Public
      : input.maxClassification === 'internal'
        ? DataClassification.Internal
        : input.maxClassification === 'confidential'
          ? DataClassification.Confidential
          : DataClassification.Confidential;
    // No KB allowed by binding — return empty rather than scan
    // the whole workspace. The queryDigest is still emitted so
    // the audit packet has reproducible evidence.
    if (kbIds.length === 0) {
      return {
        type: KNOWLEDGE_SEARCH_LOGICAL_NAME,
        workspaceId: this.cfg.workspaceId,
        knowledgeBaseIds: [],
        maxClassification,
        queryDigest,
        topK,
        totalHits: 0,
        hits: [],
      };
    }
    const maxSnippetBytes = effectiveSnippetByteCap(
      input, this.cfg.maxSnippetBytes,
    );
    const portResult = await this.port.search({
      workspaceId: this.cfg.workspaceId,
      knowledgeBaseIds: kbIds,
      query: input.query,
      topK,
      maxBytes: maxSnippetBytes,
      maxClassification,
      runId: context.runId,
    });
    // Adapter returns the port response verbatim but ensures
    // every snippet is bounded + hashed. The Core sanitizer
    // narrows further before the response reaches audit.
    const hits: KnowledgeSearchHit[] = (portResult.hits ?? []).map((hit) => {
      const safeSnippet = truncateUtf8ToBytes(
        hit.snippet ?? '', maxSnippetBytes,
      );
      const snippetHash = crypto.createHash('sha256')
        .update(canonicalJSON(safeSnippet)).digest('hex');
      return {
        knowledgeBaseId: hit.knowledgeBaseId,
        documentId: hit.documentId,
        chunkId: hit.chunkId,
        snippet: safeSnippet,
        snippetHash,
        classification: hit.classification,
        score: hit.score,
      };
    });
    return {
      type: KNOWLEDGE_SEARCH_LOGICAL_NAME,
      workspaceId: this.cfg.workspaceId,
      knowledgeBaseIds: kbIds,
      maxClassification,
      queryDigest,
      topK,
      totalHits: hits.length,
      hits,
    };
  }
}

/**
 * The canonical argument schema for knowledge.search. Used by
 * CapabilityGateway's prepareInvocation. Any change here is a new
 * tool version + a new pending schema review.
 */
export const KNOWLEDGE_SEARCH_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['query'],
  additionalProperties: false,
  properties: {
    query: { type: 'string', minLength: 1, maxLength: 1024 },
    topK: { type: 'integer', minimum: 1, maximum: 20 },
    knowledgeBaseIds: {
      type: 'array',
      items: { type: 'string', pattern: '^[a-z0-9_-]+$' },
      maxItems: 32,
    },
    maxClassification: {
      type: 'string',
      enum: ['public', 'internal', 'confidential'],
    },
    maxBytes: { type: 'integer', minimum: 64, maximum: 65536 },
  },
};

/**
 * Tool Host — the SOLE executor for built-in tools. It receives
 * scoped job input only (Core injects workspaceId, KB ids,
 * transport, permissions) and returns refs / hashes. Tool Host
 * NEVER opens SQLite directly. It calls KnowledgeQueryPort.search()
 * which the production Core wires to the real RagEngine; tests
 * inject a fake port.
 */
export interface ToolHostInputs {
  knowledgeSearch: KnowledgeSearchAdapterInputs;
}

export interface ToolInvocationProposal {
  toolId: string;
  arguments: unknown;
  descriptor: ToolDescriptor;
  version: ToolVersionDescriptor;
  /** Owned by the dispatch site. The host does not read secrets. */
  workspaceId: string;
}

export class ToolHost {
  private readonly knowledgeSearchAdapter: KnowledgeSearchAdapter;

  constructor(
    private readonly port: KnowledgeQueryPort,
    inputs: ToolHostInputs,
  ) {
    this.knowledgeSearchAdapter = new KnowledgeSearchAdapter(
      port, inputs.knowledgeSearch,
    );
  }

  /**
   * Dispatch a tool invocation. toolId MUST be in the closed set;
   * arguments MUST conform to the pinned version's input schema
   * (schema validation is Core's job, before this call).
   */
  async dispatch(
    proposal: ToolInvocationProposal,
    context: ToolExecutionContext = {},
  ): Promise<KnowledgeSearchResult> {
    const canonicalId = canonicalToolIdFor(proposal.descriptor, proposal.version);
    if (!isAuthorizedCanonicalToolId(
      proposal.toolId, proposal.descriptor, proposal.version,
    ) || proposal.toolId !== canonicalId) {
      throw new OgraError(OgraErrorCode.PERMISSION_DENIED,
        `ToolHost.dispatch: closed-set violation on ${proposal.toolId}`);
    }
    if (proposal.descriptor.lifecycleState !== 'enabled') {
      throw new OgraError(OgraErrorCode.PERMISSION_DENIED,
        `ToolHost.dispatch: descriptor ${proposal.descriptor.id} state=${proposal.descriptor.lifecycleState}`);
    }
    if (proposal.version.status !== 'enabled') {
      throw new OgraError(OgraErrorCode.PERMISSION_DENIED,
        `ToolHost.dispatch: version ${proposal.version.id} status=${proposal.version.status}`);
    }
    // The host is unaware of the agent's workspace. The Core-side
    // adapter configuration has already locked it. The proposal's
    // workspaceId must match the configured one or we drop on the
    // floor — this prevents a malicious proposal from forcing a
    // different workspace scope.
    if (proposal.workspaceId !== this.knowledgeSearchAdapter['cfg'].workspaceId) {
      throw new OgraError(OgraErrorCode.WORKSPACE_MISMATCH,
        'ToolHost.dispatch: proposal workspaceId does not match configured scope');
    }
    return this.knowledgeSearchAdapter.invoke(
      proposal.arguments as KnowledgeSearchInput,
      context,
    );
  }
}

/**
 * Seed the canonical knowledge.search v1 descriptor + binding
 * for one workspace. This is the only built-in tool allowed at
 * the T2 vertical slice.
 *
 * Returns the tool_version_id + binding_id so CapabilityGateway
 * can wire the run path.
 */
export interface SeedKnowledgeSearchInput {
  workspaceId: string;
  enabledKnowledgeBaseIds: string[];
  approvalMode?: 'none' | 'require_approval';
  policyId?: string | null;
}

export interface SeedKnowledgeSearchResult {
  descriptorId: string;
  toolVersionId: string;
  bindingId: string;
  bindingHash: string;
  inputSchemaHash: string;
}

export function buildKnowledgeSearchDescriptor(): {
  sourceKind: ToolSourceKind; sourceRef: string; logicalName: string;
  owner: string; sourceVersion: string; inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>; effectClass: ToolEffectClass;
  permissions: Record<string, unknown>; recoveryCapabilities: Record<string, unknown>;
  provenance: Record<string, unknown>; transport: ToolTransport;
  riskTier: ToolRiskTier;
} {
  return {
    sourceKind: 'builtin',
    sourceRef: 'core:knowledge',
    logicalName: KNOWLEDGE_SEARCH_LOGICAL_NAME,
    owner: 'core',
    sourceVersion: '1.0.0',
    inputSchema: KNOWLEDGE_SEARCH_INPUT_SCHEMA,
    outputSchema: {
      type: 'object',
      required: [
        'type', 'workspaceId', 'knowledgeBaseIds', 'maxClassification',
        'queryDigest', 'topK', 'totalHits', 'hits',
      ],
      additionalProperties: false,
      properties: {
        type: { type: 'string', const: KNOWLEDGE_SEARCH_LOGICAL_NAME },
        // Workspace identifiers are Core-issued opaque strings; they are not
        // restricted to a transport alphabet (test and imported ids may use
        // upper-case). Bound length is the meaningful output contract.
        workspaceId: { type: 'string', minLength: 1, maxLength: 128 },
        knowledgeBaseIds: {
          type: 'array', maxItems: 32,
          items: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9_-]+$' },
        },
        maxClassification: {
          type: 'string', enum: ['Public', 'Internal', 'Confidential', 'Restricted'],
        },
        queryDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        topK: { type: 'integer', minimum: 1, maximum: 20 },
        totalHits: { type: 'integer', minimum: 0, maximum: 20 },
        hits: { type: 'array', maxItems: 32,
          items: {
            type: 'object',
            required: [
              'knowledgeBaseId', 'documentId', 'chunkId', 'snippet',
              'snippetHash', 'classification', 'score',
            ],
            additionalProperties: false,
            properties: {
              knowledgeBaseId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9_-]+$' },
              documentId: { type: 'string', minLength: 1, maxLength: 256 },
              chunkId: { type: 'string', minLength: 1, maxLength: 256 },
              snippet: { type: 'string', maxLength: 4096, maxBytes: 4096 },
              snippetHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
              classification: { type: 'string', enum: ['Public', 'Internal', 'Confidential', 'Restricted'] },
              score: { type: 'number' },
            },
          },
        },
      },
    },
    effectClass: 'read_only',
    permissions: { fs: 'none', net: 'none', secrets: 'none' },
    recoveryCapabilities: {
      supportsIdempotencyKey: false,
      supportsOutcomeQuery: false,
      supportsCancel: true,
      supportsCompensation: false,
      retryCostRisk: 'low',
      duplicateEffectRisk: 'low',
      auditLevel: 'summary',
    },
    provenance: {
      addedBy: 'Sequence 1C Milestone 1',
      reviewedAt: null,
      transport: 'in_process',
    },
    transport: 'in_process',
    riskTier: 'low',
  };
}
