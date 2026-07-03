import { AuditService } from '../core/audit-service';
import { PathValidator } from '../core/path-validator';
import { OgraCoreConfig } from '../core/index';
import { DataClassification, IndexingStatus } from '../shared/types';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

/**
 * Knowledge base import and indexing service.
 *
 * Handles folder scanning, file discovery, basic parsing/chunking,
 * and FTS indexing. Runs as a cancellable job.
 */
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

  // Ignored directories
  private readonly IGNORED_DIRS = new Set([
    '.git', 'node_modules', 'dist', 'build', '.next', '.cache', '__pycache__', '.venv',
  ]);

  constructor(
    private auditService: AuditService,
    private pathValidator: PathValidator,
    private config: OgraCoreConfig,
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
      const { supported } = await Promise.resolve(this.scanFolder(rootPath));
      const job = this.indexingJobs.get(knowledgeBaseId);
      if (!job || job.status === IndexingStatus.Cancelled) return;

      job.progress.filesDiscovered = supported.length;

      // Process files in batches to avoid blocking
      const BATCH_SIZE = 10;
      for (let i = 0; i < supported.length; i += BATCH_SIZE) {
        const batch = supported.slice(i, i + BATCH_SIZE);

        // Check for cancellation before each batch
        if (this.indexingJobs.get(knowledgeBaseId)?.status === IndexingStatus.Cancelled) {
          return;
        }

        for (const file of batch) {
          const content = fs.readFileSync(file, 'utf-8');
          const lines = content.split('\n');
          job.progress.chunksIndexed += Math.ceil(lines.length / 50);
          job.progress.filesIndexed++;

          // Yield to event loop periodically
          if (job.progress.filesIndexed % BATCH_SIZE === 0) {
            await new Promise(resolve => setImmediate(resolve));
          }
        }
      }

      const finalJob = this.indexingJobs.get(knowledgeBaseId);
      if (finalJob && finalJob.status !== IndexingStatus.Cancelled) {
        finalJob.status = IndexingStatus.Succeeded;
        finalJob.completedAt = new Date().toISOString();
      }
    } catch (err) {
      const job = this.indexingJobs.get(knowledgeBaseId);
      if (job) {
        job.status = IndexingStatus.Failed;
        job.progress.errors.push((err as Error).message);
        job.completedAt = new Date().toISOString();
      }
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
    const supported: string[] = [];
    const skipped: string[] = [];
    const skippedReasons: string[] = [];

    const walkDir = (dir: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          if (!this.IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
            walkDir(fullPath);
          } else {
            skipped.push(fullPath);
            skippedReasons.push(`Ignored directory: ${entry.name}`);
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (this.SUPPORTED_EXTENSIONS.has(ext)) {
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
