#!/usr/bin/env python3
"""M0 exit-gate checks that are not part of the vector suite.

1. Every JSON Schema in spec/v0alpha1/schemas/ passes the Draft 2020-12
   meta-schema (jsonschema.Draft202012Validator.check_schema).
2. spec/v0alpha1/openapi.yaml loads in a standard OpenAPI parser
   (openapi-spec-validator) and is in sync with the schema files
   (regenerate with tools/build-openapi.py and diff).
3. Schemas contain no framework- or language-specific types
   (langchain/electron/pydantic/sqlite/python tokens).
4. Markdown links under spec/ and the repo README resolve to existing files.
5. The attempt state machine has NO transition out of 'unknown' (no
   automatic replay path for non-idempotent, non-queryable unknown Attempts),
   and a hash-only payload is mechanically ineligible for replay.

Usage: tools/validators/python/.venv/bin/python tools/validators/python/gates.py
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

from jsonschema import Draft202012Validator
from openapi_spec_validator import validate as validate_openapi
import yaml

import ogra_protocol as proto

ROOT = Path(__file__).resolve().parent.parent.parent.parent
SPEC = ROOT / "spec"
V0 = SPEC / "v0alpha1"
SCHEMAS = V0 / "schemas"
OPENAPI = V0 / "openapi.yaml"

FORBIDDEN_TOKENS = ["langchain", "electron", "pydantic", "sqlite", "python"]

MD_LINK_RE = re.compile(r"\[[^\]]*\]\(([^)]+)\)")


def check_meta_schema() -> list[str]:
    problems = []
    for path in sorted(SCHEMAS.glob("*.schema.json")):
        schema = json.loads(path.read_text(encoding="utf-8"))
        try:
            Draft202012Validator.check_schema(schema)
        except Exception as exc:  # noqa: BLE001
            problems.append(f"{path.name}: meta-schema failure: {exc}")
    return problems


def check_openapi() -> list[str]:
    problems = []
    try:
        doc = yaml.safe_load(OPENAPI.read_text(encoding="utf-8"))
        validate_openapi(doc)
    except Exception as exc:  # noqa: BLE001
        problems.append(f"openapi.yaml: {exc}")
        return problems
    # drift check: regenerating from the schema files must not change the
    # checked-in openapi.yaml
    before = OPENAPI.read_bytes()
    gen = subprocess.run(
        [sys.executable, str(ROOT / "tools" / "build-openapi.py")],
        cwd=ROOT, capture_output=True, text=True,
    )
    after = OPENAPI.read_bytes()
    OPENAPI.write_bytes(before)  # restore checked-in content
    if gen.returncode != 0:
        problems.append(f"openapi regeneration failed: {gen.stderr[-400:]}")
    elif before != after:
        problems.append("openapi.yaml drifted from the JSON Schema sources (run tools/build-openapi.py)")
    return problems


def check_schema_purity() -> list[str]:
    problems = []
    for path in sorted(SCHEMAS.glob("*.schema.json")):
        text = path.read_text(encoding="utf-8").lower()
        for token in FORBIDDEN_TOKENS:
            if re.search(rf"\b{token}\b", text):
                problems.append(f"{path.name}: forbidden token {token!r}")
    return problems


def check_links() -> list[str]:
    problems = []
    md_files = list(SPEC.rglob("*.md")) + [ROOT / "README.md"]
    for path in sorted(md_files):
        text = path.read_text(encoding="utf-8")
        base = path.parent
        for m in MD_LINK_RE.finditer(text):
            target = m.group(1)
            if target.startswith(("http://", "https://", "#", "mailto:")):
                continue
            frag = ""
            if "#" in target:
                target, frag = target.split("#", 1)
            if not target:
                continue
            resolved = (base / target).resolve()
            if not resolved.exists():
                problems.append(f"{path.relative_to(ROOT)}: broken link {m.group(1)!r}")
    return problems


def check_no_auto_replay() -> list[str]:
    problems = []
    if not proto.no_automatic_replay_from_unknown():
        problems.append("attempt state machine has a transition FROM 'unknown' (automatic replay path exists)")
    # hash-only payload is mechanically ineligible for replay
    ref = {
        "protocol_version": "0.1",
        "storage_mode": "hash_only",
        "content_hash": {
            "algorithm": "sha256",
            "canonicalization": "ogra-jcs-1",
            "value": "sha256:" + "0" * 64,
        },
        "replay_eligible": False,
    }
    if proto.payload_replay_eligible(ref, "2026-08-17T12:00:00.000Z"):
        problems.append("hash-only payload must never be replay-eligible")
    # advisory receipt cannot resolve an effect
    advisory = {"authority": "advisory", "effect_status": "completed"}
    if proto.receipt_is_resolving_evidence(advisory):
        problems.append("advisory receipt must not resolve an effect")
    # self-declared authoritative transport_ack cannot resolve (P0-2)
    forged = {
        "receipt_kind": "transport_ack",
        "authority": "authoritative",
        "effect_status": "completed",
    }
    if proto.receipt_is_resolving_evidence(forged, {("weather-api", "get_forecast")}):
        problems.append("self-declared authoritative transport_ack must not resolve an effect")
    # omitting the trusted conformance context must fail closed (P0-2 round 2)
    no_ctx = {
        "receipt_kind": "effect_completion",
        "authority": "authoritative",
        "effect_status": "completed",
        "provider": {"provider": "weather-api", "operation": "get_forecast"},
    }
    if proto.receipt_is_resolving_evidence(no_ctx):
        problems.append("authoritative receipt without trusted conformance context must not resolve")
    return problems


def check_receipt_resolution_binding() -> list[str]:
    """Regression gate: Action resolution is impossible without one matching,
    server-persisted Attempt. Field-only evidence is deliberately insufficient."""
    problems = []
    receipt = {
        "receipt_kind": "effect_completion",
        "authority": "authoritative",
        "effect_status": "completed",
        "attempt_id": "atp_1",
        "action_id": "act_1",
        "execution_profile": "edge_mediated",
        "provider": {"provider": "weather-api", "operation": "get_forecast"},
    }
    trusted = {("weather-api", "get_forecast")}
    attempt = {
        "attempt_id": "atp_1",
        "action_id": "act_1",
        "execution_profile": "edge_mediated",
        "destination": {"provider": "weather-api", "operation": "get_forecast"},
    }
    if not proto.receipt_can_resolve_action("executing", receipt, attempt, trusted):
        problems.append("matching server-persisted Attempt must permit trusted resolution")
    if proto.receipt_can_resolve_action("executing", receipt, None, trusted):
        problems.append("missing Attempt context must fail closed")
    for field, value in (("attempt_id", "atp_other"), ("action_id", "act_other")):
        mismatched = dict(attempt)
        mismatched[field] = value
        if proto.receipt_can_resolve_action("executing", receipt, mismatched, trusted):
            problems.append(f"receipt {field} mismatch must fail closed")
    mismatched_destination = dict(attempt)
    mismatched_destination["destination"] = {
        "provider": "other-api", "operation": "other_operation"
    }
    if proto.receipt_can_resolve_action("executing", receipt, mismatched_destination, trusted):
        problems.append("receipt destination mismatch must fail closed")
    return problems


TRAILING_WS_RE = re.compile(r"[ \t]+$")
CONFLICT_MARKER_RE = re.compile(r"^(<<<<<<<|=======|>>>>>>>)")
SKIP_DIRS = {".venv", "node_modules", "__pycache__", ".git"}


# PROT-008 header matrix: which operations require which command headers.
# Creation commands: X-Ogra-Command-Id required, X-Ogra-Expected-Revision MUST
# be absent. Mutating commands on existing objects: both required.
# /audit/verify is read-only: neither header allowed.
CREATION_OPS = {
    ("/runs", "post"),
    ("/payloads", "post"),
    ("/actions", "post"),
    ("/actions/{action_id}/approval-requests", "post"),
    ("/actions/{action_id}/attempts", "post"),
    ("/capabilities", "post"),
}
MUTATION_OPS = {
    ("/runs/{run_id}/seal", "post"),
    ("/attempts/{attempt_id}/grant", "post"),
    ("/attempts/{attempt_id}/ack", "post"),
    ("/attempts/{attempt_id}/receipts", "post"),
    ("/attempts/{attempt_id}/outcome", "post"),
    ("/approvals/{approval_id}/decide", "post"),
    ("/ingress", "post"),
    ("/ingress/{ingress_id}/resolve", "post"),
    ("/actions/{action_id}/recovery", "post"),
    ("/recovery/{decision_id}/apply", "post"),
}
READONLY_OPS = {("/audit/verify", "post")}


def check_openapi_headers() -> list[str]:
    """Assert the PROT-008 command-header matrix (P1-4 round 2): the gate must
    verify that creation commands require only X-Ogra-Command-Id, mutations of
    existing objects require both headers, and read-only operations require
    neither."""
    problems = []
    try:
        doc = yaml.safe_load(OPENAPI.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        return [f"openapi.yaml unreadable: {exc}"]
    paths = doc.get("paths", {})
    for (path, method), expected in [
        *[(op, "create") for op in sorted(CREATION_OPS)],
        *[(op, "mutate") for op in sorted(MUTATION_OPS)],
        *[(op, "readonly") for op in sorted(READONLY_OPS)],
    ]:
        op = paths.get(path, {}).get(method)
        if op is None:
            problems.append(f"missing operation {method.upper()} {path}")
            continue
        params = op.get("parameters", [])
        names = {p.get("name") for p in params if p.get("in") == "header"}
        cmd = next(
            (p for p in params if p.get("name") == "X-Ogra-Command-Id"), None
        )
        rev = next(
            (p for p in params if p.get("name") == "X-Ogra-Expected-Revision"), None
        )
        if expected == "create":
            if cmd is None or cmd.get("required") is not True:
                problems.append(f"{method.upper()} {path}: X-Ogra-Command-Id must be required")
            if rev is not None:
                problems.append(f"{method.upper()} {path}: creation MUST NOT carry X-Ogra-Expected-Revision")
        elif expected == "mutate":
            if cmd is None or cmd.get("required") is not True:
                problems.append(f"{method.upper()} {path}: X-Ogra-Command-Id must be required")
            if rev is None or rev.get("required") is not True:
                problems.append(f"{method.upper()} {path}: X-Ogra-Expected-Revision must be required")
            elif rev.get("schema", {}).get("$ref") != "#/components/schemas/_defs/$defs/RevisionRef":
                problems.append(f"{method.upper()} {path}: X-Ogra-Expected-Revision must reference RevisionRef")
        elif expected == "readonly":
            if "X-Ogra-Command-Id" in names or "X-Ogra-Expected-Revision" in names:
                problems.append(f"{method.upper()} {path}: read-only operation must not carry command headers")
    return problems


def check_files_format() -> list[str]:
    """Whitespace/format hygiene over ALL M0 files, tracked or not
    (the reviewer's point: git diff --check misses untracked files)."""
    problems = []
    roots = [SPEC, ROOT / "tools"]
    for root in roots:
        for path in sorted(root.rglob("*")):
            if path.is_dir():
                continue
            if any(part in SKIP_DIRS for part in path.parts):
                continue
            if path.suffix not in {".md", ".json", ".yaml", ".yml", ".py", ".ts", ".sh", ".txt"}:
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                problems.append(f"{path.relative_to(ROOT)}: not UTF-8 text")
                continue
            for i, line in enumerate(text.splitlines(), 1):
                if TRAILING_WS_RE.search(line):
                    problems.append(f"{path.relative_to(ROOT)}:{i}: trailing whitespace")
                    break
                if CONFLICT_MARKER_RE.match(line):
                    problems.append(f"{path.relative_to(ROOT)}:{i}: conflict marker")
                    break
            if "\r" in text:
                problems.append(f"{path.relative_to(ROOT)}: carriage returns")
    return problems


def main() -> int:
    checks = [
        ("meta-schema", check_meta_schema),
        ("openapi-load+drift", check_openapi),
        ("openapi-headers", check_openapi_headers),
        ("receipt-resolution-binding", check_receipt_resolution_binding),
        ("schema-purity", check_schema_purity),
        ("markdown-links", check_links),
        ("no-auto-replay", check_no_auto_replay),
        ("files-format", check_files_format),
    ]
    failed = 0
    for name, fn in checks:
        problems = fn()
        if problems:
            failed += 1
            print(f"GATE_FAIL {name}")
            for p in problems:
                print(f"  - {p}")
        else:
            print(f"GATE_PASS {name}")
    print(f"GATES summary={len(checks)} failed={failed}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
