import { RunEventType } from '../shared/types';
import * as crypto from 'crypto';

/**
 * Deterministic prompt-injection detector.
 *
 * Matches simple known patterns in untrusted content.
 * Each pattern is a simple regex/keyword match.
 * Detected patterns are written to run events and incident records.
 *
 * Each detection returns an evidence hash for audit trail integrity.
 */
export class PromptInjectionDetector {
  /** Version identifier — bump when patterns change */
  readonly detectorVersion = 'v1.0.0';

  private patterns: Array<{
    id: string;
    name: string;
    severity: 'low' | 'medium' | 'high';
    patterns: RegExp[];
    description: string;
  }> = [
    {
      id: 'pi_ignore_instructions',
      name: 'Ignore previous instructions',
      severity: 'high',
      patterns: [
        /ignore\s+(all\s+)?previous\s+(instructions|directives|commands)/i,
        /disregard\s+(all\s+)?(prior|previous|above)/i,
        /override\s+(all\s+)?(system|safety|security)\s+(instructions|policies)/i,
      ],
      description: 'Content attempts to override system instructions',
    },
    {
      id: 'pi_file_upload',
      name: 'Suspicious file upload',
      severity: 'high',
      patterns: [
        /upload\s+(this|the)\s+file/i,
        /send\s+(this|the)\s+(file|data|document)\s+to/i,
        /export\s+(all|every)\s+(documents|files|data)/i,
      ],
      description: 'Content requests unauthorized file upload or export',
    },
    {
      id: 'pi_external_tool',
      name: 'External tool invocation',
      severity: 'medium',
      patterns: [
        /call\s+(external|remote)\s+(tool|api|service)/i,
        /execute\s+(shell|command|script|bash|curl|wget)/i,
        /^curl\s+/im,
        /^wget\s+/im,
        /run\s+(curl|wget|nc|ncat|ssh|telnet)/i,
      ],
      description: 'Content attempts to invoke external tools or shell commands',
    },
    {
      id: 'pi_policy_bypass',
      name: 'Policy bypass attempt',
      severity: 'high',
      patterns: [
        /you\s+are\s+(now|currently)\s+(in|operating\s+in)\s+(unrestricted|administrator|root)\s+mode/i,
        /you\s+have\s+been\s+(upgraded|promoted|granted)\s+(to|as)\s+(admin|administrator)/i,
        /from\s+(this\s+)?point\s+(forward|onward),\s+(disregard|ignore)/i,
      ],
      description: 'Content attempts to bypass policy restrictions',
    },
    {
      id: 'pi_sensitive_leak',
      name: 'Suspicious data exfiltration',
      severity: 'high',
      patterns: [
        /steal|exfiltrate|leak\s+(data|information|files)/i,
        /send\s+(password|token|key|secret|credential)/i,
        /curl\s+-[a-z]*F\s+\"file=@/i,
      ],
      description: 'Content requests or describes data exfiltration',
    },
  ];

  /**
   * Scan content for prompt injection patterns.
   * Returns matched patterns with evidence excerpts and cryptographic hashes.
   */
  detect(content: string): Array<{
    patternId: string;
    patternName: string;
    severity: string;
    evidence: string;
    evidenceHash: string;
    description: string;
    detectorVersion: string;
  }> {
    const matches: Array<{
      patternId: string;
      patternName: string;
      severity: string;
      evidence: string;
      evidenceHash: string;
      description: string;
      detectorVersion: string;
    }> = [];

    for (const pattern of this.patterns) {
      for (const regex of pattern.patterns) {
        const match = content.match(regex);
        if (match) {
          const evidence = match[0].substring(0, 100);
          const evidenceHash = crypto
            .createHash('sha256')
            .update(evidence)
            .digest('hex');

          matches.push({
            patternId: pattern.id,
            patternName: pattern.name,
            severity: pattern.severity,
            evidence,
            evidenceHash,
            description: pattern.description,
            detectorVersion: this.detectorVersion,
          });
          break; // One match per pattern group
        }
      }
    }

    return matches;
  }

  /**
   * Get all pattern definitions (for display in UI).
   * Includes version info for audit consistency.
   */
  getPatterns(): Array<{
    id: string;
    name: string;
    severity: string;
    description: string;
  }> {
    return this.patterns.map(p => ({
      id: p.id,
      name: p.name,
      severity: p.severity,
      description: p.description,
    }));
  }
}
