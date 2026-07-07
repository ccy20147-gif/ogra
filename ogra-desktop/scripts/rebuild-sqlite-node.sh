#!/bin/bash
# Rebuild better-sqlite3 against the current Node version (v137 for
# Node 24.18.0). This is needed because:
#
#   - better-sqlite3 11.10.0 has prebuilds for Node 18, 20, 22 but
#     NOT for Node 24. We installed it for the team's actual Node
#     24.18.0 runtime, so prebuild-install falls back to from-source
#     compile. That compile takes 3-5 minutes on a typical laptop and
#     much longer in resource-constrained containers.
#   - If you just switched from an electron session (which leaves the
#     .node compiled for v119), you need to recompile for v137 to run
#     vitest. Same in reverse.
#
# Strategy:
#   1. Try prebuild-install first (fast, no-op if already on the right ABI).
#   2. Fall back to from-source compile. Report elapsed time so the user
#      knows when it's done.
#   3. If the compile fails (missing gyp deps, etc.), print a single
#      actionable error instead of dumping a 200-line gyp trace.
#
# Pre-flight check: see scripts/check-sqlite-abi.sh to see which ABI
# the .node is currently compiled for before running this.
set -e
cd /www/code/ogra/ogra-desktop

TARGET_ABI=$(node -p "process.versions.modules")
echo "[rebuild-sqlite-node] target ABI: $TARGET_ABI (Node $(node -p "process.versions.node"))"
echo

# Step 1: try prebuilt (Node 18 / 20 / 22 binaries — no-op for 24)
pushd node_modules/better-sqlite3 > /dev/null
if npx prebuild-install 2>&1 | tee /tmp/.prebuild-install.log; then
  if [ -f build/Release/better_sqlite3.node ]; then
    popd > /dev/null
    echo "[rebuild-sqlite-node] prebuild-install succeeded"
    exit 0
  fi
fi
popd > /dev/null

# Step 2: from-source compile
echo
echo "[rebuild-sqlite-node] prebuild-install did not produce a .node — falling back to from-source compile"
echo "[rebuild-sqlite-node] this typically takes 3-5 minutes; please be patient"
START=$(date +%s)
pushd node_modules/better-sqlite3 > /dev/null
if npx node-gyp rebuild --release; then
  ELAPSED=$(($(date +%s) - START))
  if [ -f build/Release/better_sqlite3.node ]; then
    popd > /dev/null
    echo
    echo "[rebuild-sqlite-node] from-source compile succeeded in ${ELAPSED}s"
    exit 0
  fi
fi
popd > /dev/null

# Step 3: actionable error
echo
echo "[rebuild-sqlite-node] from-source compile FAILED" >&2
echo "[rebuild-sqlite-node] common causes:" >&2
echo "  - missing python3 / gcc / make (apt install build-essential python3)" >&2
echo "  - missing node-gyp (npm install -g node-gyp)" >&2
echo "  - linux: missing libsqlite3-dev (apt install libsqlite3-dev)" >&2
echo >&2
echo "[rebuild-sqlite-node] if you can't compile, downgrade Node to 22.x (which has prebuilds for 11.10.0)" >&2
exit 1
