#!/bin/bash
# Build dsh-context-compactor: src/index.js -> lib/index.js + runtime peer junctions.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

node scripts/build.mjs

echo "=== Build complete ==="
ls -la lib/
