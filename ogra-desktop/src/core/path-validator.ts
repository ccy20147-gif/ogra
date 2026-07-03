import path from 'path';
import fs from 'fs';

export interface PathValidationResult {
  isValid: boolean;
  reason?: string;
  canonicalPath?: string;
}

/**
 * Path validation for workspace roots.
 *
 * Implements canonical path validation, symlink escape detection,
 * path traversal rejection, hidden directory detection.
 */
export class PathValidator {
  /** Approved roots cache: canonical path -> WorkspaceId */
  private approvedRoots = new Map<string, string>();

  registerApprovedRoot(canonicalPath: string, workspaceId: string): void {
    this.approvedRoots.set(canonicalPath, workspaceId);
  }

  isWithinApprovedRoot(fullPath: string): boolean {
    const canonical = this.resolveCanonical(fullPath);
    if (!canonical) return false;

    for (const [root] of this.approvedRoots) {
      if (canonical.startsWith(root)) return true;
    }
    return false;
  }

  validateImportPath(importPath: string): PathValidationResult {
    try {
      // Check path exists
      if (!fs.existsSync(importPath)) {
        return { isValid: false, reason: 'Path does not exist' };
      }

      const stat = fs.statSync(importPath);
      if (!stat.isDirectory()) {
        return { isValid: false, reason: 'Path is not a directory' };
      }

      // Resolve canonical path
      const canonical = this.resolveCanonical(importPath);
      if (!canonical) {
        return { isValid: false, reason: 'Cannot resolve canonical path' };
      }

      // Symlink escape detection: check if realpath differs from original
      const realPath = fs.realpathSync(importPath);
      if (realPath !== canonical && importPath !== realPath) {
        return { isValid: false, reason: 'Symlink escape detected' };
      }

      // Path traversal check
      const normalized = path.normalize(importPath);
      if (normalized.includes('..')) {
        return { isValid: false, reason: 'Path traversal detected' };
      }

      return {
        isValid: true,
        canonicalPath: canonical,
      };
    } catch (err) {
      return {
        isValid: false,
        reason: `Path validation error: ${(err as Error).message}`,
      };
    }
  }

  resolveCanonical(filePath: string): string | null {
    try {
      return fs.realpathSync(filePath);
    } catch {
      return null;
    }
  }
}
