#!/usr/bin/env bash
# Idempotent install for the Crypsor Cloud Agent environment.
# - Installs PostgreSQL (system dependency) once.
# - Initializes a local, user-owned Postgres data directory.
# - Installs pnpm workspace dependencies.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGDATA="${CRYPSOR_PGDATA:-$HOME/.local/share/crypsor/pgdata}"

echo "==> [install] Ensuring PostgreSQL is installed"
if ! ls /usr/lib/postgresql/*/bin/pg_ctl >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
    postgresql postgresql-contrib
fi

PG_BIN="$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)"
echo "==> [install] Using PostgreSQL binaries at $PG_BIN"

echo "==> [install] Ensuring local Postgres cluster at $PGDATA"
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  mkdir -p "$PGDATA"
  # Trust auth on loopback only — this is an ephemeral local dev database.
  "$PG_BIN/initdb" --pgdata="$PGDATA" --username="$(whoami)" \
    --auth-local=trust --auth-host=trust --encoding=UTF8 >/dev/null
  {
    echo "listen_addresses = '127.0.0.1'"
    echo "port = 5432"
    echo "unix_socket_directories = '/tmp'"
  } >> "$PGDATA/postgresql.conf"
fi

echo "==> [install] Pinning pnpm 10.33.3 (honors onlyBuiltDependencies)"
# The repo relies on pnpm 10's onlyBuiltDependencies (esbuild, etc.). Newer
# pnpm majors treat ignored build scripts as a hard error, so pin explicitly.
corepack prepare pnpm@10.33.3 --activate
hash -r

echo "==> [install] Installing pnpm dependencies"
cd "$REPO_ROOT"
# Mirror vercel.json's installCommand: the committed lockfile intentionally
# lags package.json (a removed root dep), so a frozen install is not used.
# CI=true lets pnpm reconcile a non-matching modules dir without a TTY prompt.
CI=true pnpm install --no-frozen-lockfile

echo "==> [install] Done"
