import { DatabaseService } from '../core/database-service';
import { DocumentParser, RetrievalResult, CitationOutput, ParsedDocument } from './document-parser';
import { DataClassification } from '../shared/types';
import * as path from 'path';
import * as fs from 'fs';

/**
 * RAG Engine for Ogra Desktop.
 *
 * Handles:
 * - File discovery and parsing
 * - Indexing to SQLite FTS5
 * - Policy-filtered retrieval
 * - Context assembly with citations
 * - Run context source recording
 */
export class RagEngine {
  private parser: DocumentParser;

  constructor(private db: DatabaseService) {
    this.parser = new DocumentParser();
  }

  getParser(): DocumentParser {
    return this.parser;
  }

  /**
   * Scan a folder, parse supported files, and index into SQLite.
   */
  async indexFolder(
    workspaceId: string,
    knowledgeBaseId: string,
    rootPath: string,
    classification: DataClassification,
  ): Promise<{
    filesFound: number;
    filesIndexed: number;
    filesSkipped: number;
    chunksIndexed: number;
    skippedReasons: string[];
  }> {
    const { supported, skipped, skippedReasons } = this.scanFolder(rootPath);
    let filesIndexed = 0;
    let chunksIndexed = 0;

    const insertDoc = this.db.getRawDB().prepare(`
      INSERT INTO documents (id, workspace_id, knowledge_base_id, file_path, file_name,
        extension, content_hash, size_bytes, classification, classification_source, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    const insertChunk = this.db.getRawDB().prepare(`
      INSERT INTO document_chunks (id, document_id, workspace_id, content, content_hash,
        source_start_offset, source_end_offset, classification_snapshot,
        parser_version, chunker_version, allowed_for_context)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertFts = this.db.getRawDB().prepare(`
      INSERT INTO document_chunks_fts (content, chunk_id, workspace_id)
      VALUES (?, ?, ?)
    `);

    const transaction = this.db.getRawDB().transaction(() => {
      for (const filePath of supported) {
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const ext = path.extname(filePath).toLowerCase();
          const fileName = path.basename(filePath);

          if (!this.parser.isSupported(ext)) {
            skipped.push(filePath);
            skippedReasons.push(`Unsupported extension: ${ext}`);
            continue;
          }

          const parsed = this.parser.parse(
            filePath, fileName, ext, content,
            classification, 'folder_import',
          );

          parsed.workspaceId = workspaceId;
          parsed.knowledgeBaseId = knowledgeBaseId;

          // Insert document
          insertDoc.run(
            parsed.id, workspaceId, knowledgeBaseId, filePath, fileName, ext,
            parsed.contentHash, parsed.sizeBytes, classification, 'folder_import',
          );

          // Insert chunks
          for (const chunk of parsed.chunks) {
            chunk.workspaceId = workspaceId;
            insertChunk.run(
              chunk.id, parsed.id, workspaceId, chunk.content, chunk.contentHash,
              chunk.sourceStartOffset, chunk.sourceEndOffset, chunk.classificationSnapshot,
              chunk.parserVersion, chunk.chunkerVersion, chunk.allowedForContext ? 1 : 0,
            );

            // Insert into FTS5
            insertFts.run(chunk.content, chunk.id, workspaceId);
            chunksIndexed++;
          }

          filesIndexed++;
        } catch (err) {
          skipped.push(filePath);
          skippedReasons.push(`Parse error: ${(err as Error).message}`);
        }
      }
    });

    transaction();

    return {
      filesFound: supported.length + skipped.length,
      filesIndexed,
      filesSkipped: skipped.length,
      chunksIndexed,
      skippedReasons,
    };
  }

  /**
   * Retrieve relevant chunks via FTS5 with policy filtering.
   */
  retrieve(
    query: string,
    workspaceId: string,
    maxResults = 10,
    classification?: DataClassification,
  ): RetrievalResult[] {
    // Escape FTS5 special characters
    const sanitized = query.replace(/['"*()^$~\[\]{}|\\]/g, ' ').trim();
    if (!sanitized) return [];

    const ftsQuery = sanitized.split(/\s+/).map(w => `"${w}"`).join(' OR ');

    try {
      const results = this.db.getRawDB().prepare(`
        SELECT
          dc.id as chunk_id,
          dc.document_id,
          d.file_name,
          substr(dc.content, 1, 200) as snippet,
          dc.source_start_offset,
          dc.source_end_offset,
          dc.classification_snapshot,
          dc.allowed_for_context,
          rank
        FROM document_chunks_fts
        JOIN document_chunks dc ON document_chunks_fts.chunk_id = dc.id
        JOIN documents d ON dc.document_id = d.id
        WHERE document_chunks_fts MATCH ?
          AND document_chunks_fts.workspace_id = ?
          AND dc.allowed_for_context = 1
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, workspaceId, maxResults) as any[];

      return results.map(r => ({
        chunkId: r.chunk_id,
        documentId: r.document_id,
        fileName: r.file_name,
        snippet: r.snippet,
        sourceStartOffset: r.source_start_offset,
        sourceEndOffset: r.source_end_offset,
        sourceStartLine: 0, // Would need line mapping
        sourceEndLine: 0,
        classification: r.classification_snapshot,
        retrievalMethod: 'fts' as const,
        score: r.rank,
        allowedForLocalContext: true,
        allowedForCloudContext: classification
          ? classification === DataClassification.Public
          : false,
        instructionalContentDetected: false, // Would need chunk lookup
      }));
    } catch {
      // FTS5 can throw on malformed queries
      return [];
    }
  }

  /**
   * Assemble retrieval results into citation outputs.
   */
  assembleCitations(results: RetrievalResult[]): CitationOutput[] {
    return results.map(r => ({
      file: r.fileName,
      snippet: r.snippet,
      lineRange: r.sourceStartLine > 0
        ? `${r.sourceStartLine}-${r.sourceEndLine}`
        : `${r.sourceStartOffset}-${r.sourceEndOffset}`,
      retrievalMethod: r.retrievalMethod,
      classification: r.classification,
      contextDestination: r.allowedForCloudContext
        ? 'cloud'
        : r.allowedForLocalContext
          ? 'local'
          : 'blocked',
      lifecycleState: r.allowedForCloudContext
        ? 'cloud_context'
        : r.allowedForLocalContext
          ? 'local_context'
          : 'blocked',
    }));
  }

  /**
   * Scan a directory for supported files.
   */
  scanFolder(rootPath: string): {
    supported: string[];
    skipped: string[];
    skippedReasons: string[];
  } {
    const supported: string[] = [];
    const skipped: string[] = [];
    const skippedReasons: string[] = [];

    const IGNORED_DIRS = new Set([
      '.git', 'node_modules', 'dist', 'build', '.next',
      '.cache', '__pycache__', '.venv', 'venv', '.idea',
    ]);

    const walkDir = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        skipped.push(dir);
        skippedReasons.push(`Cannot read directory: ${dir}`);
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
            walkDir(fullPath);
          } else {
            skipped.push(fullPath);
            skippedReasons.push(`Ignored directory: ${entry.name}`);
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (this.parser.isSupported(ext)) {
            supported.push(fullPath);
          } else {
            skipped.push(fullPath);
            skippedReasons.push(`Unsupported file type: ${ext}`);
          }
        }
      }
    };

    walkDir(rootPath);
    return { supported, skipped, skippedReasons };
  }
}
