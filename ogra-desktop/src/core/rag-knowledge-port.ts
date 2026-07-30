/**
 * Sequence 1C Milestone 1 — RagEngine ↔ KnowledgeQueryPort adapter.
 *
 * Production Core wires RagEngine to the Tool Host's KnowledgeQueryPort
 * through this class. The Tool Host receives ONLY refs / hashes / snippet
 * bytes (bounded); it never opens SQLite and never sees the workspace's
 * raw documents.
 *
 * `search()` joins RagEngine's FTS5 retrieval back to documents to
 * recover `knowledgeBaseId`, then maps each RetrievalResult into a
 * KnowledgeSearchHit. Hits carrying a classification higher than the
 * caller's `maxClassification` are filtered out before they cross the
 * boundary.
 */
import { RagEngine, RetrievalResult } from '../edge/rag-engine';
import { DatabaseService } from './database-service';
import {
  KnowledgeQueryPort, KnowledgeSearchResult, KnowledgeSearchHit,
  KNOWLEDGE_SEARCH_LOGICAL_NAME, truncateUtf8ToBytes,
} from './knowledge-search-adapter';
import { OgraError, OgraErrorCode } from '../shared/errors';
import { DataClassification } from '../shared/types';

/**
 * Canonicalise a possibly-spelled classification string into the four
 * Ogra variants. Unknown values stay unknown so they cannot be silently
 * downgraded into a caller-visible classification.
 */
function normaliseClassification(
  raw: DataClassification | string | null | undefined,
): DataClassification | null {
  if (raw === DataClassification.Public
      || raw === DataClassification.Internal
      || raw === DataClassification.Confidential
      || raw === DataClassification.Restricted) {
    return raw;
  }
  switch (raw) {
    case 'Public':
    case 'public': return DataClassification.Public;
    case 'Internal':
    case 'internal': return DataClassification.Internal;
    case 'Confidential':
    case 'confidential': return DataClassification.Confidential;
    case 'Restricted':
    case 'restricted': return DataClassification.Restricted;
    default: return null;
  }
}

/** Water-mark ranking — Public < Internal < Confidential < Restricted. */
const RANK: Record<DataClassification, number> = {
  [DataClassification.Public]: 0,
  [DataClassification.Internal]: 1,
  [DataClassification.Confidential]: 2,
  [DataClassification.Restricted]: 3,
};

export interface RagKnowledgePortInputs {
  ragEngine: RagEngine;
  databaseService: DatabaseService;
  /** When true (default true), the adapter also respects
   *  document_chunks.allowed_for_context=1 — disabled chunks
   *  are dropped even if their classification is below the bound. */
  enforceChunkAllowedForContext?: boolean;
}

export class RagKnowledgeQueryAdapter implements KnowledgeQueryPort {
  constructor(private readonly cfg: RagKnowledgePortInputs) {}

  async search(input: {
    workspaceId: string;
    knowledgeBaseIds: string[];
    query: string;
    topK: number;
    maxBytes: number;
    maxClassification: DataClassification;
    /** Core-owned execution identity, never part of agent tool arguments. */
    runId?: string;
  }): Promise<KnowledgeSearchResult> {
    const cap = normaliseClassification(input.maxClassification);
    if (!cap) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        'knowledge.search: invalid maximum classification');
    }
    const capRank = RANK[cap];
    if (!input.query || input.query.trim().length === 0) {
      return {
        type: KNOWLEDGE_SEARCH_LOGICAL_NAME,
        workspaceId: input.workspaceId,
        knowledgeBaseIds: input.knowledgeBaseIds,
        maxClassification: cap,
        queryDigest: '',
        topK: input.topK,
        totalHits: 0,
        hits: [],
      };
    }
    // RagEngine.retrieve takes (query, workspaceId, maxResults,
    // classification, runId?). We pass the upper-bound classification
    // — anything higher than `cap` should not be returned. Then we
    // double-filter on the way out so a mis-ranked row from a
    // misconfigured index never escapes.
    const retrievalResults: RetrievalResult[] = this.cfg.ragEngine.retrieve(
      input.query,
      input.workspaceId,
      input.topK * 4, // over-fetch so the per-KB filter has headroom
      cap,
    );
    // Resolve knowledgeBaseId for each chunk_id via documents. The
    // join enforces that the chunk is in the active workspace; a
    // cross-workspace chunk would never appear here.
    const chunkIds = retrievalResults.map(r => r.chunkId);
    let kbByChunk = new Map<string, string>();
    if (chunkIds.length > 0) {
      const placeholders = chunkIds.map(() => '?').join(',');
      const rows = this.cfg.databaseService.getRawDB().prepare(`
        SELECT dc.id AS chunk_id, d.knowledge_base_id AS kb_id,
               dc.allowed_for_context AS allowed
          FROM document_chunks dc
          JOIN documents d ON d.id = dc.document_id
         WHERE dc.workspace_id = ? AND dc.id IN (${placeholders})
      `).all(input.workspaceId, ...chunkIds) as Array<{
        chunk_id: string; kb_id: string; allowed: number;
      }>;
      kbByChunk = new Map(rows.map(r => [r.chunk_id, r.kb_id]));
    }
    const kbAllowed = new Set(input.knowledgeBaseIds);
    const enforceAllowed = this.cfg.enforceChunkAllowedForContext !== false;
    // Build an "allowed_for_context" lookup alongside the kb_id
    // lookup so the loop can drop disallowed chunks when the
    // flag is on. With `enforceAllowed = true` (default) a chunk
    // row marked `allowed_for_context = 0` is silently filtered
    // out here; with `enforceAllowed = false` the flag is bypassed
    // (the operator has explicitly opted out of the filter).
    let allowedByChunk = new Map<string, number>();
    if (enforceAllowed && chunkIds.length > 0) {
      const placeholders = chunkIds.map(() => '?').join(',');
      const rows = this.cfg.databaseService.getRawDB().prepare(`
        SELECT id AS chunk_id, allowed_for_context AS allowed
          FROM document_chunks
         WHERE workspace_id = ? AND id IN (${placeholders})
      `).all(input.workspaceId, ...chunkIds) as Array<{
        chunk_id: string; allowed: number;
      }>;
      allowedByChunk = new Map(rows.map(r => [r.chunk_id, r.allowed]));
    }
    const hits: KnowledgeSearchHit[] = [];
    for (const r of retrievalResults) {
      const kbId = kbByChunk.get(r.chunkId);
      if (!kbId) continue;
      if (kbAllowed.size > 0 && !kbAllowed.has(kbId)) continue;
      if (enforceAllowed && (allowedByChunk.get(r.chunkId) ?? 0) === 0) {
        // Chunk flagged as not allowed-for-context; drop.
        continue;
      }
      const cls = normaliseClassification(r.classification);
      if (!cls || RANK[cls] > capRank) continue;
      const safeSnippet = truncateUtf8ToBytes(r.snippet, input.maxBytes);
      // Pre-bound the snippet here; the adapter (Tool Host side)
      // will re-bound + re-hash on the way to the caller, so we
      // emit unbounded snippetHash placeholder of '' to keep the
      // port's contract honest — the canonical hash is computed
      // exactly once, downstream.
      hits.push({
        knowledgeBaseId: kbId,
        documentId: r.documentId,
        chunkId: r.chunkId,
        snippet: safeSnippet,
        snippetHash: '',
        classification: cls,
        score: r.score ?? 0,
      });
      if (hits.length >= input.topK) break;
    }
    // `retrieve()` intentionally over-fetches, so it must not receive runId:
    // its legacy audit path would record candidates later rejected by this
    // port's KB/classification scope checks. Persist evidence only for the
    // final, bounded hits that this port returns to the Tool Host.
    if (input.runId && hits.length > 0) {
      this.persistReturnedHitEvidence({
        runId: input.runId,
        workspaceId: input.workspaceId,
        hits,
      });
    }
    // Query digest is supplied by the adapter on the return path
    // (it owns the canonicalisation), so emit empty here.
    return {
      type: KNOWLEDGE_SEARCH_LOGICAL_NAME,
      workspaceId: input.workspaceId,
      knowledgeBaseIds: input.knowledgeBaseIds,
      maxClassification: cap,
      queryDigest: '',
      topK: input.topK,
      totalHits: hits.length,
      hits,
    };
  }

  /**
   * The RAG port is a Core implementation, so it owns persistence while the
   * Tool Host remains database-free. One transaction makes each returned hit
   * visible as both an actual access and a local-context retrieval source.
   */
  private persistReturnedHitEvidence(input: {
    runId: string;
    workspaceId: string;
    hits: readonly KnowledgeSearchHit[];
  }): void {
    const db = this.cfg.databaseService.getRawDB();
    // The database foreign keys prove each id exists, but not that this run
    // belongs to this workspace. Check the Core-owned context before any
    // append so a misplaced run identity cannot create cross-workspace audit
    // evidence.
    const ownedRun = db.prepare(`
      SELECT 1 FROM agent_runs WHERE id = ? AND workspace_id = ?
    `).get(input.runId, input.workspaceId);
    if (!ownedRun) {
      throw new OgraError(OgraErrorCode.WORKSPACE_MISMATCH,
        'knowledge.search: run does not belong to the requested workspace');
    }
    const now = new Date().toISOString();
    const insertAccess = db.prepare(`
      INSERT INTO document_access_events
        (id, run_id, workspace_id, document_id, chunk_id, access_type,
         classification_snapshot, created_at)
      VALUES (?, ?, ?, ?, ?, 'retrieved', ?, ?)
    `);
    const insertSource = db.prepare(`
      INSERT INTO run_context_sources
        (id, run_id, document_id, chunk_id, lifecycle_state, retrieval_method,
         score, classification_snapshot, created_at)
      VALUES (?, ?, ?, ?, 'local_context', 'fts', ?, ?, ?)
    `);
    db.transaction(() => {
      for (const hit of input.hits) {
        insertAccess.run(
          `acc_${crypto.randomUUID()}`,
          input.runId,
          input.workspaceId,
          hit.documentId,
          hit.chunkId,
          hit.classification,
          now,
        );
        insertSource.run(
          `src_${crypto.randomUUID()}`,
          input.runId,
          hit.documentId,
          hit.chunkId,
          hit.score,
          hit.classification,
          now,
        );
      }
    })();
  }
}
