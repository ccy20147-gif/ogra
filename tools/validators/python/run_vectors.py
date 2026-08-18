#!/usr/bin/env python3
"""Run the M0 golden vectors with the Python validator.

Requires the project venv (jsonschema >= 4.18 + referencing). Emits one
'PASS <id>' / 'FAIL <id>: <detail>' line per vector and a final
'SUMMARY vectors=N passed=M failed=K' line. Exit code is 0 iff failed == 0.

Usage: tools/validators/python/.venv/bin/python tools/validators/python/run_vectors.py
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

import ogra_protocol as proto

ROOT = Path(__file__).resolve().parent.parent.parent.parent
SPEC = ROOT / "spec" / "v0alpha1"
SCHEMAS_DIR = SPEC / "schemas"
VECTORS_DIR = SPEC / "vectors"

SCHEMA_FILES = [
    "run-ref", "action-intent", "action-snapshot", "action-attempt",
    "policy-decision", "route-decision", "redaction-record",
    "approval-binding", "dispatch-grant", "external-receipt", "payload-ref",
    "ingress-finding", "recovery-decision", "capability-manifest",
    "audit-event", "error-envelope", "client-hello", "server-hello",
]


def load_schemas() -> dict[str, dict]:
    schemas = {}
    for name in ["_defs", *SCHEMA_FILES]:
        schemas[name] = json.loads(
            (SCHEMAS_DIR / f"{name}.schema.json").read_text(encoding="utf-8")
        )
    return schemas


def make_registry(schemas: dict[str, dict]) -> Registry:
    resources = [
        (s["$id"], Resource.from_contents(s, default_specification=DRAFT202012))
        for s in schemas.values()
    ]
    return Registry().with_resources(resources)


def validate_document(schemas, registry, schema_name: str, document) -> tuple[bool, list[str]]:
    schema = schemas[schema_name]
    validator = Draft202012Validator(schema, registry=registry)
    errors = sorted(validator.iter_errors(document), key=lambda e: list(e.path))
    messages = []
    for e in errors:
        # Cross-language stable error identity: "<path>:<keyword>" (mirrors
        # the TypeScript runner). error_hint assertions match this form.
        path = "/".join(str(p) for p in e.path)
        norm = path.lstrip("/")
        detail = f"{norm}:{e.validator}"
        if e.validator == "required":
            m = re.search(r"'([^']+)' is a required property", e.message)
            if m:
                detail += f"#missing={m.group(1)}"
        messages.append(detail)
    return (not errors), messages


def run_vector(schemas, registry, vec: dict) -> tuple[bool, str]:
    kind = vec.get("kind")
    vid = vec.get("id", "?")
    expect = vec.get("expect", {})
    try:
        if kind == "schema_validation":
            valid, messages = validate_document(
                schemas, registry, vec["schema"], vec["document"]
            )
            if valid != expect.get("valid"):
                return False, f"expected valid={expect.get('valid')}, got {valid}"
            hint = expect.get("error_hint")
            if hint and valid:
                return False, "expected validation failure but document is valid"
            if hint and not any(hint in m for m in messages):
                return False, f"expected error hint {hint!r}, errors: {messages[:3]}"
            return True, ""
        if kind == "state_transition":
            allowed, to = proto.transition(vec["machine"], vec["state"], vec["event"])
            if allowed != expect.get("allowed"):
                return False, f"expected allowed={expect.get('allowed')}, got {allowed}"
            if allowed and expect.get("to") is not None and to != expect.get("to"):
                return False, f"expected to={expect.get('to')}, got {to}"
            return True, ""
        if kind == "canonical_hash":
            try:
                got_canonical = proto.canonical_json(vec["document"])
                got_hash = proto.hash_ref(vec["document"])
                error = False
            except ValueError:
                got_canonical, got_hash, error = None, None, True
            if error != bool(expect.get("error")):
                return False, f"expected error={bool(expect.get('error'))}, got error={error}"
            if not error:
                if got_canonical != expect.get("canonical"):
                    return False, "canonical mismatch"
                if got_hash != expect.get("hash"):
                    return False, f"hash mismatch: {got_hash}"
            return True, ""
        if kind == "timestamp_normalization":
            try:
                got = proto.normalize_timestamp(vec["input"])
                error = False
            except ValueError:
                got, error = None, True
            if error != bool(expect.get("error")):
                return False, f"expected error={bool(expect.get('error'))}, got error={error}"
            if not error and got != expect.get("normalized"):
                return False, f"expected normalized={expect.get('normalized')}, got {got}"
            return True, ""
        if kind == "negotiation":
            ok, negotiated, code = proto.negotiate(
                vec.get("client", ""), vec.get("server", ""),
                vec.get("client_minimum"),
            )
            if ok != expect.get("ok"):
                return False, f"expected ok={expect.get('ok')}, got {ok}"
            if ok and negotiated != expect.get("negotiated"):
                return False, f"expected negotiated={expect.get('negotiated')}, got {negotiated}"
            if not ok and code != expect.get("code"):
                return False, f"expected code={expect.get('code')}, got {code}"
            return True, ""
        if kind == "unknown_capability":
            result = proto.check_manifest(vec["manifest"])
            if result["ok"] != expect.get("ok"):
                return False, f"expected ok={expect.get('ok')}, got {result}"
            if not result["ok"] and result["code"] != expect.get("code"):
                return False, f"expected code={expect.get('code')}, got {result['code']}"
            if expect.get("enabled") is not None and result["enabled"] != expect["enabled"]:
                return False, f"enabled mismatch: {result['enabled']}"
            if expect.get("recovery_allowed") is not None:
                op = vec.get("operation")
                caps = result["enabled"].get(op, []) if op else next(iter(result["enabled"].values()), [])
                for decision, allowed in expect["recovery_allowed"].items():
                    if proto.recovery_allowed(caps, decision) != allowed:
                        return False, (
                            f"recovery_allowed[{decision}] expected {allowed}, "
                            f"got {proto.recovery_allowed(caps, decision)}"
                        )
            return True, ""
        if kind == "receipt_authority":
            receipt = vec["receipt"]
            trusted_raw = vec.get("trusted_ops")
            trusted_set = (
                set(tuple(t) for t in trusted_raw) if trusted_raw is not None else None
            )
            resolves = proto.receipt_is_resolving_evidence(receipt, trusted_set)
            can_resolve = proto.receipt_can_resolve_action(
                vec.get("action_state", ""), receipt, vec.get("attempt"), trusted_set
            )
            if resolves != expect.get("resolves"):
                return False, f"expected resolves={expect.get('resolves')}, got {resolves}"
            if expect.get("can_resolve_action") is not None and can_resolve != expect["can_resolve_action"]:
                return False, (
                    f"expected can_resolve_action={expect['can_resolve_action']}, got {can_resolve}"
                )
            return True, ""
        if kind == "reattachment":
            result = proto.reattach_result(vec["existing"], vec["new"])
            if result != expect.get("result"):
                return False, f"expected result={expect.get('result')}, got {result}"
            return True, ""
        if kind == "replay_eligibility":
            got = proto.payload_replay_eligible(vec["payload_ref"], vec.get("now", ""))
            if got != expect.get("replay_eligible"):
                return False, f"expected replay_eligible={expect.get('replay_eligible')}, got {got}"
            return True, ""
        return False, f"unknown vector kind {kind!r}"
    except Exception as exc:  # noqa: BLE001
        return False, f"error: {exc}"


def main() -> int:
    schemas = load_schemas()
    registry = make_registry(schemas)
    manifest = json.loads((VECTORS_DIR / "manifest.json").read_text(encoding="utf-8"))
    total = passed = 0
    failures: list[str] = []
    for filename in manifest["vector_files"]:
        data = json.loads((VECTORS_DIR / filename).read_text(encoding="utf-8"))
        file_kind = data.get("kind")
        for raw_vec in data["vectors"]:
            vec = dict(raw_vec)
            vec.setdefault("kind", file_kind)
            total += 1
            vid = vec.get("id", "?")
            ok, detail = run_vector(schemas, registry, vec)
            if ok:
                passed += 1
                print(f"PASS {vid}")
            else:
                failures.append(vid)
                print(f"FAIL {vid}: {detail}")
    failed = total - passed
    print(f"SUMMARY vectors={total} passed={passed} failed={failed}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
