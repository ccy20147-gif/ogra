#!/bin/bash
# Pre-flight check for better-sqlite3 ABI compatibility.
#
# Tells you which ABI the .node file is currently compiled for
# (Node v137 or Electron v119) so you can pick the right npm script.
# Does NOT rebuild anything — read-only.
set -e
cd /www/code/ogra/ogra-desktop

NODE_MODULES_VERSION=$(node -p "process.versions.modules")
ABI_LABEL=""
case "$NODE_MODULES_VERSION" in
  137) ABI_LABEL="Node 24 / v137 ABI" ;;
  119) ABI_LABEL="Electron 28 (Node 18) / v119 ABI" ;;
  *)   ABI_LABEL="unknown (Node modules version $NODE_MODULES_VERSION)" ;;
esac

# Read the first 16 bytes of the .node and look for the Node ABI
# fingerprint. Node 24 produces 'v137' in the build id; Electron 28
# produces 'v119'. We grep the file as a binary blob.
DOTNODE=node_modules/better-sqlite3/build/Release/better_sqlite3.node
if [ -f "$DOTNODE" ]; then
  if python3 -c "
import sys
data = open('$DOTNODE','rb').read()
b = b'v' + b'$NODE_MODULES_VERSION'.lstrip(b'v')
sys.exit(0 if b in data else 1)
" 2>/dev/null; then
    BUILT_FOR="matches current Node ABI: $ABI_LABEL"
  else
    BUILT_FOR="MISMATCH (built for a different ABI than current $ABI_LABEL)"
  fi
  MD5=$(md5sum "$DOTNODE" 2>/dev/null | awk '{print $1}')
else
  BUILT_FOR="(file not found at $DOTNODE)"
  MD5="(none)"
fi

echo "Current runtime:    $ABI_LABEL"
echo "Prebuilt .node:     $BUILT_FOR"
echo "Prebuilt .node md5: $MD5"
echo
echo "Pick a script based on what you want to run:"
echo
echo "  vitest (Node ABI)  → npm run rebuild:sqlite:node && npm test"
echo "  electron (Electron ABI) → npm run rebuild:sqlite:electron && npm run dev:electron"
echo "  or, if you want to avoid the rebuild dance for one cycle:"
echo "    - run vitest first (leaves .node as Node ABI)"
echo "    - then npm run rebuild:sqlite:electron to switch to Electron ABI"
echo "    - then start electron (rebuild hook auto-runs)"
