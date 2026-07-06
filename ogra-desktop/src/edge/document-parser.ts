import * as crypto from 'crypto';
import { DataClassification } from '../shared/types';

export interface ParsedDocument {
  id: string;
  workspaceId: string;
  knowledgeBaseId: string;
  filePath: string;
  fileName: string;
  extension: string;
  contentHash: string;
  sizeBytes: number;
  classification: DataClassification;
  classificationSource: string;
  chunks: DocumentChunk[];
}

export interface DocumentChunk {
  id: string;
  documentId: string;
  workspaceId: string;
  content: string;
  contentHash: string;
  sourceStartOffset: number;
  sourceEndOffset: number;
  sourceStartLine: number;
  sourceEndLine: number;
  classificationSnapshot: string;
  parserVersion: string;
  chunkerVersion: string;
  instructionalContentDetected: boolean;
  allowedForContext: boolean;
}

export interface RetrievalResult {
  chunkId: string;
  documentId: string;
  fileName: string;
  snippet: string;
  sourceStartOffset: number;
  sourceEndOffset: number;
  sourceStartLine: number;
  sourceEndLine: number;
  classification: string;
  retrievalMethod: 'fts' | 'vector' | 'hybrid';
  score?: number;
  allowedForLocalContext: boolean;
  allowedForCloudContext: boolean;
  instructionalContentDetected: boolean;
}

export interface CitationOutput {
  file: string;
  snippet: string;
  lineRange: string;
  retrievalMethod: string;
  classification: string;
  contextDestination: 'local' | 'cloud' | 'blocked' | 'not_sent';
  lifecycleState: string;
}

/**
 * Parser and chunker for local files.
 *
 * Supported: .md, .txt, .ts, .js, .py, .go, .rs, .java, .kt,
 *            .c, .cpp, .h, .hpp, .json, .yaml, .yml, .toml, .sql, .sh
 */
export class DocumentParser {
  readonly parserVersion = 'v1.0';
  readonly chunkerVersion = 'v1.0';

  private readonly SUPPORTED_EXTENSIONS = new Set([
    '.md', '.markdown', '.txt',
    '.js', '.jsx', '.ts', '.tsx',
    '.py', '.go', '.rs', '.java', '.kt',
    '.c', '.cpp', '.h', '.hpp',
    '.json', '.yaml', '.yml', '.toml',
    '.sql', '.sh',
  ]);

  isSupported(extension: string): boolean {
    return this.SUPPORTED_EXTENSIONS.has(extension.toLowerCase());
  }

  parse(filePath: string, fileName: string, extension: string, content: string,
         classification: DataClassification, classificationSource: string): ParsedDocument {
    const contentHash = crypto.createHash('sha256').update(content).digest('hex');
    const lines = content.split('\n');
    const chunks = this.chunk(content, lines, this.chunkerVersion);

    const docId = `doc_${crypto.randomBytes(8).toString('hex')}`;
    const wsId = ''; // Will be filled by caller

    return {
      id: docId,
      workspaceId: wsId,
      knowledgeBaseId: '',
      filePath,
      fileName,
      extension,
      contentHash,
      sizeBytes: Buffer.byteLength(content, 'utf-8'),
      classification,
      classificationSource,
      chunks: chunks.map((chunk, i) => ({
        id: `chunk_${docId}_${i}`,
        documentId: docId,
        workspaceId: wsId,
        content: chunk.content,
        contentHash: crypto.createHash('sha256').update(chunk.content).digest('hex'),
        sourceStartOffset: chunk.startOffset,
        sourceEndOffset: chunk.endOffset,
        sourceStartLine: chunk.startLine,
        sourceEndLine: chunk.endLine,
        classificationSnapshot: classification,
        parserVersion: this.parserVersion,
        chunkerVersion: this.chunkerVersion,
        instructionalContentDetected: this.detectInstructionalContent(chunk.content),
        allowedForContext: classification !== DataClassification.Confidential && classification !== DataClassification.Restricted,
      })),
    };
  }

  private chunk(content: string, lines: string[], chunkerVersion: string): Array<{
    content: string;
    startOffset: number;
    endOffset: number;
    startLine: number;
    endLine: number;
  }> {
    const MAX_LINES_PER_CHUNK = 50;
    const MIN_LINES_PER_CHUNK = 10;

    // Pre-scan: identify code block boundaries so we never split inside them
    const inCodeBlock = new Array<boolean>(lines.length).fill(false);
    let insideCodeBlock = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trimStart().startsWith('```')) {
        insideCodeBlock = !insideCodeBlock;
      }
      inCodeBlock[i] = insideCodeBlock;
    }

    const CODE_BREAK_PATTERNS = [
      /^\s*(export\s+)?(async\s+)?function\s+\w+/,
      /^\s*(export\s+)?(abstract\s+)?class\s+\w+/,
      /^\s*(export\s+)?(default\s+)?(async\s+)?(function\s*)?\(?\s*\w/,
      /^\s*(public|private|protected)\s+(static\s+)?(async\s+)?\w+\s*\(/,
      /^\s*\/\/\s*(region|SECTION|TODO|FIXME)/i,
      /^\s*\/\*/,
    ];
    const chunks: Array<{
      content: string;
      startOffset: number;
      endOffset: number;
      startLine: number;
      endLine: number;
    }> = [];

    let currentStartLine = 0;
    let offset = 0;

    while (currentStartLine < lines.length) {
      const remainingLines = lines.length - currentStartLine;
      const chunkSize = Math.min(MAX_LINES_PER_CHUNK, remainingLines);

      // Try to find a good break point
      // Priority: headings > empty lines (for markdown) > code function/class boundaries
      let breakLine = currentStartLine + chunkSize;
      if (chunkSize >= MIN_LINES_PER_CHUNK && remainingLines > chunkSize) {
        for (let i = breakLine - 1; i > currentStartLine + MIN_LINES_PER_CHUNK; i--) {
          // Never split inside a code block (fenced by ```)
          if (inCodeBlock[i]) {
            continue;
          }

          const line = lines[i].trim();

          // Priority 1: Markdown heading boundaries (ATX headings, setext-style ===/---)
          if (/^#{1,6}\s/.test(line) || line.startsWith('---') || line.startsWith('===')) {
            breakLine = i;       // heading starts the next chunk
            break;
          }

          // Priority 2: Empty line as a natural break
          if (line === '') {
            breakLine = i + 1;   // empty line stays with current chunk, next chunk starts after it
            break;
          }

          // Priority 3: Code file break points (function/class/region declarations)
          if (CODE_BREAK_PATTERNS.some(p => p.test(lines[i]))) {
            breakLine = i;       // declaration starts the next chunk
            break;
          }
        }
      }

      const chunkLines = lines.slice(currentStartLine, breakLine);
      const chunkContent = chunkLines.join('\n');
      const startOffset = offset;
      const endOffset = startOffset + chunkContent.length;

      chunks.push({
        content: chunkContent,
        startOffset,
        endOffset,
        startLine: currentStartLine + 1, // 1-indexed
        endLine: breakLine, // 1-indexed
      });

      offset = endOffset + 1; // +1 for the newline
      currentStartLine = breakLine;
    }

    return chunks;
  }

  private detectInstructionalContent(content: string): boolean {
    const suspiciousPatterns = [
      /ignore\s+(all\s+)?previous\s+instructions/i,
      /you\s+are\s+(now|currently)\s+(in|operating)\s+(unrestricted|administrator)/i,
      /from\s+(this\s+)?point\s+(forward|onward),\s+(disregard|ignore)/i,
      /override\s+(all\s+)?(system|safety)/i,
    ];
    return suspiciousPatterns.some(p => p.test(content));
  }
}
