import { AuditService } from '../core/audit-service';
import { DatabaseService } from '../core/database-service';
import { PathValidator } from '../core/path-validator';
import { OgraCoreConfig } from '../core/index';
import { RagEngine } from './rag-engine';
import { DataClassification, IndexingStatus } from '../shared/types';
import { scanDirectory } from '../shared/dir-scanner';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

/**
 * Knowledge base import and indexing service.
 *
 * Handles folder scanning, file discovery, basic parsing/chunking,
 * and FTS indexing. Runs as a cancellable job.
 */
export type IndexingProgressCallback = (event: {
  knowledgeBaseId: string;
  status: IndexingStatus;
  filesDiscovered: number;
  filesIndexed: number;
  filesSkipped: number;
  chunksIndexed: number;
  warnings: string[];
  errors: string[];
  startedAt: string;
  completedAt?: string;
}) => void;

export class KnowledgeService {
  private indexingJobs: Map<string, {
    status: IndexingStatus;
    progress: {
      filesDiscovered: number;
      filesIndexed: number;
      filesSkipped: number;
      chunksIndexed: number;
      warnings: string[];
      errors: string[];
    };
    startedAt: string;
    completedAt?: string;
  }> = new Map();

  /** Optional callback for sending progress events to the renderer */
  public onProgress: IndexingProgressCallback | null = null;

  private knowledgeBases: Map<string, {
    id: string;
    workspaceId: string;
    name: string;
    rootPath: string;
    classification: DataClassification;
    indexingStatus: IndexingStatus;
  }> = new Map();

  // Supported file extensions
  private readonly SUPPORTED_EXTENSIONS = new Set([
    '.md', '.markdown', '.txt',
    '.js', '.jsx', '.ts', '.tsx',
    '.py', '.go', '.rs', '.java', '.kt',
    '.c', '.cpp', '.h', '.hpp',
    '.json', '.yaml', '.yml', '.toml',
    '.sql', '.sh',
  ]);

  constructor(
    private auditService: AuditService,
    private pathValidator: PathValidator,
    private config: OgraCoreConfig,
    private ragEngine: RagEngine,
    private db: DatabaseService,
  ) {}

  async importFolder(req: {
    workspaceId: string;
    folderPath: string;
    classification: DataClassification;
  }): Promise<{
    knowledgeBaseId: string;
    filesFound: number;
    filesSupported: number;
    filesSkipped: number;
    skippedReasons: string[];
  }> {
    const kbId = `kb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const canonicalPath = this.pathValidator.resolveCanonical(req.folderPath)!;

    // Register approved root
    this.pathValidator.registerApprovedRoot(canonicalPath, req.workspaceId);

    // Scan files
    const { supported, skipped, skippedReasons } = await this.scanFolder(canonicalPath);

    this.knowledgeBases.set(kbId, {
      id: kbId,
      workspaceId: req.workspaceId,
      name: path.basename(canonicalPath),
      rootPath: canonicalPath,
      classification: req.classification,
      indexingStatus: IndexingStatus.Queued,
    });

    // Persist KB record to database
    this.db.createKnowledgeBase({
      id: kbId,
      workspaceId: req.workspaceId,
      name: path.basename(canonicalPath),
      rootPath: canonicalPath,
      classification: req.classification,
    });

    return {
      knowledgeBaseId: kbId,
      filesFound: supported.length + skipped.length,
      filesSupported: supported.length,
      filesSkipped: skipped.length,
      skippedReasons,
    };
  }

  async startIndexing(knowledgeBaseId: string): Promise<void> {
    const kb = this.knowledgeBases.get(knowledgeBaseId);
    if (!kb) throw new Error(`Knowledge base ${knowledgeBaseId} not found`);

    const now = new Date().toISOString();
    this.indexingJobs.set(knowledgeBaseId, {
      status: IndexingStatus.Running,
      progress: {
        filesDiscovered: 0,
        filesIndexed: 0,
        filesSkipped: 0,
        chunksIndexed: 0,
        warnings: [],
        errors: [],
      },
      startedAt: now,
    });

    // Run indexing asynchronously to avoid blocking main process
    await this.runIndexingJob(knowledgeBaseId, kb.rootPath);
  }

  private async runIndexingJob(knowledgeBaseId: string, rootPath: string): Promise<void> {
    try {
      const kb = this.knowledgeBases.get(knowledgeBaseId);
      if (!kb) {
        throw new Error(`Knowledge base ${knowledgeBaseId} not found`);
      }

      // Get workspaceId and classification from the stored KB record
      const workspaceId = kb.workspaceId;
      const classification = kb.classification;

      // Update initial status
      const job = this.indexingJobs.get(knowledgeBaseId);
      if (!job || job.status === IndexingStatus.Cancelled) return;
      this.db.updateKnowledgeBaseIndexStatus(knowledgeBaseId, 'running');

      // Emit initial progress
      this.emitProgress(knowledgeBaseId, job);

      // Perform actual indexing via RagEngine
      const result = await this.ragEngine.indexFolder(
        workspaceId,
        knowledgeBaseId,
        rootPath,
        classification,
      );

      const finalJob = this.indexingJobs.get(knowledgeBaseId);
      if (finalJob && finalJob.status !== IndexingStatus.Cancelled) {
        finalJob.status = IndexingStatus.Succeeded;
        finalJob.completedAt = new Date().toISOString();
        finalJob.progress.filesDiscovered = result.filesFound;
        finalJob.progress.filesIndexed = result.filesIndexed;
        finalJob.progress.filesSkipped = result.filesSkipped;
        finalJob.progress.chunksIndexed = result.chunksIndexed;

        // Update database with success status
        this.db.updateKnowledgeBaseIndexStatus(knowledgeBaseId, 'succeeded');

        // Emit final progress
        this.emitProgress(knowledgeBaseId, finalJob);
      }
    } catch (err) {
      const job = this.indexingJobs.get(knowledgeBaseId);
      if (job) {
        job.status = IndexingStatus.Failed;
        job.progress.errors.push((err as Error).message);
        job.completedAt = new Date().toISOString();
        this.emitProgress(knowledgeBaseId, job);
      }
      // Update database with failed status
      this.db.updateKnowledgeBaseIndexStatus(knowledgeBaseId, 'failed');
    }
  }

  async getIndexingStatus(knowledgeBaseId: string): Promise<{
    status: IndexingStatus;
    progress: any;
    startedAt?: string;
    completedAt?: string;
  } | null> {
    const job = this.indexingJobs.get(knowledgeBaseId);
    const kb = this.knowledgeBases.get(knowledgeBaseId);

    if (!job && kb) {
      return {
        status: kb.indexingStatus,
        progress: { filesDiscovered: 0, filesIndexed: 0, filesSkipped: 0, chunksIndexed: 0, warnings: [], errors: [] },
      };
    }

    if (!job) return null;

    return {
      status: job.status,
      progress: job.progress,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
    };
  }

  async cancelIndexing(knowledgeBaseId: string): Promise<void> {
    const job = this.indexingJobs.get(knowledgeBaseId);
    if (job && job.status === IndexingStatus.Running) {
      job.status = IndexingStatus.Cancelled;
      job.completedAt = new Date().toISOString();
    }
  }

  async listBases(workspaceId: string): Promise<any[]> {
    return Array.from(this.knowledgeBases.values())
      .filter(kb => kb.workspaceId === workspaceId);
  }

  private async scanFolder(rootPath: string): Promise<{
    supported: string[];
    skipped: string[];
    skippedReasons: string[];
  }> {
    return scanDirectory(rootPath, (ext) => this.SUPPORTED_EXTENSIONS.has(ext));
  }

  /** Emit progress event via callback if registered */
  private emitProgress(knowledgeBaseId: string, job: { status: IndexingStatus; progress: any; startedAt: string; completedAt?: string }): void {
    if (this.onProgress) {
      this.onProgress({
        knowledgeBaseId,
        status: job.status,
        filesDiscovered: job.progress.filesDiscovered,
        filesIndexed: job.progress.filesIndexed,
        filesSkipped: job.progress.filesSkipped,
        chunksIndexed: job.progress.chunksIndexed,
        warnings: job.progress.warnings,
        errors: job.progress.errors,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
      });
    }
  }
}
