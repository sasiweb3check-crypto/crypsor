#!/usr/bin/env bash
# Per-boot startup for the Crypsor Cloud Agent environment.
# Starts the local Postgres server (idempotently) and ensures the
# application database exists. Returns once Postgres is ready; the API
# and web dev servers run as separate terminals.
set -euo pipefail

PGDATA="${CRYPSOR_PGDATA:-$HOME/.local/share/crypsor/pgdata}"
PG_PORT="${CRYPSOR_PG_PORT:-5432}"
PG_DB="${CRYPSOR_PG_DB:-crypsor}"
PG_LOG="$(dirname "$PGDATA")/postgres.log"

PG_BIN="$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)"

echo "==> [start] Ensuring Postgres is running on 127.0.0.1:$PG_PORT"
if ! "$PG_BIN/pg_ctl" --pgdata="$PGDATA" status >/dev/null 2>&1; then
  "$PG_BIN/pg_ctl" --pgdata="$PGDATA" --log="$PG_LOG" \
    --options="-p $PG_PORT" --wait start
fi

echo "==> [start] Waiting for Postgres readiness"
for _ in $(seq 1 30); do
  if "$PG_BIN/pg_isready" -h 127.0.0.1 -p "$PG_PORT" -q; then break; fi
  sleep 1
done
"$PG_BIN/pg_isready" -h 127.0.0.1 -p "$PG_PORT"

echo "==> [start] Ensuring database '$PG_DB' exists"
if ! "$PG_BIN/psql" -h 127.0.0.1 -p "$PG_PORT" -U "$(whoami)" -d postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname='$PG_DB'" | grep -q 1; then
  "$PG_BIN/createdb" -h 127.0.0.1 -p "$PG_PORT" -U "$(whoami)" "$PG_DB"
fi

echo "==> [start] Postgres ready"
