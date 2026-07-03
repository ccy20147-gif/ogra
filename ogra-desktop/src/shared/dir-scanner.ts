import * as path from 'path';
import * as fs from 'fs';

/**
 * Shared utility for scanning directories.
 * Used by RagEngine and KnowledgeService to avoid duplicated logic.
 */
export const IGNORED_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', '.next',
  '.cache', '__pycache__', '.venv', 'venv', '.idea',
]);

/**
 * Scan a directory and return supported and skipped file paths.
 * @param rootPath Directory to scan
 * @param isSupported Function to check if a file extension is supported
 */
export function scanDirectory(
  rootPath: string,
  isSupported: (ext: string) => boolean,
): {
  supported: string[];
  skipped: string[];
  skippedReasons: string[];
} {
  const supported: string[] = [];
  const skipped: string[] = [];
  const skippedReasons: string[] = [];

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
        if (isSupported(ext)) {
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
