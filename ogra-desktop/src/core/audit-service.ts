import crypto from 'crypto';
import { RunEventType } from '../shared/types';

export interface RunEventRecord {
  id: string;
  runId: string;
  workspaceId: string;
  sequence: number;
  eventType: string;
  eventPayload: Record<string, unknown>;
  payloadHash?: string;
  previousHash: string;
  eventHash: string;
  policyVersionHash?: string;
  redactionRuleVersion?: string;
  createdAt: string;
}

const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

/**
 * Append-only audit event store with hash-chain verification.
 *
 * Each event stores:
 * - sequence: monotonic per run
 * - previous_hash: SHA-256 of prior event in same run, or genesis
 * - event_hash: SHA-256 of canonical(event_payload) + previous_hash
 *
 * Alpha uses in-memory storage. Plan 02 will migrate to SQLite.
 */
export class AuditService {
  private events: RunEventRecord[] = [];
  private sequences: Map<string, number> = new Map();

  async appendEvent(req: {
    runId: string;
    workspaceId: string;
    eventType: string;
    eventPayload: Record<string, unknown>;
    policyVersionHash?: string;
    redactionRuleVersion?: string;
  }): Promise<RunEventRecord> {
    const seq = (this.sequences.get(req.runId) ?? 0) + 1;
    this.sequences.set(req.runId, seq);

    // Find previous event in same run
    const prevEvent = [...this.events].reverse().find(e => e.runId === req.runId);

    const payloadHash = crypto
      .createHash('sha256')
      .update(this.canonicalJSON(req.eventPayload))
      .digest('hex');

    const eventPayload: Record<string, unknown> = { ...req.eventPayload };
    if (req.eventType !== RunEventType.RouteDecision) {
      // Avoid storing full payloads for non-essential events
    }

    const previousHash = prevEvent?.eventHash ?? GENESIS_HASH;
    const hashInput = this.canonicalJSON(eventPayload) + previousHash;
    const eventHash = crypto.createHash('sha256').update(hashInput).digest('hex');

    const record: RunEventRecord = {
      id: `evt_${Date.now()}_${seq}`,
      runId: req.runId,
      workspaceId: req.workspaceId,
      sequence: seq,
      eventType: req.eventType,
      eventPayload,
      payloadHash,
      previousHash,
      eventHash,
      policyVersionHash: req.policyVersionHash,
      redactionRuleVersion: req.redactionRuleVersion,
      createdAt: new Date().toISOString(),
    };

    this.events.push(record);
    return record;
  }

  async getEvents(runId: string, limit = 100, offset = 0): Promise<RunEventRecord[]> {
    const runEvents = this.events
      .filter(e => e.runId === runId)
      .sort((a, b) => a.sequence - b.sequence);
    return runEvents.slice(offset, offset + limit);
  }

  async getAllEvents(): Promise<RunEventRecord[]> {
    return [...this.events];
  }

  async verifyChain(runId: string): Promise<{ valid: boolean; brokenAt?: number; errors: string[] }> {
    const runEvents = this.events
      .filter(e => e.runId === runId)
      .sort((a, b) => a.sequence - b.sequence);

    const errors: string[] = [];

    for (let i = 0; i < runEvents.length; i++) {
      const evt = runEvents[i];

      // Check sequence
      if (evt.sequence !== i + 1) {
        errors.push(`Event ${evt.id}: expected sequence ${i + 1}, got ${evt.sequence}`);
      }

      // Check previous_hash
      const expectedPrevHash = i === 0 ? GENESIS_HASH : runEvents[i - 1].eventHash;
      if (evt.previousHash !== expectedPrevHash) {
        errors.push(`Event ${evt.id}: previous_hash mismatch`);
        return { valid: false, brokenAt: i, errors };
      }

      // Recompute event_hash
      const hashInput = this.canonicalJSON(evt.eventPayload) + evt.previousHash;
      const recomputedHash = crypto.createHash('sha256').update(hashInput).digest('hex');
      if (evt.eventHash !== recomputedHash) {
        errors.push(`Event ${evt.id}: event_hash mismatch`);
        return { valid: false, brokenAt: i, errors };
      }
    }

    return { valid: errors.length === 0, errors };
  }

  async verifyAllChains(): Promise<{ valid: boolean; errors: string[] }> {
    const runIds = [...new Set(this.events.map(e => e.runId))];
    const allErrors: string[] = [];

    for (const runId of runIds) {
      const result = await this.verifyChain(runId);
      if (!result.valid) {
        allErrors.push(...result.errors);
      }
    }

    return { valid: allErrors.length === 0, errors: allErrors };
  }

  private canonicalJSON(obj: Record<string, unknown>): string {
    return JSON.stringify(obj, Object.keys(obj).sort());
  }
}
