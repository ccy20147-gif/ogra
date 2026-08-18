# ADR-005: Discovery, Locking, Local Authentication, and Production Fail-Closed

- **Status**: Accepted
- **Date**: 2026-08-17
- **Applies to**: M0 Protocol Freeze; M3 Python SDK and Runtime Discovery
- **Related**: handbook §3.2, §4.1, §5.4; quickstart contract §3

## Context

The SDK must connect in development without configuration (auto-start one
local Edge) while production must never silently fall back to an in-process
or development runtime. Local transport needs a trust boundary that is honest
about being local.

## Decision

1. **Discovery order** (quickstart §3): explicit `OGRA_ENDPOINT` and
   credentials → reuse a healthy daemon registered for the selected data
   directory → development auto-start under a file lock → fail with a
   specific diagnostic. Production mode never silently falls back.
2. **Single-start locking**: a file lock in the persistent data directory
   guards daemon startup; the registry records PID, endpoint/socket, data
   directory, protocol version, health, and migration state. Stale PID
   handling and migration-safety checks are explicit M3 tests.
3. **Local authentication**: the development daemon binds loopback or a
   Unix domain socket with filesystem ownership as the base trust; a per-data-
   directory token is supported for loopback TCP. This is a process
   convenience boundary, explicitly not a hardened isolation claim
   (isolation profile stays `development`).
4. **Principal binding**: principal and workspace are ALWAYS taken from the
   authenticated server context, never from client payloads. Protocol
   objects (ActionIntent, RunRef) carry no client-declared owner/scope fields;
   any client-supplied identity is treated as unverified metadata. This
   implements the security invariant that in-graph fields cannot be used as
   authorization evidence.
5. **Fail-closed**: protocol mismatch, unhealthy daemon, unsafe migration, or
   missing credentials in production mode produce typed errors
   (PROTOCOL_MAJOR_MISMATCH / PROTOCOL_MINOR_MISMATCH / UNAVAILABLE), never a
   silent in-process fallback.

## Alternatives

- **No local auth (trust the socket)**: rejected for loopback TCP; the token
  is cheap and prevents accidental cross-user access on shared hosts.
- **Client-declared principal**: rejected — a P0 finding class; forged
  `owner_scope`/role fields in client payloads are attack vectors, and every
  authorization decision must bind to canonical server-side records.
- **Auto-start in production**: rejected — production requires explicit
  endpoint, credentials, lifecycle ownership, and health policy.

## Consequences

- Positive: five-minute development experience without weakening production;
  authorization decisions are server-bound by construction; the wire protocol
  cannot be used to forge scope.
- Negative: development auto-start must implement locking, PID reuse
  detection, and migration preflight before M3 can ship; loopback TCP
  deployments need token distribution.
