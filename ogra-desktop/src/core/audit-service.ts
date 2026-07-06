import crypto from 'crypto';
import { RunEventType } from '../shared/types';
import { DatabaseService } from './database-service';

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

export const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

/**
 * Canonical JSON stringify with recursive sorted keys — shared function so
 * AuditService and DatabaseService produce identical hashes.
 */
export function canonicalJSON(obj: Record<string, unknown>): string {
  return JSON.stringify(obj, (_, val) => {
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(val as Record<string, unknown>).sort()) {
        sorted[k] = (val as Record<string, unknown>)[k];
      }
      return sorted;
    }
    if (Array.isArray(val)) {
      return val.map(item => {
        if (item !== null && typeof item === 'object') {
          const sorted: Record<string, unknown> = {};
          for (const k of Object.keys(item as Record<string, unknown>).sort()) {
            sorted[k] = (item as Record<string, unknown>)[k];
          }
          return sorted;
        }
        return item;
      });
    }
    return val;
  });
}

/**
 * Append-only audit event store with hash-chain verification, backed by SQLite.
 *
 * Each event stores:
 * - sequence: monotonic per run
 * - previous_hash: SHA-256 of prior event in same run, or genesis
 * - event_hash: SHA-256 of canonical(event_payload) + previous_hash
 *
 * Delegates persistence to DatabaseService when available; falls back to
 * in-memory storage for backward compatibility in tests.
 */
export class AuditService {
  /** In-memory fallback used only when no DatabaseService is provided */
  private events: RunEventRecord[] = [];
  private sequences: Map<string, number> = new Map();
  private dbService: DatabaseService | null;

  constructor(dbService?: DatabaseService) {
    this.dbService = dbService ?? null;
  }

  async appendEvent(req: {
    runId: string;
    workspaceId: string;
    eventType: string;
    eventPayload: Record<string, unknown>;
    policyVersionHash?: string;
    redactionRuleVersion?: string;
  }): Promise<RunEventRecord> {
    if (this.dbService) {
      const row = this.dbService.appendRunEvent(
        req.runId,
        req.workspaceId,
        req.eventType,
        req.eventPayload,
        req.policyVersionHash,
        req.redactionRuleVersion,
      );
      return this.rowToRecord(row);
    }

    // In-memory fallback
    const seq = (this.sequences.get(req.runId) ?? 0) + 1;
    this.sequences.set(req.runId, seq);

    const prevEvent = [...this.events].reverse().find(e => e.runId === req.runId);

    const payloadHash = crypto
      .createHash('sha256')
      .update(canonicalJSON(req.eventPayload))
      .digest('hex');

    const previousHash = prevEvent?.eventHash ?? GENESIS_HASH;
    const hashInput = canonicalJSON(req.eventPayload) + previousHash;
    const eventHash = crypto.createHash('sha256').update(hashInput).digest('hex');

    const record: RunEventRecord = {
      id: `evt_${Date.now()}_${seq}`,
      runId: req.runId,
      workspaceId: req.workspaceId,
      sequence: seq,
      eventType: req.eventType,
      eventPayload: { ...req.eventPayload },
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
    if (this.dbService) {
      return this.dbService.getRunEvents(runId, limit, offset).map(r => this.rowToRecord(r));
    }
    return this.events
      .filter(e => e.runId === runId)
      .sort((a, b) => a.sequence - b.sequence)
      .slice(offset, offset + limit);
  }

  async getAllEvents(): Promise<RunEventRecord[]> {
    if (this.dbService) {
      // Fetch all events from DB; we need the full set for verifyAllChains
      const rows = await this.getAllEventsFromDb();
      return rows.map(r => this.rowToRecord(r));
    }
    return [...this.events];
  }

  private async getAllEventsFromDb(): Promise<any[]> {
    if (!this.dbService) return [];
    return this.dbService.getAllRunEvents();
  }

  async exportEvents(format: string): Promise<{ format: string; eventCount: number; exportId: string }> {
    const allEvents = await this.getAllEvents();
    return {
      format,
      eventCount: allEvents.length,
      exportId: `export_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    };
  }

  async verifyChain(runId: string): Promise<{ valid: boolean; brokenAt?: number; errors: string[] }> {
    if (this.dbService) {
      return this.dbService.verifyRunChain(runId);
    }

    const runEvents = this.events
      .filter(e => e.runId === runId)
      .sort((a, b) => a.sequence - b.sequence);

    const errors: string[] = [];

    for (let i = 0; i < runEvents.length; i++) {
      const evt = runEvents[i];

      if (evt.sequence !== i + 1) {
        errors.push(`Event ${evt.id}: expected sequence ${i + 1}, got ${evt.sequence}`);
      }

      const expectedPrevHash = i === 0 ? GENESIS_HASH : runEvents[i - 1].eventHash;
      if (evt.previousHash !== expectedPrevHash) {
        errors.push(`Event ${evt.id}: previous_hash mismatch`);
        return { valid: false, brokenAt: i, errors };
      }

      const hashInput = canonicalJSON(evt.eventPayload) + evt.previousHash;
      const recomputedHash = crypto.createHash('sha256').update(hashInput).digest('hex');
      if (evt.eventHash !== recomputedHash) {
        errors.push(`Event ${evt.id}: event_hash mismatch`);
        return { valid: false, brokenAt: i, errors };
      }
    }

    return { valid: errors.length === 0, errors };
  }

  async verifyAllChains(): Promise<{ valid: boolean; errors: string[] }> {
    const allEvents = await this.getAllEvents();
    const runIds = [...new Set(allEvents.map(e => e.runId))];
    const allErrors: string[] = [];

    for (const runId of runIds) {
      const result = await this.verifyChain(runId);
      if (!result.valid) {
        allErrors.push(...result.errors);
      }
    }

    return { valid: allErrors.length === 0, errors: allErrors };
  }

  /** Convert a DatabaseService RunEventRow to a domain RunEventRecord */
  private rowToRecord(row: any): RunEventRecord {
    return {
      id: row.id,
      runId: row.run_id,
      workspaceId: row.workspace_id,
      sequence: row.sequence,
      eventType: row.event_type,
      eventPayload: JSON.parse(row.event_payload_json || '{}'),
      payloadHash: row.payload_hash ?? undefined,
      previousHash: row.previous_hash,
      eventHash: row.event_hash,
      policyVersionHash: row.policy_version_hash ?? undefined,
      redactionRuleVersion: row.redaction_rule_version ?? undefined,
      createdAt: row.created_at,
    };
  }
}
