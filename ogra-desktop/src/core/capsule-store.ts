/**
 * Sequence 1B Milestone 1 — Sealed Capsule Store.
 *
 * Implements plan 10 §3.2.1 (Sealed Capsule Durability Protocol)
 * using the SQLite-encrypted-BLOB backend. The protocol's
 * filesystem variant requires atomic no-replace rename + directory
 * fsync; the SQLite variant commits capsule + receipt + state +
 * audit event in the same transaction, which is what this module
 * provides.
 *
 * Security model (fail-closed, no production fail-open):
 * - AES-256-GCM authenticated encryption.
 * - 12-byte random nonce per capsule, 16-byte auth tag stored
 *   alongside the ciphertext.
 * - Workspace-scoped: every capsule is bound to a workspace_id
 *   and a per-workspace random `workspace_tag` is used as
 *   additional authenticated data (AAD) so a capsule cannot be
 *   replayed across workspaces.
 * - Key authority: derived from a CapsuleKeyProvider via HKDF.
 *   The master key NEVER enters SQLite or the audit chain.
 *
 * Strict rules enforced here (any violation produces a
 * CAPSULE_INVALID incident, never a synthetic value):
 * - The raw idempotency key, raw payload, and raw provider
 *   response body NEVER enter SQLite plaintext — only the
 *   ciphertext blob + refs/hashes/version are persisted.
 * - Decryption failure, workspace mismatch, hash mismatch,
 *   expiry, missing capsule, format mismatch all fail closed.
 * - Capsule writes are bound to a `run_event_id` so the recovery
 *   audit packet can correlate a capsule with the L1 audit
 *   chain event that committed it.
 *
 * Out of scope (M2 / later): secret broker OS keychain
 * integration, capsule retention / GC, ingress review.
 */

import * as crypto from 'crypto';
import { OgraError, OgraErrorCode } from '../shared/errors';
import { OgraDatabase } from './database';
import { canonicalJSON as canonicalJSONRef } from './audit-envelope';

export type CapsuleKind = 'callback' | 'result';
export type CapsuleFormatVersion = 'v1';
export const CURRENT_CAPSULE_FORMAT_VERSION: CapsuleFormatVersion = 'v1';
export const CAPSULE_NONCE_BYTES = 12;
export const CAPSULE_TAG_BYTES = 16;
export const CAPSULE_KEY_BYTES = 32;

export interface CapsuleBinding {
  workspaceId: string;
  capsuleKind: CapsuleKind;
  formatVersion: CapsuleFormatVersion;
  /** Owner. Exactly one of runId / effectId / receiptId may be set. */
  runId?: string | null;
  effectId?: string | null;
  receiptId?: string | null;
  attemptNo: number;
  adapterKind: string;
  adapterVersion: string;
  payloadFingerprint: string;
  scopeHash: string;
  /** Absolute expiry; recovery refuses to honor expired capsules. */
  expiresAt: string;
  /** L1 audit event id that materialised this capsule. */
  createdEventId: string | null;
}

export interface SealedCapsule {
  ref: string;
  hash: string;
  formatVersion: CapsuleFormatVersion;
}

export interface SealedCapsuleRow extends SealedCapsule {
  id: string;
  workspaceId: string;
  workspaceTag: string;
  capsuleKind: CapsuleKind;
  runId: string | null;
  effectId: string | null;
  receiptId: string | null;
  attemptNo: number;
  adapterKind: string | null;
  adapterVersion: string | null;
  payloadFingerprint: string | null;
  scopeHash: string | null;
  expiresAt: string;
  createdEventId: string | null;
  createdAt: string;
}

export interface OpenCapsule<T = unknown> {
  binding: CapsuleBinding;
  workspaceTag: string;
  payload: T;
  verifiedHash: string;
}

/**
 * Recovery capability evidence is part of the encrypted callback payload.
 * It deliberately contains only the small, security-relevant subset used by
 * the recovery state machine; capability flags passed to recover() are not an
 * authority source.
 */
export interface VerifiedCallbackRecoveryCapabilities {
  adapterKind: string;
  adapterVersion: string;
  supportsIdempotencyKey: boolean;
  supportsOutcomeQuery: boolean;
  supportsCompensation: boolean;
}

interface CapsuleRow {
  id: string;
  workspace_id: string;
  capsule_kind: CapsuleKind;
  format_version: string;
  workspace_tag: string;
  ref: string;
  hash: string;
  run_id: string | null;
  effect_id: string | null;
  receipt_id: string | null;
  attempt_no: number;
  adapter_kind: string | null;
  adapter_version: string | null;
  payload_fingerprint: string | null;
  scope_hash: string | null;
  expires_at: string;
  blob_payload: Buffer;
  created_event_id: string | null;
  created_at: string;
}

/** Master-key source for HKDF derivation. Production MUST use the
 *  OgraSecretBroker (or OS keychain via M2). */
export interface CapsuleKeyProvider {
  getMasterKey(): Buffer;
}

export class OgraSecretBrokerKeyProvider implements CapsuleKeyProvider {
  constructor(private readonly encryptionKey: Buffer) {
    if (!Buffer.isBuffer(encryptionKey) || encryptionKey.length < 16) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        'OgraSecretBrokerKeyProvider requires a Buffer of >= 16 bytes');
    }
  }
  getMasterKey(): Buffer { return this.encryptionKey; }
}

export class StaticMasterKeyProvider implements CapsuleKeyProvider {
  constructor(private readonly masterKey: Buffer) {
    if (!Buffer.isBuffer(masterKey) || masterKey.length < 16) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        'StaticMasterKeyProvider requires a Buffer of >= 16 bytes');
    }
  }
  getMasterKey(): Buffer { return this.masterKey; }
}

const HKDF_INFO = 'ogra/sequence1b/m1/capsule-key/v1';

export class EncryptedCapsuleStore {
  constructor(
    private readonly odb: OgraDatabase,
    private readonly keyProvider: CapsuleKeyProvider,
    /** Optional clock override used by tests to drive deterministic
     *  expiry timestamps. Defaults to real time. */
    private readonly now: () => Date = () => new Date(),
  ) {}

  /* ============================================================
   * Workspace tag provisioning
   * ============================================================ */

  /**
   * Return (or lazily create and persist) the per-workspace AAD
   * tag. The tag is a random 16-byte hex string stored in
   * `workspaces.workspace_tag`. The v19 preflight backfills tags
   * for pre-existing workspaces via SQLite's randomblob so the
   * migration is fully self-contained.
   */
  ensureWorkspaceTag(workspaceId: string): string {
    const existing = this.odb.getDB().prepare(
      `SELECT workspace_tag FROM workspaces WHERE id = ?`,
    ).get(workspaceId) as { workspace_tag: string | null } | undefined;
    if (existing && existing.workspace_tag && existing.workspace_tag.length > 0) {
      return existing.workspace_tag;
    }
    const tag = crypto.randomBytes(16).toString('hex');
    try {
      this.odb.getDB().prepare(
        `UPDATE workspaces SET workspace_tag = ? WHERE id = ?`,
      ).run(tag, workspaceId);
    } catch {
      // Column absent — keep tag in memory only.
    }
    return tag;
  }

  /* ============================================================
   * Workspace-scoped key derivation
   * ============================================================ */

  private deriveCapsuleKey(workspaceId: string, workspaceTag: string): Buffer {
    const master = this.keyProvider.getMasterKey();
    if (!Buffer.isBuffer(master) || master.length < 16) {
      throw new OgraError(OgraErrorCode.SECRET_ACCESS_DENIED,
        'capsule key provider returned an invalid master key');
    }
    // HKDF-SHA-256 with salt = sha256("salt:" + workspaceId)
    const salt = crypto.createHash('sha256')
      .update(`salt:${workspaceId}`).digest();
    return Buffer.from(crypto.hkdfSync('sha256', master, salt, Buffer.from(HKDF_INFO), CAPSULE_KEY_BYTES));
  }

  private buildAad(workspaceId: string, workspaceTag: string, binding: CapsuleBinding): Buffer {
    const ordered = {
      workspace_id: workspaceId,
      workspace_tag: workspaceTag,
      capsule_kind: binding.capsuleKind,
      format_version: binding.formatVersion,
      run_id: binding.runId ?? '',
      effect_id: binding.effectId ?? '',
      receipt_id: binding.receiptId ?? '',
      attempt_no: binding.attemptNo,
      adapter_kind: binding.adapterKind,
      adapter_version: binding.adapterVersion,
      payload_fingerprint: binding.payloadFingerprint,
      scope_hash: binding.scopeHash,
      expires_at: binding.expiresAt,
    };
    return Buffer.from(JSON.stringify(ordered));
  }

  /* ============================================================
   * Seal
   * ============================================================ */

  /**
   * Seal a payload into a fresh capsule. Returns the persisted
   * row's ref + hash + format_version so the caller can store them
   * on the effect / receipt / run_event in the same SQLite
   * transaction.
   */
  seal<T>(binding: CapsuleBinding, payload: T): SealedCapsuleRow {
    if (binding.formatVersion !== CURRENT_CAPSULE_FORMAT_VERSION) {
      throw new OgraError(OgraErrorCode.INVALID_ARGUMENT,
        `unsupported capsule format_version ${binding.formatVersion}`);
    }
    if (new Date(binding.expiresAt).getTime() <= this.now().getTime()) {
      throw new OgraError(OgraErrorCode.CAPSULE_INVALID,
        'capsule expires_at is already in the past');
    }
    const workspaceTag = this.ensureWorkspaceTag(binding.workspaceId);
    const key = this.deriveCapsuleKey(binding.workspaceId, workspaceTag);
    const nonce = crypto.randomBytes(CAPSULE_NONCE_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(this.buildAad(binding.workspaceId, workspaceTag, binding));
    const plaintext = Buffer.from(canonicalJSONRef(payload), 'utf-8');
    const ciphertext = Buffer.concat([
      cipher.update(plaintext) as unknown as Buffer,
      cipher.final() as unknown as Buffer,
    ]);
    const tag = cipher.getAuthTag();
    if (tag.length !== CAPSULE_TAG_BYTES) {
      throw new OgraError(OgraErrorCode.CAPSULE_INVALID,
        'GCM auth tag has unexpected length');
    }
    const blob = Buffer.concat([nonce, ciphertext, tag]);
    const ref = this.computeRef(blob);
    const hash = this.computeHash(plaintext);
    const id = `caps_${crypto.randomBytes(6).toString('hex')}`;
    const createdAt = new Date(this.now().getTime()).toISOString();
    try {
      this.odb.getDB().prepare(`
        INSERT INTO capsules (id, workspace_id, capsule_kind, format_version,
          workspace_tag, ref, hash, run_id, effect_id, receipt_id, attempt_no,
          adapter_kind, adapter_version, payload_fingerprint, scope_hash,
          expires_at, blob_payload, created_event_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, binding.workspaceId, binding.capsuleKind, binding.formatVersion,
        workspaceTag, ref, hash,
        binding.runId ?? null, binding.effectId ?? null,
        binding.receiptId ?? null, binding.attemptNo,
        binding.adapterKind, binding.adapterVersion,
        binding.payloadFingerprint, binding.scopeHash, binding.expiresAt,
        blob, binding.createdEventId, createdAt,
      );
    } catch (err) {
      if (String((err as Error)?.message).includes('UNIQUE')) {
        throw new OgraError(OgraErrorCode.CAPSULE_INVALID,
          `capsule already exists for effect=${binding.effectId} ` +
          `kind=${binding.capsuleKind} attempt=${binding.attemptNo}`);
      }
      throw err;
    }
    return {
      id,
      workspaceId: binding.workspaceId,
      workspaceTag,
      capsuleKind: binding.capsuleKind,
      formatVersion: binding.formatVersion,
      ref, hash,
      runId: binding.runId ?? null,
      effectId: binding.effectId ?? null,
      receiptId: binding.receiptId ?? null,
      attemptNo: binding.attemptNo,
      adapterKind: binding.adapterKind,
      adapterVersion: binding.adapterVersion,
      payloadFingerprint: binding.payloadFingerprint,
      scopeHash: binding.scopeHash,
      expiresAt: binding.expiresAt,
      createdEventId: binding.createdEventId,
      createdAt,
    };
  }

  /* ============================================================
   * Open (decrypt + verify)
   * ============================================================ */

  open<T = unknown>(ref: string): OpenCapsule<T> {
    const row = this.odb.getDB().prepare(
      'SELECT * FROM capsules WHERE ref = ?',
    ).get(ref) as CapsuleRow | undefined;
    if (!row) {
      this.recordFailure({
        capsuleRef: ref, failureKind: 'missing',
        detail: `capsule ${ref} not found`,
      });
      throw new OgraError(OgraErrorCode.CAPSULE_INVALID,
        `capsule ${ref} missing`);
    }
    return this.openRow<T>(row);
  }

  openByEffect<T = unknown>(args: {
    effectId: string;
    capsuleKind: CapsuleKind;
    attemptNo: number;
  }): OpenCapsule<T> {
    const row = this.odb.getDB().prepare(
      `SELECT * FROM capsules WHERE effect_id = ? AND capsule_kind = ? AND attempt_no = ?`,
    ).get(args.effectId, args.capsuleKind, args.attemptNo) as CapsuleRow | undefined;
    if (!row) {
      this.recordFailure({
        effectId: args.effectId, capsuleRef: '', attemptNo: args.attemptNo,
        failureKind: 'missing',
        detail: `no ${args.capsuleKind} capsule for effect ${args.effectId} attempt=${args.attemptNo}`,
      });
      throw new OgraError(OgraErrorCode.CAPSULE_INVALID,
        `${args.capsuleKind} capsule missing for effect ${args.effectId} attempt=${args.attemptNo}`);
    }
    const opened = this.openRow<T>(row);
    return opened;
  }

  /**
   * Same as openByEffect but returns the capsule `ref` (used
   * for incident / audit referencing). Implemented separately
   * because the canonical-by-binding consumer (recovery
   * fingerprint verification) needs the ref to attribute the
   * failure to a specific capsule row.
   */
  openByEffectWithRef<T = unknown>(args: {
    effectId: string;
    capsuleKind: CapsuleKind;
    attemptNo: number;
  }): OpenCapsule<T> & { capsuleRef: string } {
    const row = this.odb.getDB().prepare(
      `SELECT * FROM capsules WHERE effect_id = ? AND capsule_kind = ? AND attempt_no = ?`,
    ).get(args.effectId, args.capsuleKind, args.attemptNo) as CapsuleRow | undefined;
    if (!row) {
      this.recordFailure({
        effectId: args.effectId, capsuleRef: '', attemptNo: args.attemptNo,
        failureKind: 'missing',
        detail: `no ${args.capsuleKind} capsule for effect ${args.effectId} attempt=${args.attemptNo}`,
      });
      throw new OgraError(OgraErrorCode.CAPSULE_INVALID,
        `${args.capsuleKind} capsule missing for effect ${args.effectId} attempt=${args.attemptNo}`);
    }
    return { ...this.openRow<T>(row), capsuleRef: row.ref };
  }

  private openRow<T>(row: CapsuleRow): OpenCapsule<T> {
    // Workspace tag check — capsule must match the workspace's
    // current tag. A re-keyed workspace rejects all older
    // capsules (fail closed).
    const currentTag = this.ensureWorkspaceTag(row.workspace_id);
    if (currentTag !== row.workspace_tag) {
      this.recordFailure({
        effectId: row.effect_id, workspaceId: row.workspace_id,
        capsuleRef: row.ref, attemptNo: row.attempt_no,
        failureKind: 'wrong_workspace',
        detail: `workspace tag drift: stored=${row.workspace_tag} current=${currentTag}`,
      });
      throw new OgraError(OgraErrorCode.CAPSULE_INVALID,
        `capsule ${row.ref}: workspace tag drift — possible cross-workspace replay`);
    }
    if (new Date(row.expires_at).getTime() <= this.now().getTime()) {
      this.recordFailure({
        effectId: row.effect_id, workspaceId: row.workspace_id,
        capsuleRef: row.ref, attemptNo: row.attempt_no,
        failureKind: 'expired',
        detail: `capsule expired at ${row.expires_at}`,
      });
      throw new OgraError(OgraErrorCode.CAPSULE_EXPIRED,
        `capsule ${row.ref} expired at ${row.expires_at}`);
    }
    const blob = row.blob_payload;
    if (!blob || blob.length < CAPSULE_NONCE_BYTES + CAPSULE_TAG_BYTES) {
      this.recordFailure({
        effectId: row.effect_id, workspaceId: row.workspace_id,
        capsuleRef: row.ref, attemptNo: row.attempt_no,
        failureKind: 'corrupt',
        detail: `blob too short: ${blob ? blob.length : 0} bytes`,
      });
      throw new OgraError(OgraErrorCode.CAPSULE_INVALID,
        `capsule ${row.ref} blob too short`);
    }
    const nonce = blob.subarray(0, CAPSULE_NONCE_BYTES);
    const tag = blob.subarray(blob.length - CAPSULE_TAG_BYTES);
    const ciphertext = blob.subarray(CAPSULE_NONCE_BYTES, blob.length - CAPSULE_TAG_BYTES);
    const binding: CapsuleBinding = {
      workspaceId: row.workspace_id,
      capsuleKind: row.capsule_kind,
      formatVersion: row.format_version as CapsuleFormatVersion,
      runId: row.run_id,
      effectId: row.effect_id,
      receiptId: row.receipt_id,
      attemptNo: row.attempt_no,
      adapterKind: row.adapter_kind ?? '',
      adapterVersion: row.adapter_version ?? '',
      payloadFingerprint: row.payload_fingerprint ?? '',
      scopeHash: row.scope_hash ?? '',
      expiresAt: row.expires_at,
      createdEventId: row.created_event_id,
    };
    let plaintext: Buffer;
    try {
      const key = this.deriveCapsuleKey(row.workspace_id, row.workspace_tag);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(this.buildAad(row.workspace_id, row.workspace_tag, binding));
      decipher.setAuthTag(tag);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (err) {
      this.recordFailure({
        effectId: row.effect_id, workspaceId: row.workspace_id,
        capsuleRef: row.ref, attemptNo: row.attempt_no,
        failureKind: 'decrypt_failed',
        detail: `AES-GCM auth failure: ${(err as Error)?.message ?? ''}`,
      });
      throw new OgraError(OgraErrorCode.CAPSULE_INVALID,
        `capsule ${row.ref}: decrypt/auth failed`);
    }
    const verifiedHash = this.computeHash(plaintext);
    if (verifiedHash !== row.hash) {
      this.recordFailure({
        effectId: row.effect_id, workspaceId: row.workspace_id,
        capsuleRef: row.ref, attemptNo: row.attempt_no,
        failureKind: 'hash_mismatch',
        detail: `hash drift: stored=${row.hash} computed=${verifiedHash}`,
      });
      throw new OgraError(OgraErrorCode.CAPSULE_INVALID,
        `capsule ${row.ref}: hash drift`);
    }
    let payload: T;
    try {
      payload = JSON.parse(plaintext.toString('utf-8')) as T;
    } catch {
      this.recordFailure({
        effectId: row.effect_id, workspaceId: row.workspace_id,
        capsuleRef: row.ref, attemptNo: row.attempt_no,
        failureKind: 'corrupt',
        detail: 'JSON parse failure',
      });
      throw new OgraError(OgraErrorCode.CAPSULE_INVALID,
        `capsule ${row.ref}: payload JSON parse failure`);
    }
    return { binding, workspaceTag: row.workspace_tag, payload, verifiedHash };
  }

  /* ============================================================
   * Read-only lookup helpers (no decrypt)
   * ============================================================ */

  fetchByRef(ref: string): SealedCapsuleRow | null {
    const row = this.odb.getDB().prepare(
      'SELECT * FROM capsules WHERE ref = ?',
    ).get(ref) as CapsuleRow | undefined;
    return row ? this.rowToSealedRow(row) : null;
  }

  fetchByBinding(args: {
    effectId: string; capsuleKind: CapsuleKind; attemptNo: number;
  }): SealedCapsuleRow | null {
    const row = this.odb.getDB().prepare(
      'SELECT * FROM capsules WHERE effect_id = ? AND capsule_kind = ? AND attempt_no = ?',
    ).get(args.effectId, args.capsuleKind, args.attemptNo) as CapsuleRow | undefined;
    return row ? this.rowToSealedRow(row) : null;
  }

  /**
   * Open the exact result material named by an authoritative receipt.
   *
   * A receipt hash alone is deliberately not sufficient evidence for a
   * recovered ingress decision.  The capsule row is immutable evidence only
   * when its receipt/effect/attempt ownership, stored reference/hash/version,
   * workspace and AEAD binding all agree with the receipt that selected it.
   */
  openResultForReceipt<T = unknown>(args: {
    workspaceId: string;
    effectId: string;
    receiptId: string;
    attemptNo: number;
    resultCapsuleRef: string | null;
    resultCapsuleHash: string | null;
    resultCapsuleFormatVersion: string | null;
  }): OpenCapsule<T> {
    const fail = (failureKind: 'missing' | 'corrupt' | 'hash_mismatch' | 'format_mismatch', detail: string): never => {
      this.recordFailure({
        workspaceId: args.workspaceId, effectId: args.effectId,
        capsuleRef: args.resultCapsuleRef, attemptNo: args.attemptNo,
        failureKind, detail,
      });
      throw new OgraError(OgraErrorCode.CAPSULE_INVALID, detail);
    };
    if (!args.resultCapsuleRef || !args.resultCapsuleHash || !args.resultCapsuleFormatVersion) {
      return fail('missing', `receipt ${args.receiptId} has no complete result capsule reference`);
    }
    const row = this.odb.getDB().prepare(
      'SELECT * FROM capsules WHERE ref = ?',
    ).get(args.resultCapsuleRef) as CapsuleRow | undefined;
    if (!row) {
      return fail('missing', `result capsule ${args.resultCapsuleRef} is missing for receipt ${args.receiptId}`);
    }
    if (row.workspace_id !== args.workspaceId
        || row.capsule_kind !== 'result'
        || row.effect_id !== args.effectId
        || row.receipt_id !== args.receiptId
        || row.attempt_no !== args.attemptNo) {
      return fail('corrupt', `result capsule ${row.ref} ownership binding does not match receipt ${args.receiptId}`);
    }
    if (row.format_version !== args.resultCapsuleFormatVersion) {
      return fail('format_mismatch', `result capsule ${row.ref} format does not match receipt ${args.receiptId}`);
    }
    if (row.hash !== args.resultCapsuleHash) {
      return fail('hash_mismatch', `result capsule ${row.ref} hash does not match receipt ${args.receiptId}`);
    }
    const opened = this.openRow<T>(row);
    if (opened.verifiedHash !== args.resultCapsuleHash) {
      return fail('hash_mismatch', `result capsule ${row.ref} verified hash does not match receipt ${args.receiptId}`);
    }
    return opened;
  }

  /* ============================================================
   * Failures / incidents
   * ============================================================ */

  recordFailure(input: {
    runId?: string | null;
    effectId?: string | null;
    workspaceId?: string | null;
    capsuleRef?: string | null;
    attemptNo?: number | null;
    failureKind:
      | 'missing' | 'corrupt' | 'expired' | 'wrong_workspace'
      | 'hash_mismatch' | 'decrypt_failed' | 'format_mismatch'
      | 'unsupported_primitives';
    detail: string;
  }): void {
    const id = `capfail_${crypto.randomBytes(6).toString('hex')}`;
    try {
      this.odb.getDB().prepare(`
        INSERT INTO capsule_failures (id, run_id, effect_id, workspace_id,
          capsule_ref, attempt_no, failure_kind, detail)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, input.runId ?? null, input.effectId ?? null,
        input.workspaceId ?? null, input.capsuleRef ?? null,
        input.attemptNo ?? null, input.failureKind, input.detail);
    } catch {
      // Best-effort; failure log itself must never fail closed.
    }
  }

  listFailures(effectId: string): Array<{
    id: string;
    failureKind: string;
    detail: string;
    createdAt: string;
  }> {
    const rows = this.odb.getDB().prepare(`
      SELECT id, failure_kind, detail, created_at FROM capsule_failures
      WHERE effect_id = ? ORDER BY created_at ASC
    `).all(effectId) as Array<{ id: string; failure_kind: string; detail: string; created_at: string }>;
    return rows.map(r => ({
      id: r.id, failureKind: r.failure_kind, detail: r.detail, createdAt: r.created_at,
    }));
  }

  /* ============================================================
   * Helpers
   * ============================================================ */

  private computeRef(blob: Buffer): string {
    return crypto.createHash('sha256').update(blob).digest('hex');
  }

  private computeHash(plaintext: Buffer): string {
    return crypto.createHash('sha256').update(plaintext).digest('hex');
  }

  private rowToSealedRow(row: CapsuleRow): SealedCapsuleRow {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      workspaceTag: row.workspace_tag,
      capsuleKind: row.capsule_kind,
      formatVersion: row.format_version as CapsuleFormatVersion,
      ref: row.ref,
      hash: row.hash,
      runId: row.run_id,
      effectId: row.effect_id,
      receiptId: row.receipt_id,
      attemptNo: row.attempt_no,
      adapterKind: row.adapter_kind,
      adapterVersion: row.adapter_version,
      payloadFingerprint: row.payload_fingerprint,
      scopeHash: row.scope_hash,
      expiresAt: row.expires_at,
      createdEventId: row.created_event_id,
      createdAt: row.created_at,
    };
  }

  /**
   * Sequence 1B Milestone 1 (plan 10 §3.2.1 step 9 + §4 step 4):
   * recovery MUST verify that the canonical hash of the
   * callback capsule's payload matches the effect's
   * `payloadFingerprint`. A drift between the two means a
   * different payload is about to be re-applied than what
   * was originally prepared (or than what the approval row
   * bound to).
   *
   * Returns:
   *   - 'match' when sha256(canonical(payloadBody)) ==
   *     expectedFingerprint
   *   - 'mismatch' with the mismatched digest when they differ
   *   - 'capsule_failure' when the capsule is missing,
   *     corrupted, or cannot be decrypted; in this case the
   *     caller MUST treat the recovery attempt as a fail-closed
   *     incident (the recovery layer forbids a re-callback
   *     that cannot prove it would apply the same payload).
   */
  verifyCallbackAgainstFingerprint(args: {
    effectId: string;
    attemptNo: number;
    expectedFingerprint: string;
  }): {
    outcome: 'match' | 'mismatch' | 'capsule_failure';
    canonicalHash?: string;
    capsuleRef?: string;
    detail?: string;
  } {
    let opened: OpenCapsule<unknown> & { capsuleRef: string };
    try {
      opened = this.openByEffectWithRef<unknown>({
        effectId: args.effectId, capsuleKind: 'callback',
        attemptNo: args.attemptNo,
      });
    } catch (err) {
      return {
        outcome: 'capsule_failure',
        detail: `callback capsule unavailable: ${(err as Error)?.message ?? 'unknown'}`,
      };
    }
    // The row binding is AEAD-authenticated by openRow(), but it is still
    // only a claim about the plaintext.  Re-canonicalize the actual
    // decrypted callback and compare all three authority anchors:
    // actual plaintext, the authenticated AAD/row binding, and the effect
    // fingerprint supplied by the durable ledger.
    const canonicalHash = crypto.createHash('sha256')
      .update(canonicalJSONRef(opened.payload)).digest('hex');
    if (canonicalHash !== opened.binding.payloadFingerprint
        || canonicalHash !== args.expectedFingerprint) {
      this.recordFailure({
        effectId: args.effectId,
        workspaceId: opened.binding.workspaceId,
        capsuleRef: opened.capsuleRef,
        attemptNo: args.attemptNo,
        failureKind: 'hash_mismatch',
        detail: 'callback plaintext canonical hash does not match authenticated binding or effect anchor',
      });
      return {
        outcome: 'mismatch',
        canonicalHash,
        capsuleRef: opened.capsuleRef,
        detail: 'callback plaintext differs from its durable authority anchor',
      };
    }
    return {
      outcome: 'match',
      canonicalHash,
      capsuleRef: opened.capsuleRef,
    };
  }

  /**
   * Return callback input only after proving the decoded plaintext is the
   * exact canonical object bound to both the AEAD row and the effect ledger.
   * Callers must use this value for the physical callback; caller memory is
   * never an authority after prepare.
   */
  openVerifiedCallbackForEffect<T = unknown>(args: {
    effectId: string;
    attemptNo: number;
    expectedFingerprint: string;
  }): OpenCapsule<T> & { capsuleRef: string; canonicalHash: string } {
    const opened = this.openByEffectWithRef<T>({
      effectId: args.effectId, capsuleKind: 'callback', attemptNo: args.attemptNo,
    });
    const canonicalHash = crypto.createHash('sha256')
      .update(canonicalJSONRef(opened.payload)).digest('hex');
    if (canonicalHash !== opened.binding.payloadFingerprint
        || canonicalHash !== args.expectedFingerprint) {
      this.recordFailure({
        effectId: args.effectId, workspaceId: opened.binding.workspaceId,
        capsuleRef: opened.capsuleRef, attemptNo: args.attemptNo,
        failureKind: 'hash_mismatch',
        detail: 'callback plaintext canonical hash does not match authenticated binding or effect anchor',
      });
      throw new OgraError(OgraErrorCode.CAPSULE_INVALID,
        `callback capsule ${opened.capsuleRef} plaintext fingerprint mismatch`);
    }
    return { ...opened, canonicalHash };
  }

  /**
   * Return recovery capabilities only after AEAD-opening the exact callback
   * capsule.  The inner adapter identity must agree with its AAD-bound row
   * and with the durable effect identity, otherwise a caller could relabel a
   * capability declaration after a crash.
   */
  readVerifiedCallbackRecoveryCapabilities(args: {
    effectId: string;
    attemptNo: number;
    expectedAdapterKind: string;
  }): VerifiedCallbackRecoveryCapabilities {
    const opened = this.openByEffectWithRef<{
      recoveryCapabilities?: unknown;
    }>({
      effectId: args.effectId,
      capsuleKind: 'callback',
      attemptNo: args.attemptNo,
    });
    const evidence = opened.payload?.recoveryCapabilities;
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
      throw new OgraError(OgraErrorCode.CAPSULE_INVALID,
        `callback capsule ${args.effectId} has no recovery capability evidence`);
    }
    const candidate = evidence as Record<string, unknown>;
    const bool = (name: string): boolean => {
      if (typeof candidate[name] !== 'boolean') {
        throw new OgraError(OgraErrorCode.CAPSULE_INVALID,
          `callback capsule ${args.effectId} has invalid ${name} capability evidence`);
      }
      return candidate[name] as boolean;
    };
    if (candidate.schemaVersion !== 'v1'
        || typeof candidate.adapterKind !== 'string'
        || typeof candidate.adapterVersion !== 'string'
        || candidate.adapterKind !== opened.binding.adapterKind
        || candidate.adapterVersion !== opened.binding.adapterVersion
        || candidate.adapterKind !== args.expectedAdapterKind) {
      throw new OgraError(OgraErrorCode.CAPSULE_INVALID,
        `callback capsule ${args.effectId} recovery capability identity mismatch`);
    }
    return {
      adapterKind: candidate.adapterKind,
      adapterVersion: candidate.adapterVersion,
      supportsIdempotencyKey: bool('supportsIdempotencyKey'),
      supportsOutcomeQuery: bool('supportsOutcomeQuery'),
      supportsCompensation: bool('supportsCompensation'),
    };
  }
}
