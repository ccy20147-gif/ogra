/**
 * Ogra protocol core semantics for the M0 validator suite (TypeScript).
 *
 * Mirrors tools/validators/python/ogra_protocol.py. The golden vectors are
 * the cross-language contract; both implementations MUST produce identical
 * verdicts. Dependency-free except node:crypto (sha256).
 *
 * Erasable-syntax TypeScript only (no enums/namespaces) so Node's native
 * type stripping can run this file directly.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SPEC_ROOT = path.resolve(__dirname, "../../../spec/v0alpha1");

// ---------------------------------------------------------------------------
// ogra-jcs-1 canonical JSON
// ---------------------------------------------------------------------------

const ESCAPE_RE = /(["\\\x00-\x1f])/g;

/** Cross-language exact-integer range: JS Number is safe only within
 * +/- (2**53 - 1). Values beyond this MUST be decimal strings (P0-3). */
const SAFE_INT_MAX = 9007199254740991; // 2**53 - 1

/** Compare strings as sequences of Unicode code points (ogra-jcs-1 key order). */
function cmpCodePoints(a: string, b: string): number {
  const pa = [...a];
  const pb = [...b];
  const n = Math.min(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = pa[i].codePointAt(0)! - pb[i].codePointAt(0)!;
    if (d !== 0) return d;
  }
  return pa.length - pb.length;
}

function escapeChar(_m: string, ch: string): string {
  if (ch === '"') return '\\"';
  if (ch === "\\") return "\\\\";
  return "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0");
}

function serialize(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `number ${value} outside ogra-jcs-1 safe range (|n| <= ${SAFE_INT_MAX}); represent larger values as decimal strings`
      );
    }
    return String(value);
  }
  if (typeof value === "string") {
    return '"' + value.replace(ESCAPE_RE, escapeChar) + '"';
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const v of value) {
      if (v === null || v === undefined) continue;
      parts.push(serialize(v));
    }
    return "[" + parts.join(",") + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort(cmpCodePoints);
    const parts: string[] = [];
    for (const k of keys) {
      const v = (value as Record<string, unknown>)[k];
      if (v === null || v === undefined) continue;
      parts.push('"' + k.replace(ESCAPE_RE, escapeChar) + '":' + serialize(v));
    }
    return "{" + parts.join(",") + "}";
  }
  throw new Error(`unsupported value in canonical JSON: ${typeof value}`);
}

export function canonicalJson(document: unknown): string {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new Error("canonical document must be a JSON object");
  }
  return serialize(document);
}

export function sha256Hex(document: unknown): string {
  return createHash("sha256").update(canonicalJson(document), "utf8").digest("hex");
}

export function hashRef(document: unknown): string {
  return "sha256:" + sha256Hex(document);
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

const TS_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return DAYS_IN_MONTH[month - 1];
}

export function normalizeTimestamp(value: string): string {
  const m = TS_RE.exec(value);
  if (!m) throw new Error(`invalid timestamp: ${value}`);
  const [, yS, moS, dS, hS, miS, sS, frac] = m;
  const y = parseInt(yS, 10), mo = parseInt(moS, 10), d = parseInt(dS, 10);
  const h = parseInt(hS, 10), mi = parseInt(miS, 10), s = parseInt(sS, 10);
  // Calendar-valid dates only: 2026-02-31 and non-leap 2026-02-29 are invalid.
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo))) {
    throw new Error(`invalid timestamp date: ${value}`);
  }
  if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59 && s >= 0 && s <= 59)) {
    throw new Error(`invalid timestamp time: ${value}`);
  }
  const fracNorm = (frac ?? "").slice(0, 3).padEnd(3, "0");
  const p = (n: number, w: number) => String(n).padStart(w, "0");
  return `${p(y, 4)}-${p(mo, 2)}-${p(d, 2)}T${p(h, 2)}:${p(mi, 2)}:${p(s, 2)}.${fracNorm}Z`;
}

// ---------------------------------------------------------------------------
// Version negotiation (PROT-007, ADR-009)
// ---------------------------------------------------------------------------

export const MAJOR_MISMATCH = "PROTOCOL_MAJOR_MISMATCH";
export const MINOR_MISMATCH = "PROTOCOL_MINOR_MISMATCH";
export const BAD_REQUEST = "BAD_REQUEST";

function parseVersion(v: string): [number, number] {
  const m = /^(\d+)\.(\d+)$/.exec(v);
  if (!m) throw new Error(`invalid protocol version: ${v}`);
  return [parseInt(m[1], 10), parseInt(m[2], 10)];
}

function cmpVersionTuple(a: [number, number], b: [number, number]): number {
  return a[0] - b[0] || a[1] - b[1];
}

export function negotiate(
  client: string,
  server: string,
  clientMinimum?: string
): { ok: boolean; negotiated?: string; code?: string } {
  let cMajor: number, cMinor: number, sMajor: number, sMinor: number;
  try {
    [cMajor, cMinor] = parseVersion(client);
    [sMajor, sMinor] = parseVersion(server);
  } catch {
    return { ok: false, code: BAD_REQUEST };
  }
  if (cMajor !== sMajor) return { ok: false, code: MAJOR_MISMATCH };
  // Numeric comparison: 0.10 > 0.2 (P1-5).
  const negotiated: [number, number] = [cMajor, Math.min(cMinor, sMinor)];
  if (clientMinimum !== undefined) {
    let minT: [number, number];
    try {
      minT = parseVersion(clientMinimum);
    } catch {
      return { ok: false, code: BAD_REQUEST };
    }
    if (minT[0] !== cMajor) return { ok: false, code: MAJOR_MISMATCH };
    if (cmpVersionTuple(negotiated, minT) < 0) return { ok: false, code: MINOR_MISMATCH };
  }
  return { ok: true, negotiated: `${negotiated[0]}.${negotiated[1]}` };
}

// ---------------------------------------------------------------------------
// State machines (PROT-011, PROT-013, PROT-015)
// ---------------------------------------------------------------------------

interface MachineTable {
  states: Set<string>;
  terminal: Set<string>;
  transitions: Record<string, Record<string, string>>;
}

const MACHINE_FILES: Record<string, string> = {
  action: "state-machines/action.json",
  attempt: "state-machines/attempt.json",
  ingress: "state-machines/ingress.json",
  recovery_decision: "state-machines/recovery-decision.json",
};

const MACHINES: Record<string, MachineTable> = {};

function loadMachines(): Record<string, MachineTable> {
  if (Object.keys(MACHINES).length === 0) {
    for (const [name, rel] of Object.entries(MACHINE_FILES)) {
      const data = JSON.parse(
        readFileSync(path.join(SPEC_ROOT, rel), "utf8")
      ) as {
        states: string[];
        terminal: string[];
        transitions: { from: string; event: string; to: string }[];
      };
      const transitions: Record<string, Record<string, string>> = {};
      for (const t of data.transitions) {
        (transitions[t.from] ??= {})[t.event] = t.to;
      }
      MACHINES[name] = {
        states: new Set(data.states),
        terminal: new Set(data.terminal),
        transitions,
      };
    }
  }
  return MACHINES;
}

export function transition(
  machine: string,
  state: string,
  event: string
): { allowed: boolean; to?: string } {
  const m = loadMachines()[machine];
  if (!m.states.has(state)) return { allowed: false };
  const to = m.transitions[state]?.[event];
  if (to === undefined) return { allowed: false };
  return { allowed: true, to };
}

export function isTerminal(machine: string, state: string): boolean {
  return loadMachines()[machine].terminal.has(state);
}

/** Exit-gate predicate: there must be NO transition FROM 'unknown' in the
 * attempt machine (no automatic replay path). */
export function noAutomaticReplayFromUnknown(): boolean {
  return loadMachines().attempt.transitions["unknown"] === undefined;
}

// ---------------------------------------------------------------------------
// Receipt authority semantics (PROT-028, PROT-029)
// ---------------------------------------------------------------------------

const RESOLVING_EFFECT_STATUS = new Set(["completed", "failed"]);
// Only these receipt kinds may carry resolving effect evidence. A transport
// acknowledgement or provider acceptance never resolves an effect; only a
// conformance-backed effect completion or failure may (P0-2, PROT-028).
const RESOLVING_RECEIPT_KINDS = new Set(["effect_completion", "failure"]);

function providerKey(receipt: Record<string, unknown>): string {
  const provider = (receipt["provider"] ?? {}) as Record<string, unknown>;
  return `${String(provider["provider"])}\u0000${String(provider["operation"])}`;
}

export function receiptIsResolvingEvidence(
  receipt: Record<string, unknown>,
  trustedOps?: Set<string>
): boolean {
  // `authority` is NOT self-declared on the wire (P0-2 round 2): the trusted
  // conformance context is REQUIRED. Omitting it fails closed — an
  // authoritative receipt never resolves without a trusted
  // (provider, operation) context. The receipt's own provider fields are
  // client-declared and are NOT authorization evidence. This predicate MUST
  // NOT advance Action state; use receiptCanResolveAction for that decision.
  if (receipt["authority"] !== "authoritative") return false;
  if (!RESOLVING_EFFECT_STATUS.has(String(receipt["effect_status"]))) return false;
  if (!RESOLVING_RECEIPT_KINDS.has(String(receipt["receipt_kind"]))) return false;
  const trusted = trustedOps ?? new Set<string>();
  if (!trusted.has(providerKey(receipt))) return false;
  return true;
}

export function receiptMatchesAttempt(
  receipt: Record<string, unknown>,
  attempt?: Record<string, unknown>
): boolean {
  // M0 persists Action/Attempt IDs, execution profile, and destination. It
  // does not persist provider account or request identity, so those
  // client-declared receipt fields cannot be bound here.
  if (attempt === undefined) return false;
  const provider = (receipt["provider"] ?? {}) as Record<string, unknown>;
  const destination = (attempt["destination"] ?? {}) as Record<string, unknown>;
  return (
    receipt["attempt_id"] === attempt["attempt_id"] &&
    receipt["action_id"] === attempt["action_id"] &&
    receipt["execution_profile"] === attempt["execution_profile"] &&
    provider["provider"] === destination["provider"] &&
    provider["operation"] === destination["operation"]
  );
}

export function receiptCanResolveAction(
  actionState: string,
  receipt: Record<string, unknown>,
  attempt: Record<string, unknown> | undefined,
  trustedOps?: Set<string>
): boolean {
  if (actionState !== "executing" && actionState !== "unknown_outcome") {
    return false;
  }
  return receiptIsResolvingEvidence(receipt, trustedOps) &&
    receiptMatchesAttempt(receipt, attempt);
}

export function defaultReceiptSemantics(receiptKind: string): [string, string] {
  const map: Record<string, [string, string]> = {
    transport_ack: ["advisory", "unknown"],
    provider_acceptance: ["advisory", "unknown"],
    effect_completion: ["authoritative", "completed"],
    failure: ["authoritative", "failed"],
    result: ["authoritative", "completed"],
  };
  return map[receiptKind];
}

// ---------------------------------------------------------------------------
// Payload replay eligibility (PROT-025, PROT-026)
// ---------------------------------------------------------------------------

export const KNOWN_CAPABILITIES = new Set([
  "replay_safe",
  "idempotent",
  "outcome_query",
  "compensatable",
]);

export function payloadReplayEligible(
  payloadRef: Record<string, unknown>,
  now: string
): boolean {
  const mode = payloadRef["storage_mode"];
  const declared = Boolean(payloadRef["replay_eligible"]);
  if (mode === "hash_only") return false;
  if (mode === "encrypted_replayable") {
    if (!declared) return false;
    if (payloadRef["deleted"]) return false;
    const expiresAt = payloadRef["expires_at"] as string | undefined;
    if (expiresAt !== undefined && now !== "" && expiresAt <= now) return false;
    return true;
  }
  if (mode === "external_reference") {
    if (!declared) return false;
    const policy = payloadRef["retrieval_policy"];
    return policy === "immediate" || policy === "delegated";
  }
  return false;
}

// ---------------------------------------------------------------------------
// Submission-key deduplication (PROT-030, PROT-031)
// ---------------------------------------------------------------------------

export function reattachResult(existing: unknown, fresh: unknown): string {
  return sha256Hex(existing) === sha256Hex(fresh) ? "same_identity" : "conflict";
}

// ---------------------------------------------------------------------------
// Capability gating (PROT-018, PROT-021)
// ---------------------------------------------------------------------------

const RETRY_CAPABILITIES = new Set(["replay_safe", "idempotent"]);
const RECONCILE_CAPABILITIES = new Set(["outcome_query"]);

export function checkManifest(manifest: Record<string, unknown>): {
  ok: boolean;
  code?: string;
  enabled: Record<string, string[]>;
} {
  const enabled: Record<string, string[]> = {};
  const operations = (manifest["operations"] ?? []) as {
    operation_id: string;
    recovery: { capabilities: string[]; conformance_refs?: string[] };
  }[];
  const conformance = (manifest["conformance"] ?? []) as {
    conformance_id?: string;
    status: string;
  }[];
  // Conformance trust is OPERATION-SCOPED (PROT-018, PROT-021): an
  // operation's capabilities are enabled only when it references at least one
  // conformance result AND every referenced conformance_id has status
  // 'trusted'. Missing/unknown conformance ids fail closed (P0-1).
  // Duplicate operation_id / conformance_id entries are REJECTED with
  // DUPLICATE_ID, order-independently (P1-2 round 2).
  const statusById = new Map<string, string>();
  const seenConf = new Set<string>();
  for (const c of conformance) {
    const cid = c.conformance_id ?? "";
    if (seenConf.has(cid)) return { ok: false, code: "DUPLICATE_ID", enabled };
    seenConf.add(cid);
    if (c.conformance_id !== undefined) statusById.set(c.conformance_id, c.status);
  }
  const seenOps = new Set<string>();
  for (const op of operations) {
    const opId = op.operation_id;
    if (seenOps.has(opId)) return { ok: false, code: "DUPLICATE_ID", enabled };
    seenOps.add(opId);
    const caps = op.recovery?.capabilities ?? [];
    for (const c of caps) {
      if (!KNOWN_CAPABILITIES.has(c)) {
        return { ok: false, code: "UNKNOWN_CAPABILITY", enabled };
      }
    }
    const refs = op.recovery?.conformance_refs ?? [];
    const allTrusted =
      refs.length > 0 && refs.every((r) => statusById.get(r) === "trusted");
    enabled[opId] = allTrusted ? [...caps].sort() : [];
  }
  return { ok: true, enabled };
}

export function recoveryAllowed(operationCaps: string[], decision: string): boolean {
  const caps = new Set(operationCaps);
  if (decision === "reconcile") {
    for (const c of RECONCILE_CAPABILITIES) if (caps.has(c)) return true;
    return false;
  }
  if (decision === "retry_with_same_key") {
    for (const c of RETRY_CAPABILITIES) if (caps.has(c)) return true;
    return false;
  }
  // Proposing compensation is always allowed; EXECUTING it requires the
  // trusted `compensatable` capability (P1-7).
  if (decision === "compensate") return caps.has("compensatable");
  if (decision === "manual_review" || decision === "stop") return true;
  return false;
}
