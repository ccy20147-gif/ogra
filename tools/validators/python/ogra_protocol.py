#!/usr/bin/env python3
"""Ogra protocol core semantics for the M0 validator suite.

Pure standard library: canonical JSON (ogra-jcs-1), hashing, timestamp
normalization, version negotiation, state-machine transitions, receipt
authority semantics, payload replay eligibility, submission-key deduplication,
and capability gating. This module MUST stay dependency-free so the vector
runner is the only place where jsonschema is imported.

The same semantics are mirrored in tools/validators/typescript/core.ts; the
golden vectors are the cross-language contract.
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

SPEC_ROOT = Path(__file__).resolve().parent.parent.parent.parent / "spec" / "v0alpha1"

# ---------------------------------------------------------------------------
# ogra-jcs-1 canonical JSON
# ---------------------------------------------------------------------------

# Cross-language exact-integer range: JS Number is safe only within
# +/- (2**53 - 1). Values beyond this MUST be decimal strings (P0-3).
SAFE_INT_MAX = 9007199254740991  # 2**53 - 1

_ESCAPE_RE = re.compile(r'(["\\\x00-\x1f])')


def _escape_char(m: re.Match) -> str:
    ch = m.group(1)
    if ch == '"':
        return '\\"'
    if ch == "\\":
        return "\\\\"
    return "\\u%04x" % ord(ch)


def _serialize(value) -> str:
    if value is None:
        return ""
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        if abs(value) > SAFE_INT_MAX:
            raise ValueError(
                f"integer {value} outside ogra-jcs-1 safe range (|n| <= {SAFE_INT_MAX}); "
                "represent larger values as decimal strings"
            )
        return str(value)
    if isinstance(value, str):
        return '"' + _ESCAPE_RE.sub(_escape_char, value) + '"'
    if isinstance(value, list):
        parts = [_serialize(v) for v in value if v is not None]
        return "[" + ",".join(parts) + "]"
    if isinstance(value, dict):
        parts = []
        for k in sorted(value.keys()):
            v = value[k]
            if v is None:
                continue
            parts.append(
                '"' + _ESCAPE_RE.sub(_escape_char, k) + '":' + _serialize(v)
            )
        return "{" + ",".join(parts) + "}"
    if isinstance(value, float):
        raise ValueError("non-integer numbers are not representable in ogra-jcs-1")
    raise TypeError(f"unsupported value in canonical JSON: {type(value)!r}")


def canonical_json(document) -> str:
    """Return the ogra-jcs-1 canonical byte string (as str) for a document."""
    if not isinstance(document, dict):
        raise ValueError("canonical document must be a JSON object")
    return _serialize(document)


def canonical_bytes(document) -> bytes:
    return canonical_json(document).encode("utf-8")


def sha256_hex(document) -> str:
    return hashlib.sha256(canonical_bytes(document)).hexdigest()


def hash_ref(document) -> str:
    return "sha256:" + sha256_hex(document)


# ---------------------------------------------------------------------------
# Timestamps
# ---------------------------------------------------------------------------

_TS_RE = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$"
)

_DAYS_IN_MONTH = (31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)


def _days_in_month(year: int, month: int) -> int:
    if month == 2:
        leap = year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)
        return 29 if leap else 28
    return _DAYS_IN_MONTH[month - 1]


def normalize_timestamp(value: str) -> str:
    """Normalize an RFC 3339 UTC timestamp to the canonical wire form
    YYYY-MM-DDTHH:MM:SS.sssZ (uppercase T/Z, exactly three fractional digits,
    truncation never rounding). Calendar-valid dates only: nonexistent dates
    such as 2026-02-31 or 2026-02-29 (non-leap) are rejected."""
    m = _TS_RE.match(value)
    if not m:
        raise ValueError(f"invalid timestamp: {value!r}")
    y, mo, d, h, mi, s, frac = m.groups()
    y, mo, d, h, mi, s = (int(x) for x in (y, mo, d, h, mi, s))
    if not (1 <= mo <= 12 and 1 <= d <= _days_in_month(y, mo)):
        raise ValueError(f"invalid timestamp date: {value!r}")
    if not (0 <= h <= 23 and 0 <= mi <= 59 and 0 <= s <= 59):
        raise ValueError(f"invalid timestamp time: {value!r}")
    frac = (frac or "")[:3].ljust(3, "0")
    return f"{y:04d}-{mo:02d}-{d:02d}T{h:02d}:{mi:02d}:{s:02d}.{frac}Z"


def timestamp_compare(a: str, b: str) -> int:
    """Compare two canonical timestamps lexicographically (canonical form is
    sortable)."""
    return -1 if a < b else (1 if a > b else 0)


# ---------------------------------------------------------------------------
# Version negotiation (PROT-007, ADR-009)
# ---------------------------------------------------------------------------

MAJOR_MISMATCH = "PROTOCOL_MAJOR_MISMATCH"
MINOR_MISMATCH = "PROTOCOL_MINOR_MISMATCH"
BAD_REQUEST = "BAD_REQUEST"


def parse_version(v: str) -> tuple[int, int]:
    m = re.match(r"^(\d+)\.(\d+)$", v)
    if not m:
        raise ValueError(f"invalid protocol version: {v!r}")
    return int(m.group(1)), int(m.group(2))


def negotiate(client: str, server: str, client_minimum: str | None = None):
    """Negotiate protocol version.

    Returns (ok, negotiated_or_None, error_code_or_None). Same major required;
    negotiated minor is min(client, server) compared NUMERICALLY (0.10 > 0.2);
    the side declaring the higher minor must constrain itself. If the client
    declares a minimum acceptable version and the negotiated version is below
    it, negotiation fails with PROTOCOL_MINOR_MISMATCH. Unparseable version
    strings yield BAD_REQUEST.
    """
    try:
        c_major, c_minor = parse_version(client)
        s_major, s_minor = parse_version(server)
    except ValueError:
        return False, None, BAD_REQUEST
    if c_major != s_major:
        return False, None, MAJOR_MISMATCH
    negotiated = (c_major, min(c_minor, s_minor))
    if client_minimum is not None:
        try:
            min_major, min_minor = parse_version(client_minimum)
        except ValueError:
            return False, None, BAD_REQUEST
        if min_major != c_major:
            return False, None, MAJOR_MISMATCH
        if negotiated < (min_major, min_minor):
            return False, None, MINOR_MISMATCH
    return True, f"{negotiated[0]}.{negotiated[1]}", None


# ---------------------------------------------------------------------------
# State machines (PROT-011, PROT-013, PROT-015)
# ---------------------------------------------------------------------------

_MACHINE_FILES = {
    "action": "state-machines/action.json",
    "attempt": "state-machines/attempt.json",
    "ingress": "state-machines/ingress.json",
    "recovery_decision": "state-machines/recovery-decision.json",
}

_MACHINES: dict[str, dict] = {}


def _load_machines() -> dict[str, dict]:
    if not _MACHINES:
        for name, rel in _MACHINE_FILES.items():
            data = json.loads((SPEC_ROOT / rel).read_text(encoding="utf-8"))
            transitions = {}
            for t in data["transitions"]:
                transitions.setdefault(t["from"], {})[t["event"]] = t["to"]
            _MACHINES[name] = {
                "states": set(data["states"]),
                "terminal": set(data["terminal"]),
                "transitions": transitions,
            }
    return _MACHINES


def transition(machine: str, state: str, event: str):
    """Return (allowed: bool, to_state: str | None)."""
    m = _load_machines()[machine]
    if state not in m["states"]:
        return False, None
    by_event = m["transitions"].get(state)
    if not by_event or event not in by_event:
        return False, None
    return True, by_event[event]


def is_terminal(machine: str, state: str) -> bool:
    return state in _load_machines()[machine]["terminal"]


def unknown_attempt_has_replay_path() -> bool:
    """Exit-gate predicate: a non-idempotent, non-queryable unknown Attempt
    must have no automatic replay path. There is no transition FROM 'unknown'
    in the attempt machine."""
    m = _load_machines()["attempt"]
    return "unknown" in m["transitions"]


def no_automatic_replay_from_unknown() -> bool:
    return not unknown_attempt_has_replay_path()


# ---------------------------------------------------------------------------
# Receipt authority semantics (PROT-028, PROT-029)
# ---------------------------------------------------------------------------

RESOLVING_EFFECT_STATUS = {"completed", "failed"}
# Only these receipt kinds may carry resolving effect evidence. A transport
# acknowledgement or provider acceptance never resolves an effect; only a
# conformance-backed effect completion or failure may (P0-2, PROT-028).
RESOLVING_RECEIPT_KINDS = {"effect_completion", "failure"}


def receipt_is_resolving_evidence(receipt: dict, trusted_ops: set | None = None) -> bool:
    """Return whether receipt fields qualify as resolving evidence.

    `authority` is NOT self-declared on the wire (P0-2 round 2): the trusted
    conformance context is REQUIRED. `trusted_ops` defaults to an EMPTY set,
    so omitting it fails closed — an authoritative receipt never resolves
    without a trusted (provider, operation) context.

    NOTE: the receipt's own `provider` fields are client-declared and are not
    authorization evidence. This predicate MUST NOT advance Action state.
    State advancement is allowed only through receipt_can_resolve_action(),
    which binds the receipt to a server-persisted Attempt."""
    if receipt.get("authority") != "authoritative":
        return False
    if receipt.get("effect_status") not in RESOLVING_EFFECT_STATUS:
        return False
    if receipt.get("receipt_kind") not in RESOLVING_RECEIPT_KINDS:
        return False
    trusted = trusted_ops if trusted_ops is not None else set()
    provider = receipt.get("provider", {})
    key = (provider.get("provider"), provider.get("operation"))
    if key not in trusted:
        return False
    return True


def receipt_matches_attempt(receipt: dict, attempt: dict | None) -> bool:
    """Bind a receipt to the server-persisted Attempt that owns it.

    The M0 ActionAttempt schema persists Action/Attempt identifiers,
    execution profile, and destination. It does not persist provider account
    or provider request identity, so this protocol predicate deliberately
    does not invent a comparison for those client-declared receipt fields.
    They remain correlation evidence until a later schema revision gives Edge
    server-persisted values to compare.
    """
    if not isinstance(attempt, dict):
        return False
    provider = receipt.get("provider", {})
    return (
        receipt.get("attempt_id") == attempt.get("attempt_id")
        and receipt.get("action_id") == attempt.get("action_id")
        and receipt.get("execution_profile") == attempt.get("execution_profile")
        and provider.get("provider") == attempt.get("destination", {}).get("provider")
        and provider.get("operation") == attempt.get("destination", {}).get("operation")
    )


def advisory_receipt_cannot_resolve(receipt: dict) -> bool:
    if receipt.get("authority") == "advisory":
        return not receipt_is_resolving_evidence(receipt)
    return True


def receipt_can_resolve_action(
    action_state: str,
    receipt: dict,
    attempt: dict | None,
    trusted_ops: set | None = None,
) -> bool:
    """The sole M0 predicate permitted to advance an Action from receipt evidence.

    `attempt` MUST be the server-persisted ActionAttempt, not a client-supplied
    destination projection. Missing Attempt context fails closed.
    """
    if action_state not in ("executing", "unknown_outcome"):
        return False
    return (
        receipt_is_resolving_evidence(receipt, trusted_ops)
        and receipt_matches_attempt(receipt, attempt)
    )


def default_receipt_semantics(receipt_kind: str):
    """(authority, effect_status) defaults per receipt_kind."""
    return {
        "transport_ack": ("advisory", "unknown"),
        "provider_acceptance": ("advisory", "unknown"),
        "effect_completion": ("authoritative", "completed"),
        "failure": ("authoritative", "failed"),
        "result": ("authoritative", "completed"),
    }[receipt_kind]


# ---------------------------------------------------------------------------
# Payload replay eligibility (PROT-025, PROT-026)
# ---------------------------------------------------------------------------

KNOWN_CAPABILITIES = {"replay_safe", "idempotent", "outcome_query", "compensatable"}


def payload_replay_eligible(payload_ref: dict, now: str) -> bool:
    """Machine-readable replay eligibility. A hash-only payload is never
    replayable; encrypted replayable material is replayable only within
    retention and while decryptable (not deleted, not expired); external
    references delegate to their retrieval policy."""
    mode = payload_ref.get("storage_mode")
    declared = bool(payload_ref.get("replay_eligible"))
    if mode == "hash_only":
        return False
    if mode == "encrypted_replayable":
        if not declared:
            return False
        if payload_ref.get("deleted"):
            return False
        expires_at = payload_ref.get("expires_at")
        if expires_at and now and expires_at <= now:
            return False
        return True
    if mode == "external_reference":
        if not declared:
            return False
        return payload_ref.get("retrieval_policy") in ("immediate", "delegated")
    return False


def hash_only_never_replayable(payload_ref: dict, now: str) -> bool:
    if payload_ref.get("storage_mode") == "hash_only":
        return not payload_replay_eligible(payload_ref, now)
    return True


# ---------------------------------------------------------------------------
# Submission-key deduplication (PROT-030, PROT-031)
# ---------------------------------------------------------------------------

SUBMISSION_KEY_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")


def reattach_result(existing: dict, new: dict) -> str:
    """same canonical request -> 'same_identity'; conflicting canonical
    request -> 'conflict'."""
    if sha256_hex(existing) == sha256_hex(new):
        return "same_identity"
    return "conflict"


# ---------------------------------------------------------------------------
# Capability gating (PROT-018, PROT-021)
# ---------------------------------------------------------------------------

RETRY_CAPABILITIES = {"replay_safe", "idempotent"}
RECONCILE_CAPABILITIES = {"outcome_query"}


def check_manifest(manifest: dict):
    """Validate a CapabilityManifest for unknown capabilities and compute
    which operations are recovery-enabled.

    Returns {"ok": bool, "code": str|None, "enabled": {op_id: [caps]}}.

    Conformance trust is OPERATION-SCOPED (PROT-018, PROT-021): an
    operation's capabilities are enabled only when it references at least one
    conformance result AND every referenced conformance_id has status
    'trusted'. Missing/unknown conformance ids fail closed (P0-1).

    Duplicate operation_id or conformance_id entries are REJECTED with
    DUPLICATE_ID, order-independently: a conformance_id appearing twice (e.g.
    once untrusted, once trusted) can never enable capabilities, and a
    duplicated operation_id can never be resolved by "last one wins"
    (P1-2 round 2, conservative degradation)."""
    enabled: dict[str, list[str]] = {}
    status_by_id: dict[str, str] = {}
    seen_ops: set[str] = set()
    seen_conf: set[str] = set()
    for c in manifest.get("conformance", []):
        cid = c.get("conformance_id")
        if cid in seen_conf:
            return {"ok": False, "code": "DUPLICATE_ID", "enabled": enabled}
        seen_conf.add(cid)
        status_by_id[cid] = c.get("status")
    for op in manifest.get("operations", []):
        op_id = op.get("operation_id")
        if op_id in seen_ops:
            return {"ok": False, "code": "DUPLICATE_ID", "enabled": enabled}
        seen_ops.add(op_id)
        recovery = op.get("recovery", {})
        caps = recovery.get("capabilities", [])
        for c in caps:
            if c not in KNOWN_CAPABILITIES:
                return {"ok": False, "code": "UNKNOWN_CAPABILITY", "enabled": enabled}
        refs = recovery.get("conformance_refs", [])
        all_trusted = bool(refs) and all(status_by_id.get(r) == "trusted" for r in refs)
        enabled[op_id] = sorted(caps) if all_trusted else []
    return {"ok": True, "code": None, "enabled": enabled}


def recovery_allowed(operation_caps: list[str], decision: str) -> bool:
    """Which recovery decisions may be EXECUTED for an operation given its
    trusted capabilities. Uncertainty is never retry authority.

    Proposing compensation is always allowed (a human may always decide);
    EXECUTING compensation requires the trusted `compensatable` capability
    (P1-7). manual_review and stop touch nothing external and are always
    allowed."""
    caps = set(operation_caps)
    if decision == "reconcile":
        return bool(caps & RECONCILE_CAPABILITIES)
    if decision == "retry_with_same_key":
        return bool(caps & RETRY_CAPABILITIES)
    if decision == "compensate":
        return "compensatable" in caps
    if decision in ("manual_review", "stop"):
        return True
    return False
