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
      // Resolve the full path first to detect traversal via normalization
      const resolved = path.resolve(importPath);
      const forwardNormalized = importPath.replace(/\\/g, '/');

      // Path traversal detection: count how many levels .. goes up vs
      // how many levels exist before the first .. segment.
      // If .. goes up more levels than available, it escapes the intended tree.
      // This catches `../../etc/passwd` without rejecting legitimate `some..project`.
      if (forwardNormalized.includes('/../') || forwardNormalized.startsWith('../')) {
        const segments = forwardNormalized.split('/').filter(s => s !== '' && s !== '.');
        const dotDotCount = segments.filter(s => s === '..').length;
        const firstDotDot = segments.indexOf('..');
        const depthBeforeTraversal = firstDotDot >= 0 ? firstDotDot : segments.length;
        if (dotDotCount > depthBeforeTraversal) {
          return { isValid: false, reason: 'Path traversal detected' };
        }
      }

      // Check path exists
      if (!fs.existsSync(importPath)) {
        return { isValid: false, reason: 'Path does not exist' };
      }

      const stat = fs.statSync(importPath);
      if (!stat.isDirectory()) {
        return { isValid: false, reason: 'Path is not a directory' };
      }

      // Reject hidden directories (starting with .)
      const basename = path.basename(resolved);
      if (basename.startsWith('.')) {
        return { isValid: false, reason: 'Hidden directories are not allowed for import' };
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
