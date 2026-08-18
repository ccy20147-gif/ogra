/**
 * Run the M0 golden vectors with the TypeScript validator.
 *
 * Emits one 'PASS <id>' / 'FAIL <id>: <detail>' line per vector and a final
 * 'SUMMARY vectors=N passed=M failed=K' line (identical format to the Python
 * runner). Exit code is 0 iff failed == 0.
 *
 * Run with Node >= 23 (native type stripping): node run_vectors.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import * as proto from "./core.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPEC = path.resolve(__dirname, "../../../spec/v0alpha1");
const SCHEMAS_DIR = path.join(SPEC, "schemas");
const VECTORS_DIR = path.join(SPEC, "vectors");

const SCHEMA_FILES = [
  "run-ref", "action-intent", "action-snapshot", "action-attempt",
  "policy-decision", "route-decision", "redaction-record",
  "approval-binding", "dispatch-grant", "external-receipt", "payload-ref",
  "ingress-finding", "recovery-decision", "capability-manifest",
  "audit-event", "error-envelope", "client-hello", "server-hello",
];

function loadSchemas(): Record<string, unknown> {
  const schemas: Record<string, unknown> = {};
  for (const name of ["_defs", ...SCHEMA_FILES]) {
    schemas[name] = JSON.parse(
      readFileSync(path.join(SCHEMAS_DIR, `${name}.schema.json`), "utf8")
    );
  }
  return schemas;
}

function buildAjv(schemas: Record<string, unknown>): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
  for (const s of Object.values(schemas)) {
    ajv.addSchema(s);
  }
  return ajv;
}

function validateDocument(
  ajv: Ajv2020,
  schemas: Record<string, unknown>,
  schemaName: string,
  document: unknown
): { valid: boolean; messages: string[] } {
  const schema = schemas[schemaName] as { $id: string };
  const validate = ajv.getSchema(schema.$id);
  if (!validate) throw new Error(`schema not registered: ${schemaName}`);
  const ok = validate(document);
  // Cross-language stable error identity: "<path>:<keyword>" (mirrors the
  // Python runner). error_hint assertions match this form.
  const messages = ok
    ? []
    : (validate.errors ?? []).map((e) => {
        let detail = `${(e.instancePath ?? "").replace(/^\//, "")}:${e.keyword ?? ""}`;
        if (e.keyword === "required") {
          const mp = (e.params as { missingProperty?: string })?.missingProperty;
          if (mp !== undefined) detail += `#missing=${mp}`;
        }
        return detail;
      });
  return { valid: ok, messages };
}

interface Expect {
  valid?: boolean;
  error_hint?: string;
  allowed?: boolean;
  to?: string;
  canonical?: string;
  hash?: string;
  normalized?: string;
  error?: boolean;
  ok?: boolean;
  negotiated?: string;
  code?: string;
  enabled?: Record<string, string[]>;
  recovery_allowed?: Record<string, boolean>;
  resolves?: boolean;
  can_resolve_action?: boolean;
  result?: string;
  replay_eligible?: boolean;
}

interface Vector {
  id?: string;
  kind?: string;
  schema?: string;
  document?: unknown;
  machine?: string;
  state?: string;
  event?: string;
  client?: string;
  server?: string;
  client_minimum?: string;
  manifest?: Record<string, unknown>;
  operation?: string;
  receipt?: Record<string, unknown>;
  action_state?: string;
  trusted_ops?: [string, string][];
  attempt?: Record<string, unknown>;
  existing?: unknown;
  new?: unknown;
  payload_ref?: Record<string, unknown>;
  now?: string;
  input?: string;
  expect?: Expect;
}

function runVector(
  ajv: Ajv2020,
  schemas: Record<string, unknown>,
  vec: Vector
): { ok: boolean; detail: string } {
  const kind = vec.kind;
  const expect = vec.expect ?? {};
  try {
    if (kind === "schema_validation") {
      const { valid, messages } = validateDocument(
        ajv, schemas, vec.schema!, vec.document
      );
      if (valid !== expect.valid) {
        return { ok: false, detail: `expected valid=${expect.valid}, got ${valid}` };
      }
      const hint = expect.error_hint;
      if (hint !== undefined && valid) {
        return { ok: false, detail: "expected validation failure but document is valid" };
      }
      if (hint !== undefined && !messages.some((m) => m.includes(hint))) {
        return { ok: false, detail: `expected error hint ${JSON.stringify(hint)}, errors: ${messages.slice(0, 3).join(" | ")}` };
      }
      return { ok: true, detail: "" };
    }
    if (kind === "state_transition") {
      const t = proto.transition(vec.machine!, vec.state!, vec.event!);
      if (t.allowed !== expect.allowed) {
        return { ok: false, detail: `expected allowed=${expect.allowed}, got ${t.allowed}` };
      }
      if (t.allowed && expect.to !== undefined && t.to !== expect.to) {
        return { ok: false, detail: `expected to=${expect.to}, got ${t.to}` };
      }
      return { ok: true, detail: "" };
    }
    if (kind === "canonical_hash") {
      let gotCanonical: string | undefined;
      let gotHash: string | undefined;
      let error = false;
      try {
        gotCanonical = proto.canonicalJson(vec.document);
        gotHash = proto.hashRef(vec.document);
      } catch {
        error = true;
      }
      if (error !== Boolean(expect.error)) {
        return { ok: false, detail: `expected error=${Boolean(expect.error)}, got error=${error}` };
      }
      if (!error) {
        if (gotCanonical !== expect.canonical) return { ok: false, detail: "canonical mismatch" };
        if (gotHash !== expect.hash) return { ok: false, detail: `hash mismatch: ${gotHash}` };
      }
      return { ok: true, detail: "" };
    }
    if (kind === "timestamp_normalization") {
      let got: string | undefined;
      let error = false;
      try {
        got = proto.normalizeTimestamp(vec.input!);
      } catch {
        error = true;
      }
      if (error !== Boolean(expect.error)) {
        return { ok: false, detail: `expected error=${Boolean(expect.error)}, got error=${error}` };
      }
      if (!error && got !== expect.normalized) {
        return { ok: false, detail: `expected normalized=${expect.normalized}, got ${got}` };
      }
      return { ok: true, detail: "" };
    }
    if (kind === "negotiation") {
      const r = proto.negotiate(vec.client!, vec.server!, vec.client_minimum);
      if (r.ok !== expect.ok) return { ok: false, detail: `expected ok=${expect.ok}, got ${r.ok}` };
      if (r.ok && r.negotiated !== expect.negotiated) {
        return { ok: false, detail: `expected negotiated=${expect.negotiated}, got ${r.negotiated}` };
      }
      if (!r.ok && r.code !== expect.code) {
        return { ok: false, detail: `expected code=${expect.code}, got ${r.code}` };
      }
      return { ok: true, detail: "" };
    }
    if (kind === "unknown_capability") {
      const r = proto.checkManifest(vec.manifest!);
      if (r.ok !== expect.ok) return { ok: false, detail: `expected ok=${expect.ok}, got ${JSON.stringify(r)}` };
      if (!r.ok && r.code !== expect.code) {
        return { ok: false, detail: `expected code=${expect.code}, got ${r.code}` };
      }
      if (expect.enabled !== undefined && JSON.stringify(r.enabled) !== JSON.stringify(expect.enabled)) {
        return { ok: false, detail: `enabled mismatch: ${JSON.stringify(r.enabled)}` };
      }
      if (expect.recovery_allowed !== undefined) {
        const caps = vec.operation !== undefined
          ? r.enabled[vec.operation] ?? []
          : Object.values(r.enabled)[0] ?? [];
        for (const [decision, allowed] of Object.entries(expect.recovery_allowed)) {
          const got = proto.recoveryAllowed(caps, decision);
          if (got !== allowed) {
            return { ok: false, detail: `recovery_allowed[${decision}] expected ${allowed}, got ${got}` };
          }
        }
      }
      return { ok: true, detail: "" };
    }
    if (kind === "receipt_authority") {
      const receipt = vec.receipt!;
      const trustedRaw = vec.trusted_ops as [string, string][] | undefined;
      const trustedSet =
        trustedRaw !== undefined
          ? new Set(trustedRaw.map(([p, o]) => `${p}\u0000${o}`))
          : undefined;
      const attempt = vec.attempt;
      const resolves = proto.receiptIsResolvingEvidence(receipt, trustedSet);
      const canResolve = proto.receiptCanResolveAction(
        vec.action_state ?? "", receipt, attempt, trustedSet
      );
      if (resolves !== expect.resolves) {
        return { ok: false, detail: `expected resolves=${expect.resolves}, got ${resolves}` };
      }
      if (expect.can_resolve_action !== undefined && canResolve !== expect.can_resolve_action) {
        return { ok: false, detail: `expected can_resolve_action=${expect.can_resolve_action}, got ${canResolve}` };
      }
      return { ok: true, detail: "" };
    }
    if (kind === "reattachment") {
      const result = proto.reattachResult(vec.existing, vec.new);
      if (result !== expect.result) {
        return { ok: false, detail: `expected result=${expect.result}, got ${result}` };
      }
      return { ok: true, detail: "" };
    }
    if (kind === "replay_eligibility") {
      const got = proto.payloadReplayEligible(vec.payload_ref!, vec.now ?? "");
      if (got !== expect.replay_eligible) {
        return { ok: false, detail: `expected replay_eligible=${expect.replay_eligible}, got ${got}` };
      }
      return { ok: true, detail: "" };
    }
    return { ok: false, detail: `unknown vector kind ${String(kind)}` };
  } catch (err) {
    return { ok: false, detail: `error: ${(err as Error).message}` };
  }
}

function main(): number {
  const schemas = loadSchemas();
  const ajv = buildAjv(schemas);
  const manifest = JSON.parse(
    readFileSync(path.join(VECTORS_DIR, "manifest.json"), "utf8")
  ) as { vector_files: string[] };
  let total = 0;
  let passed = 0;
  const failures: string[] = [];
  for (const filename of manifest.vector_files) {
    const data = JSON.parse(readFileSync(path.join(VECTORS_DIR, filename), "utf8")) as {
      kind?: string;
      vectors: Vector[];
    };
    for (const raw of data.vectors) {
      const vec: Vector = { ...raw };
      if (vec.kind === undefined) vec.kind = data.kind;
      total += 1;
      const vid = vec.id ?? "?";
      const { ok, detail } = runVector(ajv, schemas, vec);
      if (ok) {
        passed += 1;
        console.log(`PASS ${vid}`);
      } else {
        failures.push(vid);
        console.log(`FAIL ${vid}: ${detail}`);
      }
    }
  }
  const failed = total - passed;
  console.log(`SUMMARY vectors=${total} passed=${passed} failed=${failed}`);
  return failed === 0 ? 0 : 1;
}

process.exit(main());
