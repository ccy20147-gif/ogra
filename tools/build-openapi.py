#!/usr/bin/env python3
"""Generate spec/v0alpha1/openapi.yaml from the JSON Schema files in
spec/v0alpha1/schemas/. The JSON Schemas are the single authority; this script
materializes them as OpenAPI 3.1 components (external refs resolved inline) so
standard parsers can load the contract without a file-ref resolver.

Usage: python3 tools/build-openapi.py
Run from the repository root. The output file is checked in; tools/verify-m0.sh
regenerates it and fails on drift.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
SPEC = ROOT / "spec" / "v0alpha1"
SCHEMAS = SPEC / "schemas"
OUT = SPEC / "openapi.yaml"

SCHEMA_BASE = "https://ogra.dev/spec/v0alpha1/schemas"
OBJ_FILES = [
    "run-ref", "action-intent", "action-snapshot", "action-attempt",
    "policy-decision", "route-decision", "redaction-record",
    "approval-binding", "dispatch-grant", "external-receipt", "payload-ref",
    "ingress-finding", "recovery-decision", "capability-manifest",
    "audit-event", "error-envelope", "client-hello", "server-hello",
]


def load_schemas() -> dict[str, dict]:
    schemas: dict[str, dict] = {}
    for name in ["_defs", *OBJ_FILES]:
        path = SCHEMAS / f"{name}.schema.json"
        schemas[name] = json.loads(path.read_text(encoding="utf-8"))
    return schemas


def rewrite_refs(node, _defs=False):
    """Rewrite $ref values for the OpenAPI component tree.

    - URL refs to sibling schema files become '#/components/schemas/<name>'.
    - Fragment refs inside _defs become '#/components/schemas/_defs/$defs/...'.
    """
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str):
            m = re.match(rf"^{re.escape(SCHEMA_BASE)}/([a-z0-9_-]+)\.schema\.json(?:#/(.*))?$", ref)
            if m:
                name, frag = m.group(1), m.group(2)
                if name not in {*OBJ_FILES, "_defs"}:
                    raise ValueError(f"unknown schema ref target: {ref}")
                if frag:
                    node["$ref"] = f"#/components/schemas/{name}/{frag}"
                else:
                    node["$ref"] = f"#/components/schemas/{name}"
                return
            if _defs:
                m2 = re.match(r"^#/\$defs/(.+)$", ref)
                if m2:
                    node["$ref"] = f"#/components/schemas/_defs/$defs/{m2.group(1)}"
                    return
            raise ValueError(f"unresolvable $ref: {ref}")
        for v in node.values():
            rewrite_refs(v, _defs=_defs)
    elif isinstance(node, list):
        for v in node:
            rewrite_refs(v, _defs=_defs)


def to_component(schema: dict, _defs: bool = False) -> dict:
    comp = json.loads(json.dumps(schema))
    comp.pop("$id", None)
    comp.pop("$schema", None)
    rewrite_refs(comp, _defs=_defs)
    return comp


def json_schema_ref(name: str) -> dict:
    return {"$ref": f"#/components/schemas/{name}"}


def err_response(desc: str) -> dict:
    return {
        "description": desc,
        "content": {
            "application/json": {"schema": json_schema_ref("error-envelope")}
        },
    }


COMMAND_HEADERS = [
    {
        "name": "X-Ogra-Command-Id",
        "in": "header",
        "required": True,
        "description": "Command identity (PROT-008): makes mutating commands idempotent. REQUIRED on every mutating command.",
        "schema": {"type": "string", "pattern": "^cmd_[0-9a-hjkmnp-tv-z]{26}$"},
    },
    {
        "name": "X-Ogra-Expected-Revision",
        "in": "header",
        "required": True,
        "description": "Expected positive revision of the object being mutated (PROT-008). Commands fail with LEASE_CONFLICT on mismatch. REQUIRED on every command that mutates an existing object.",
        "schema": {"$ref": "#/components/schemas/_defs/$defs/RevisionRef"},
    },
]

# Creation commands have no prior object to check: X-Ogra-Command-Id is
# REQUIRED; X-Ogra-Expected-Revision MUST be absent (the created object starts
# at revision 1). See the info description (PROT-008, P1-4).
CREATE_HEADERS = [COMMAND_HEADERS[0]]


def build() -> dict:
    schemas = load_schemas()
    components: dict[str, dict] = {}
    components["_defs"] = to_component(schemas["_defs"], _defs=True)
    for name in OBJ_FILES:
        components[name] = to_component(schemas[name])

    def ok(desc, schema, status=200):
        return {
            "description": desc,
            "content": {"application/json": {"schema": schema}},
        }

    def ref(name):
        return json_schema_ref(name)

    return {
        "openapi": "3.1.0",
        "info": {
            "title": "Ogra Action Protocol — Command/Query Contract",
            "version": "0.1",
            "description": (
                "Language-neutral command/query surface for the Ogra Action Runtime. "
                "Normative data shapes live in the JSON Schema files under spec/v0alpha1/schemas/; "
                "this document is generated from them (tools/build-openapi.py). "
                "Transport: local HTTP, Unix domain socket, or loopback TCP. "
                "Default development endpoint: http://127.0.0.1:7634. "
                "Mutating commands carry X-Ogra-Command-Id (required, PROT-008). "
                "Commands that mutate an existing object additionally carry "
                "X-Ogra-Expected-Revision (required; mismatch fails with "
                "LEASE_CONFLICT). Creation commands (create run, store payload, "
                "propose action, approval request, prepare attempt, register "
                "manifest) carry only X-Ogra-Command-Id and MUST NOT carry "
                "X-Ogra-Expected-Revision; created objects start at revision 1. "
                "Errors use the ErrorEnvelope."
            ),
        },
        "servers": [{"url": "http://127.0.0.1:7634", "description": "Local Ogra Edge (development default)"}],
        "tags": [
            {"name": "health", "description": "Health check"},
            {"name": "protocol", "description": "Protocol negotiation"},
            {"name": "run", "description": "Run lifecycle"},
            {"name": "action", "description": "Action lifecycle and decisions"},
            {"name": "attempt", "description": "Attempt lifecycle, grants, receipts, outcomes"},
            {"name": "approval", "description": "Approval binding"},
            {"name": "ingress", "description": "Ingress review and quarantine"},
            {"name": "recovery", "description": "Recovery decisions"},
            {"name": "capability", "description": "Capability manifests"},
            {"name": "evidence", "description": "Evidence and audit verification"},
        ],
        "paths": {
            "/health": {
                "get": {
                    "tags": ["health"],
                    "operationId": "healthCheck",
                    "summary": "Liveness and capability probe",
                    "responses": {
                        "200": ok(
                            "Healthy Edge with independent profiles",
                            {
                                "type": "object",
                                "properties": {
                                    "status": {"const": "ok"},
                                    "server_id": {"type": "string"},
                                    "protocol_version": {"type": "string"},
                                    "profiles": ref("_defs"),
                                    "server_clock": {"type": "string"},
                                },
                                "required": ["status", "server_id", "protocol_version", "profiles", "server_clock"],
                                "additionalProperties": False,
                            },
                        ),
                        "503": err_response("Unavailable (retryable_safe)"),
                    },
                },
            },
            "/protocol/handshake": {
                "post": {
                    "tags": ["protocol"],
                    "operationId": "handshake",
                    "summary": "Negotiate protocol major/minor and profiles",
                    "description": (
                        "ClientHello declares the client's protocol version. Same major required; "
                        "negotiated minor is min(client, server); the side declaring the higher "
                        "minor must constrain itself (PROT-007, ADR-009)."
                    ),
                    "requestBody": {
                        "required": True,
                        "content": {"application/json": {"schema": ref("client-hello")}},
                    },
                    "responses": {
                        "200": ok("Negotiated ServerHello", ref("server-hello")),
                        "400": err_response("Protocol mismatch (PROTOCOL_MAJOR_MISMATCH / PROTOCOL_MINOR_MISMATCH)"),
                    },
                },
            },
            "/runs": {
                "post": {
                    "tags": ["run"],
                    "operationId": "createRun",
                    "summary": "Create a Run (idempotent by submission_key)",
                    "description": "A repeated submission_key returns the existing Run identity; a conflicting canonical request is rejected (PROT-031).",
                    "parameters": CREATE_HEADERS,
                    "requestBody": {
                        "required": True,
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "protocol_version": {"const": "0.1"},
                                        "submission_key": {"$ref": "#/components/schemas/_defs/$defs/SubmissionKey"},
                                        "created_at": {"$ref": "#/components/schemas/_defs/$defs/Timestamp"},
                                    },
                                    "required": ["protocol_version", "created_at"],
                                    "additionalProperties": False,
                                }
                            }
                        },
                    },
                    "responses": {
                        "201": ok("Run created", ref("run-ref")),
                        "409": err_response("Conflicting submission (CONFLICTING_SUBMISSION)"),
                    },
                },
            },
            "/runs/{run_id}": {
                "get": {
                    "tags": ["run"],
                    "operationId": "getRun",
                    "summary": "Read a Run",
                    "parameters": [
                        {"name": "run_id", "in": "path", "required": True, "schema": {"type": "string"}}
                    ],
                    "responses": {
                        "200": ok("Run", ref("run-ref")),
                        "404": err_response("Not found"),
                    },
                },
            },
            "/runs/{run_id}/seal": {
                "post": {
                    "tags": ["run"],
                    "operationId": "sealRun",
                    "summary": "Seal a Run after agent completion",
                    "parameters": [
                        {"name": "run_id", "in": "path", "required": True, "schema": {"type": "string"}},
                        *COMMAND_HEADERS,
                    ],
                    "responses": {
                        "200": ok("Sealed Run", ref("run-ref")),
                        "404": err_response("Not found"),
                    },
                },
            },
            "/payloads": {
                "post": {
                    "tags": ["run"],
                    "operationId": "storePayload",
                    "summary": "Store sanctioned payload material under explicit retention",
                    "description": (
                        "Returns a PayloadRef. json payloads are canonicalized with ogra-jcs-1; "
                        "bytes payloads are base64-encoded. retention: hash_only (evidence only) "
                        "or encrypted (explicitly replayable, authenticated-encrypted, with key id, "
                        "retention class, and expiry)."
                    ),
                    "parameters": CREATE_HEADERS,
                    "requestBody": {
                        "required": True,
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "protocol_version": {"const": "0.1"},
                                        "encoding": {"enum": ["json", "bytes"]},
                                        "data": {"type": "string"},
                                        "retention": {"enum": ["hash_only", "encrypted_replayable"]},
                                        "expires_at": {"$ref": "#/components/schemas/_defs/$defs/Timestamp"},
                                    },
                                    "required": ["protocol_version", "encoding", "data", "retention"],
                                    "additionalProperties": False,
                                }
                            }
                        },
                    },
                    "responses": {
                        "201": ok("Stored payload reference", ref("payload-ref")),
                        "413": err_response("Request too large (REQUEST_TOO_LARGE)"),
                    },
                },
            },
            "/actions": {
                "post": {
                    "tags": ["action"],
                    "operationId": "proposeAction",
                    "summary": "Propose an Action from an ActionIntent",
                    "description": (
                        "Persists durable intent before any external callback. Principal and workspace "
                        "come from the authenticated context, never from the payload. A repeated "
                        "submission_key with an identical canonical request re-attaches to the existing "
                        "Action (PROT-031)."
                    ),
                    "parameters": CREATE_HEADERS,
                    "requestBody": {
                        "required": True,
                        "content": {"application/json": {"schema": ref("action-intent")}},
                    },
                    "responses": {
                        "201": ok("Proposed Action snapshot", ref("action-snapshot")),
                        "400": err_response("Validation error"),
                        "409": err_response("Conflicting submission (CONFLICTING_SUBMISSION)"),
                    },
                },
                "get": {
                    "tags": ["action"],
                    "operationId": "listActions",
                    "summary": "List Actions of a Run (query: run_id)",
                    "parameters": [
                        {"name": "run_id", "in": "query", "required": True, "schema": {"type": "string"}}
                    ],
                    "responses": {
                        "200": ok(
                            "Action snapshots",
                            {
                                "type": "object",
                                "properties": {
                                    "actions": {"type": "array", "items": ref("action-snapshot")}
                                },
                                "required": ["actions"],
                                "additionalProperties": False,
                            },
                        ),
                    },
                },
            },
            "/actions/{action_id}": {
                "get": {
                    "tags": ["action"],
                    "operationId": "getAction",
                    "summary": "Read an Action snapshot",
                    "parameters": [
                        {"name": "action_id", "in": "path", "required": True, "schema": {"type": "string"}}
                    ],
                    "responses": {
                        "200": ok("Action snapshot", ref("action-snapshot")),
                        "404": err_response("Not found"),
                    },
                },
            },
            "/actions/{action_id}/attempts": {
                "post": {
                    "tags": ["attempt"],
                    "operationId": "prepareAttempt",
                    "summary": "Prepare an Attempt (prepared)",
                    "parameters": [
                        {"name": "action_id", "in": "path", "required": True, "schema": {"type": "string"}},
                        *CREATE_HEADERS,
                    ],
                    "responses": {
                        "201": ok("Prepared Attempt", ref("action-attempt")),
                        "409": err_response("Illegal transition or revision mismatch (ILLEGAL_TRANSITION / LEASE_CONFLICT)"),
                    },
                },
                "get": {
                    "tags": ["attempt"],
                    "operationId": "listAttempts",
                    "summary": "List Attempts of an Action",
                    "parameters": [
                        {"name": "action_id", "in": "path", "required": True, "schema": {"type": "string"}}
                    ],
                    "responses": {
                        "200": ok(
                            "Attempts",
                            {
                                "type": "object",
                                "properties": {
                                    "attempts": {"type": "array", "items": ref("action-attempt")}
                                },
                                "required": ["attempts"],
                                "additionalProperties": False,
                            },
                        ),
                    },
                },
            },
            "/attempts/{attempt_id}/grant": {
                "post": {
                    "tags": ["attempt"],
                    "operationId": "issueGrant",
                    "summary": "Issue a single-use DispatchGrant (prepared -> dispatch_authorized)",
                    "description": "Inline flow: the SDK executes the callback only after receiving this grant. The grant binds payload, destination, policy, redaction rule version, scope, revision, and expiry.",
                    "parameters": [
                        {"name": "attempt_id", "in": "path", "required": True, "schema": {"type": "string"}},
                        *COMMAND_HEADERS,
                    ],
                    "responses": {
                        "201": ok("Dispatch grant", ref("dispatch-grant")),
                        "409": err_response("Illegal transition / approval invalid / lease conflict"),
                    },
                },
            },
            "/attempts/{attempt_id}/ack": {
                "post": {
                    "tags": ["attempt"],
                    "operationId": "acknowledgeAttempt",
                    "summary": "Persist an authoritative acknowledgement (dispatch_authorized -> acknowledged)",
                    "description": "If a grant may have been used but no authoritative acknowledgement is persisted before expiry, the Attempt becomes unknown (PROT-013).",
                    "parameters": [
                        {"name": "attempt_id", "in": "path", "required": True, "schema": {"type": "string"}},
                        *COMMAND_HEADERS,
                    ],
                    "responses": {
                        "200": ok("Acknowledged Attempt", ref("action-attempt")),
                        "409": err_response("Illegal transition / grant expired"),
                    },
                },
            },
            "/attempts/{attempt_id}/receipts": {
                "post": {
                    "tags": ["attempt"],
                    "operationId": "recordReceipt",
                    "summary": "Record an ExternalReceipt (additive evidence)",
                    "description": "HTTP 2xx and provider request IDs are advisory unless the adapter contract proves stronger semantics (PROT-028). Only authoritative completion or failure may resolve an executing or unknown Action (PROT-029).",
                    "parameters": [
                        {"name": "attempt_id", "in": "path", "required": True, "schema": {"type": "string"}},
                        *COMMAND_HEADERS,
                    ],
                    "requestBody": {
                        "required": True,
                        "content": {"application/json": {"schema": ref("external-receipt")}},
                    },
                    "responses": {
                        "201": ok("Recorded receipt", ref("external-receipt")),
                        "400": err_response("Validation error"),
                    },
                },
                "get": {
                    "tags": ["attempt"],
                    "operationId": "listReceipts",
                    "summary": "List receipts of an Attempt",
                    "parameters": [
                        {"name": "attempt_id", "in": "path", "required": True, "schema": {"type": "string"}}
                    ],
                    "responses": {
                        "200": ok(
                            "Receipts",
                            {
                                "type": "object",
                                "properties": {
                                    "receipts": {"type": "array", "items": ref("external-receipt")}
                                },
                                "required": ["receipts"],
                                "additionalProperties": False,
                            },
                        ),
                    },
                },
            },
            "/attempts/{attempt_id}/outcome": {
                "post": {
                    "tags": ["attempt"],
                    "operationId": "submitOutcome",
                    "summary": "Submit authoritative outcome evidence (reconciliation result)",
                    "description": "Resolves unknown_outcome only with authoritative evidence. Returns the updated Action snapshot; the Action transitions via reconcile_committed / reconcile_failed (PROT-015, PROT-029).",
                    "parameters": [
                        {"name": "attempt_id", "in": "path", "required": True, "schema": {"type": "string"}},
                        *COMMAND_HEADERS,
                    ],
                    "requestBody": {
                        "required": True,
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "protocol_version": {"const": "0.1"},
                                        "receipt": ref("external-receipt"),
                                        "evidence_refs": {
                                            "type": "array",
                                            "items": {"type": "string"},
                                            "uniqueItems": True,
                                        },
                                    },
                                    "required": ["protocol_version", "receipt"],
                                    "additionalProperties": False,
                                }
                            }
                        },
                    },
                    "responses": {
                        "200": ok("Updated Action snapshot", ref("action-snapshot")),
                        "400": err_response("Advisory receipt cannot resolve an effect (validation error)"),
                        "409": err_response("Illegal transition / lease conflict"),
                    },
                },
            },
            "/actions/{action_id}/approval-requests": {
                "post": {
                    "tags": ["approval"],
                    "operationId": "requestApproval",
                    "summary": "Open an approval request (approve_then_egress mode)",
                    "description": "Creates an ApprovalBinding in status pending-before-decision; the binding is sealed to the exact canonical payload hash, destination, policy version, redaction rule version, scope, revision, and expiry.",
                    "parameters": [
                        {"name": "action_id", "in": "path", "required": True, "schema": {"type": "string"}},
                        *CREATE_HEADERS,
                    ],
                    "requestBody": {
                        "required": True,
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "protocol_version": {"const": "0.1"},
                                        "expires_at": {"$ref": "#/components/schemas/_defs/$defs/Timestamp"},
                                    },
                                    "required": ["protocol_version", "expires_at"],
                                    "additionalProperties": False,
                                }
                            }
                        },
                    },
                    "responses": {
                        "201": ok("Approval binding created", ref("approval-binding")),
                        "400": err_response("Not an approve_then_egress action"),
                    },
                },
            },
            "/approvals/{approval_id}/decide": {
                "post": {
                    "tags": ["approval"],
                    "operationId": "decideApproval",
                    "summary": "Approve or reject the bound approval",
                    "description": "Any binding mismatch (payload, destination, policy, scope, revision, expiry) invalidates the approval and requires re-evaluation.",
                    "parameters": [
                        {"name": "approval_id", "in": "path", "required": True, "schema": {"type": "string"}},
                        *COMMAND_HEADERS,
                    ],
                    "requestBody": {
                        "required": True,
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "protocol_version": {"const": "0.1"},
                                        "decision": {"enum": ["approve", "reject"]},
                                        "reason": {"type": "string", "maxLength": 512},
                                    },
                                    "required": ["protocol_version", "decision"],
                                    "additionalProperties": False,
                                }
                            }
                        },
                    },
                    "responses": {
                        "200": ok("Decided approval binding", ref("approval-binding")),
                        "409": err_response("Expired or superseded approval (APPROVAL_INVALID)"),
                    },
                },
            },
            "/ingress": {
                "post": {
                    "tags": ["ingress"],
                    "operationId": "submitIngress",
                    "summary": "Submit an ingress review finding",
                    "description": "clean -> accepted, suspicious/malicious -> quarantined, reviewer unavailable -> review_unavailable (fail closed in governed production). Content is never an Agent observation before accepted.",
                    "parameters": COMMAND_HEADERS,
                    "requestBody": {
                        "required": True,
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "protocol_version": {"const": "0.1"},
                                        "action_id": {"type": "string"},
                                        "attempt_id": {"type": "string"},
                                        "verdict": {"enum": ["clean", "suspicious", "malicious", "review_unavailable"]},
                                        "findings": {"type": "array", "items": {"type": "object"}},
                                        "reviewer_mode": {"enum": ["in_process", "remote", "manual"]},
                                    },
                                    "required": ["protocol_version", "action_id", "attempt_id", "verdict", "reviewer_mode"],
                                    "additionalProperties": False,
                                }
                            }
                        },
                    },
                    "responses": {
                        "201": ok("Ingress finding", ref("ingress-finding")),
                        "503": err_response("Ingress review unavailable (INGRESS_REVIEW_UNAVAILABLE)"),
                    },
                },
            },
            "/ingress/{ingress_id}/resolve": {
                "post": {
                    "tags": ["ingress"],
                    "operationId": "resolveIngress",
                    "summary": "Resolve a quarantined finding (quarantined -> accepted | rejected)",
                    "parameters": [
                        {"name": "ingress_id", "in": "path", "required": True, "schema": {"type": "string"}},
                        *COMMAND_HEADERS,
                    ],
                    "requestBody": {
                        "required": True,
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "protocol_version": {"const": "0.1"},
                                        "decision": {"enum": ["accept", "reject"]},
                                        "reason": {"type": "string", "maxLength": 512},
                                    },
                                    "required": ["protocol_version", "decision"],
                                    "additionalProperties": False,
                                }
                            }
                        },
                    },
                    "responses": {
                        "200": ok("Resolved ingress finding", ref("ingress-finding")),
                        "409": err_response("Not quarantined (ILLEGAL_TRANSITION)"),
                    },
                },
            },
            "/actions/{action_id}/recovery": {
                "post": {
                    "tags": ["recovery"],
                    "operationId": "proposeRecovery",
                    "summary": "Propose a RecoveryDecision",
                    "description": "decisions: reconcile | retry_with_same_key | compensate | manual_review | stop. Every decision requires evidence refs, actor, revision, lease token, and reason. Uncertainty is never retry authority.",
                    "parameters": [
                        {"name": "action_id", "in": "path", "required": True, "schema": {"type": "string"}},
                        *COMMAND_HEADERS,
                    ],
                    "requestBody": {
                        "required": True,
                        "content": {"application/json": {"schema": ref("recovery-decision")}},
                    },
                    "responses": {
                        "201": ok("Recovery decision recorded", ref("recovery-decision")),
                        "400": err_response("Unknown capability or unsupported recovery (UNKNOWN_CAPABILITY)"),
                    },
                },
            },
            "/recovery/{decision_id}": {
                "get": {
                    "tags": ["recovery"],
                    "operationId": "getRecovery",
                    "summary": "Read a RecoveryDecision",
                    "parameters": [
                        {"name": "decision_id", "in": "path", "required": True, "schema": {"type": "string"}}
                    ],
                    "responses": {
                        "200": ok("Recovery decision", ref("recovery-decision")),
                        "404": err_response("Not found"),
                    },
                },
            },
            "/recovery/{decision_id}/apply": {
                "post": {
                    "tags": ["recovery"],
                    "operationId": "applyRecovery",
                    "summary": "Apply a decided RecoveryDecision (decided -> executed)",
                    "description": "retry_with_same_key creates a NEW Attempt under the verified stable identity with a new recovery approval and a new dispatch grant bound to the original sanctioned payload (handbook §7.2, PROT-015).",
                    "parameters": [
                        {"name": "decision_id", "in": "path", "required": True, "schema": {"type": "string"}},
                        *COMMAND_HEADERS,
                    ],
                    "responses": {
                        "200": ok("Applied recovery decision", ref("recovery-decision")),
                        "409": err_response("Superseded / expired / lease conflict"),
                    },
                },
            },
            "/capabilities": {
                "post": {
                    "tags": ["capability"],
                    "operationId": "registerManifest",
                    "summary": "Register a CapabilityManifest",
                    "description": "A manifest claim never enables recovery until its conformance result is trusted by Edge (PROT-021). Unknown capability values are rejected with UNKNOWN_CAPABILITY.",
                    "parameters": CREATE_HEADERS,
                    "requestBody": {
                        "required": True,
                        "content": {"application/json": {"schema": ref("capability-manifest")}},
                    },
                    "responses": {
                        "201": ok("Registered manifest", ref("capability-manifest")),
                        "400": err_response("Unknown capability (UNKNOWN_CAPABILITY)"),
                    },
                },
            },
            "/capabilities/{manifest_id}": {
                "get": {
                    "tags": ["capability"],
                    "operationId": "getManifest",
                    "summary": "Read a CapabilityManifest",
                    "parameters": [
                        {"name": "manifest_id", "in": "path", "required": True, "schema": {"type": "string"}}
                    ],
                    "responses": {
                        "200": ok("Capability manifest", ref("capability-manifest")),
                        "404": err_response("Not found"),
                    },
                },
            },
            "/evidence/{action_id}": {
                "get": {
                    "tags": ["evidence"],
                    "operationId": "getEvidence",
                    "summary": "Expandable evidence packet for an Action",
                    "description": "Bounded metadata and hashes by default; raw secrets and sensitive payloads are excluded (PROT-027).",
                    "parameters": [
                        {"name": "action_id", "in": "path", "required": True, "schema": {"type": "string"}}
                    ],
                    "responses": {
                        "200": ok(
                            "Evidence packet",
                            {
                                "type": "object",
                                "properties": {
                                    "protocol_version": {"const": "0.1"},
                                    "action_id": {"type": "string"},
                                    "events": {"type": "array", "items": ref("audit-event")},
                                    "decisions": {"type": "array", "items": {"type": "object"}},
                                },
                                "required": ["protocol_version", "action_id", "events", "decisions"],
                                "additionalProperties": False,
                            },
                        ),
                        "404": err_response("Not found"),
                    },
                },
            },
            "/audit/verify": {
                "post": {
                    "tags": ["evidence"],
                    "operationId": "verifyAudit",
                    "summary": "Verify the hash-linked audit chain",
                    "description": "Without an expected or externally anchored head, a valid local chain does not prove tail events were never removed (ADR-010). Read-only: no command headers required.",
                    "requestBody": {
                        "required": True,
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "protocol_version": {"const": "0.1"},
                                        "run_id": {"type": "string"},
                                        "expected_head": {"$ref": "#/components/schemas/_defs/$defs/HashRef"},
                                    },
                                    "required": ["protocol_version", "run_id"],
                                    "additionalProperties": False,
                                }
                            }
                        },
                    },
                    "responses": {
                        "200": ok(
                            "Verification result",
                            {
                                "type": "object",
                                "properties": {
                                    "protocol_version": {"const": "0.1"},
                                    "chain_valid": {"type": "boolean"},
                                    "anchor": {"type": "string"},
                                    "verified_events": {"$ref": "#/components/schemas/_defs/$defs/SafeInteger"},
                                    "head_event_id": {"type": "string"},
                                },
                                "required": ["protocol_version", "chain_valid", "anchor", "verified_events", "head_event_id"],
                                "additionalProperties": False,
                            },
                        ),
                    },
                },
            },
        },
        "components": {
            "schemas": components,
            "parameters": {},
            "securitySchemes": {
                "edgeToken": {
                    "type": "http",
                    "scheme": "bearer",
                    "description": "Local Edge token. Loopback/Unix-socket deployments may use filesystem ownership instead (ADR-005).",
                },
            },
        },
        "security": [{"edgeToken": []}],
    }


def main() -> int:
    doc = build()
    yaml.add_representer(dict, lambda dumper, data: dumper.represent_mapping("tag:yaml.org,2002:map", data.items()))
    text = yaml.safe_dump(doc, sort_keys=False, allow_unicode=True, width=100)
    OUT.write_text(text, encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)} ({len(text)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
