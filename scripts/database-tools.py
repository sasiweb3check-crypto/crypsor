#!/usr/bin/env python3
"""Verified-TLS backup and isolated loopback restore drill. Never logs URLs."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from urllib.parse import urlparse, parse_qsl, unquote


def connection_environment(url):
    parsed = urlparse(url)
    if parsed.scheme not in ('postgres', 'postgresql') or not parsed.hostname:
        raise SystemExit('A PostgreSQL connection URL is required')
    environment = os.environ.copy()
    environment['PGHOST'] = parsed.hostname
    environment['PGPORT'] = str(parsed.port or 5432)
    environment['PGDATABASE'] = unquote(parsed.path.lstrip('/'))
    environment['PGUSER'] = unquote(parsed.username or '')
    environment['PGPASSWORD'] = unquote(parsed.password or '')
    if parsed.hostname not in ('localhost', '127.0.0.1', '::1'):
        environment['PGSSLMODE'] = 'verify-full'
    else:
        environment['PGSSLMODE'] = 'prefer'
    environment['PGCONNECT_TIMEOUT'] = '10'
    return environment


def run(arguments, environment, capture=False):
    # Error messages from libpq can contain hostnames, never echo credentials.
    result = subprocess.run(arguments, env=environment, capture_output=True, text=True)
    if result.returncode:
        raise SystemExit(f'{arguments[0]} failed (exit {result.returncode}); inspect connectivity, permissions and TLS settings')
    return result.stdout.strip() if capture else None


def summary(environment):
    tables = run(['psql', '-XAt', '-c', "SELECT tablename FROM pg_tables WHERE schemaname='hunter' ORDER BY tablename"], environment, True).splitlines()
    result = {}
    for name in tables:
        # Names came from our schema; quote identifiers even for later additions.
        safe_name = name.replace('"', '""')
        sql = f'''SELECT count(*) || ':' || md5(coalesce(string_agg(row_to_json(t)::text, '|' ORDER BY row_to_json(t)::text),'')) FROM hunter."{safe_name}" t'''
        result[name] = run(['psql', '-XAt', '-c', sql], environment, True)
    return result


def main():
    url = os.environ.get('AIVEN_DATABASE_URL') or os.environ.get('DATABASE_URL')
    if not url:
        raise SystemExit('Set DATABASE_URL or AIVEN_DATABASE_URL securely')
    directory = Path(os.environ.get('HUNTER_BACKUP_DIR', '/workspace/hunter-backups'))
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as temporary:
        source = connection_environment(url)
        if os.environ.get('AIVEN_CA_CERT'):
            certificate = Path(temporary) / 'aiven-ca.pem'
            certificate.write_text(os.environ['AIVEN_CA_CERT'].replace('\\n', '\n'))
            certificate.chmod(0o600)
            source['PGSSLROOTCERT'] = str(certificate)
        if sys.argv[1:] == ['restore-drill']:
            target_url = os.environ.get('RESTORE_DATABASE_URL', 'postgresql://postgres@127.0.0.1:5432/hunter_restore_test')
            target = urlparse(target_url)
            if target.hostname not in ('127.0.0.1', 'localhost') or target.path != '/hunter_restore_test':
                raise SystemExit('Restore target must be the isolated loopback database hunter_restore_test')
            if target_url == url:
                raise SystemExit('Source and restore target must differ')
            destination = connection_environment(target_url)
            dump = str(Path(temporary) / 'hunter.dump')
            before = summary(source)
            run(['pg_dump', '--schema=hunter', '--no-owner', '--no-acl', '-Fc', '-f', dump], source)
            run(['psql', '-X', '-v', 'ON_ERROR_STOP=1', '-c', 'DROP SCHEMA IF EXISTS hunter CASCADE'], destination)
            run(['pg_restore', '--no-owner', '--no-acl', '--exit-on-error', '-d', destination['PGDATABASE'], dump], destination)
            after = summary(destination)
            if before != after:
                raise SystemExit('Restore content comparison failed; run drill with source writes paused')
            print(json.dumps({'restore_verified': True, 'tables': len(after), 'comparison': 'row counts and content fingerprints', 'target': 'hunter_restore_test'}))
        else:
            from datetime import datetime, timezone
            dump = directory / ('hunter-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '.dump')
            run(['pg_dump', '--schema=hunter', '--no-owner', '--no-acl', '-Fc', '-f', str(dump)], source)
            dump.chmod(0o600)
            run(['pg_restore', '--list', str(dump)], source)
            print(f'Backup created and archive structure checked: {dump}')


if __name__ == '__main__':
    main()
