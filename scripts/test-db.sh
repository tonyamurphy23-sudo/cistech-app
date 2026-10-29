#!/usr/bin/env bash
# Runs the migration and the access rule tests on a throwaway local Postgres.
# Needs Postgres 15+ binaries (initdb, pg_ctl, psql) on PATH or in PG_BIN.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-$(dirname "$(command -v initdb 2>/dev/null || ls -d /usr/lib/postgresql/*/bin/initdb | tail -1)")}"
data="$(mktemp -d)"
port="${PGPORT_TEST:-55432}"
run_pg() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
[ "$(id -u)" = 0 ] && chown postgres "$data"

cleanup() { run_pg "$PG_BIN/pg_ctl -D $data -m immediate stop" >/dev/null 2>&1 || true; rm -rf "$data"; }
trap cleanup EXIT

run_pg "$PG_BIN/initdb -D $data -U postgres --auth=trust" >/dev/null
run_pg "$PG_BIN/pg_ctl -D $data -o '-p $port -k /tmp' -w start" >/dev/null

psql_run() { psql -h /tmp -p "$port" -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
psql_run -f "$root/supabase/tests/auth_stub.sql"
for f in "$root"/supabase/migrations/*.sql; do psql_run -f "$f"; done
psql_run -t -f "$root/supabase/tests/rls_test.sql" 2>&1 | sed -e "s/^psql:[^ ]* NOTICE:  /  /" -e "/^\s*$/d"
