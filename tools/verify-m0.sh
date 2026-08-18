#!/usr/bin/env bash
# Ogra M0 Protocol Freeze — single repeatable verification command.
#
# Verification:
#   1. Bootstrap pins Python dependencies, runs the offline first-repair
#      regression, and enforces the TypeScript lockfile.
#   2. Python and TypeScript validators pass every golden vector and emit
#      identical PASS/FAIL verdicts.
#   3. gates.py passes all eight M0 exit gates: meta-schema, OpenAPI load +
#      drift, OpenAPI headers, receipt-resolution binding, schema purity,
#      markdown links, no automatic replay, and file format.
#   4. git diff --check reports no whitespace or conflict-marker errors.
#
# Bootstrap is idempotent: creates the project venv and npm modules when
# missing. Requires: python3 (venv module), node >= 23, npm.
#
# Usage: tools/verify-m0.sh
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY_DIR="$ROOT/tools/validators/python"
TS_DIR="$ROOT/tools/validators/typescript"
VENV="$PY_DIR/.venv"
PY="$VENV/bin/python"
FAILED=0

step() { printf '\n== %s ==\n' "$1"; }
ok() { printf 'VERIFY_PASS %s\n' "$1"; }
bad() { printf 'VERIFY_FAIL %s\n' "$1"; FAILED=1; }

step "bootstrap"
if [ ! -x "$PY" ]; then
  echo "creating python venv..."
  python3 -m venv "$VENV" || { bad "venv-create"; exit 1; }
fi
# Enforce the DECLARED dependency versions even when the venv already exists
# (P2-4 round 2: pins must not silently drift).
if ! "$PY" "$PY_DIR/ensure_deps.py"; then
  bad "python-deps"
  exit 1
fi
if ! "$PY" "$PY_DIR/test_ensure_deps.py"; then
  bad "ensure-deps-regression"
  exit 1
fi
ok "ensure-deps-regression"
# npm ci enforces the lockfile (declared versions) every run (P2-4 round 2).
echo "installing npm modules (npm ci)..."
(cd "$TS_DIR" && npm ci --no-fund --no-audit) || { bad "npm-ci"; exit 1; }

step "python vectors"
PY_OUT="$("$PY" "$PY_DIR/run_vectors.py" 2>&1)"; PY_RC=$?
echo "$PY_OUT" | tail -n 5
if [ $PY_RC -ne 0 ] || ! echo "$PY_OUT" | grep -q 'SUMMARY vectors=[0-9]* passed=[0-9]* failed=0'; then
  bad "python-vectors"
else
  ok "python-vectors"
fi

step "typescript vectors"
TS_OUT="$(cd "$TS_DIR" && node run_vectors.ts 2>&1)"; TS_RC=$?
echo "$TS_OUT" | tail -n 5
if [ $TS_RC -ne 0 ] || ! echo "$TS_OUT" | grep -q 'SUMMARY vectors=[0-9]* passed=[0-9]* failed=0'; then
  bad "typescript-vectors"
else
  ok "typescript-vectors"
fi

step "cross-language verdict agreement"
verdicts() { echo "$1" | grep -E '^(PASS|FAIL) ' | awk '{print $1, $2}'; }
if diff <(verdicts "$PY_OUT") <(verdicts "$TS_OUT") >/dev/null; then
  ok "cross-language-agreement"
else
  bad "cross-language-agreement"
  diff <(verdicts "$PY_OUT") <(verdicts "$TS_OUT") | head -n 20
fi

step "exit gates (8: meta-schema / openapi-drift / headers / receipt-binding / purity / links / no-auto-replay / format)"
GATES_OUT="$(cd "$PY_DIR" && "$PY" gates.py 2>&1)"; GATES_RC=$?
echo "$GATES_OUT" | grep -E 'GATE_|GATES'
if [ $GATES_RC -ne 0 ] || echo "$GATES_OUT" | grep -q 'GATE_FAIL'; then
  bad "exit-gates"
else
  ok "exit-gates"
fi

step "git diff --check"
if (cd "$ROOT" && git diff --check) >/dev/null 2>&1; then
  ok "git-diff-check"
else
  bad "git-diff-check"
  (cd "$ROOT" && git diff --check) | head -n 20
fi

step "summary"
if [ $FAILED -eq 0 ]; then
  echo "M0_EXIT_GATE PASS — all checks green"
  exit 0
else
  echo "M0_EXIT_GATE FAIL — $FAILED gate(s) failed"
  exit 1
fi
