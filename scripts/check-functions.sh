#!/usr/bin/env bash
# Type-checks the Supabase edge functions with tsc, using npm copies of their imports.
set -euo pipefail
fns="$(cd "$(dirname "$0")/../supabase/functions" && pwd)"
(cd "$fns/_check" && npm ci --silent)
ln -sfn "$fns/_check/node_modules" "$fns/node_modules"
trap 'rm -f "$fns/node_modules"' EXIT
npx --prefix "$fns/_check" tsc -p "$fns/_check/tsconfig.json"
echo "Edge functions type-check OK"
