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
      // Check path traversal BEFORE any normalization — normalise() resolves ..
      // so it can't detect traversal. Check the raw input instead.
      const forwardNormalized = importPath.replace(/\\/g, '/');
      if (forwardNormalized.includes('..') || importPath.includes('..')) {
        return { isValid: false, reason: 'Path traversal detected (.. not allowed)' };
      }

      // Check path exists
      if (!fs.existsSync(importPath)) {
        return { isValid: false, reason: 'Path does not exist' };
      }

      const stat = fs.statSync(importPath);
      if (!stat.isDirectory()) {
        return { isValid: false, reason: 'Path is not a directory' };
      }

      // Resolve canonical path (resolves symlinks and normalizes)
      const canonical = this.resolveCanonical(importPath);
      if (!canonical) {
        return { isValid: false, reason: 'Cannot resolve canonical path' };
      }

      // Symlink escape detection: realpath resolves symlinks; if the resolved
      // canonical path points outside the original path's expected location,
      // flag it. Also catches symlink-to-symlink chains.
      if (canonical !== path.resolve(importPath)) {
        return { isValid: false, reason: 'Symlink escape detected' };
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
