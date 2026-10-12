"""Fresh local PostgreSQL 17 only; generated fixture key/assets; never production data."""
import os, pathlib, subprocess, tempfile, json, shutil, sys
root = pathlib.Path(__file__).resolve().parents[2]
pg = pathlib.Path(os.environ.get('DISPATCH_TEST_PG_BIN', str(pathlib.Path(shutil.which('pg_ctl') or '/missing-postgresql/pg_ctl').parent)))
node = shutil.which('node')
base = pathlib.Path(tempfile.mkdtemp(prefix='dispatch-b2-')); base.chmod(0o700)
env = {'PATH': str(pg) + ':' + str(pathlib.Path(node).parent) + ':/usr/bin:/bin', 'LC_ALL': 'C',
       'DISPATCH_MODE': 'local', 'DISPATCH_DB_HOST': str(base), 'DISPATCH_DB_PORT': '55442'}
started = False
output_parent = root / '.local/test-results'
output_parent.mkdir(parents=True, exist_ok=True)
output = pathlib.Path(tempfile.mkdtemp(prefix='postgres-', dir=output_parent))
def run(args, **kw):
    return subprocess.run([str(x) for x in args], cwd=root, env=env, check=True, **kw)
def sql(database, text):
    run([pg/'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-h', base, '-p', '55442', '-U', 'fixture_admin', '-d', database], input=text, text=True, stdout=subprocess.DEVNULL)
def start():
    run([pg/'pg_ctl', '-D', base/'data', '-l', base/'server.log', '-o', f"-k {base} -p 55442 -c listen_addresses='' -c fsync=on -c synchronous_commit=on -c log_error_verbosity=terse -c log_min_error_statement=panic -c log_parameter_max_length=0 -c log_parameter_max_length_on_error=0", '-w', 'start'], stdout=subprocess.DEVNULL)
def stop():
    run([pg/'pg_ctl', '-D', base/'data', '-m', 'immediate', '-w', 'stop'], stdout=subprocess.DEVNULL)
try:
    version = subprocess.check_output([str(pg/'postgres'), '--version'], text=True).strip()
    assert version.startswith('postgres (PostgreSQL) 17.'), version
    run([pg/'initdb', '-D', base/'data', '-U', 'fixture_admin', '--auth-local=trust', '--auth-host=reject', '--no-locale'], stdout=subprocess.DEVNULL)
    start(); started = True
    sql('postgres', 'CREATE DATABASE dispatch; CREATE DATABASE upgrade; CREATE DATABASE conflict;')
    sql('dispatch', (root/'db/bootstrap.sql').read_text() + (root/'infra/local-logins.sql').read_text())
    for database in ['upgrade', 'conflict']:
        sql(database, f'CREATE SCHEMA dispatch AUTHORIZATION dispatch_migrator; REVOKE ALL ON SCHEMA public FROM PUBLIC; REVOKE ALL ON SCHEMA dispatch FROM PUBLIC; REVOKE CREATE,TEMPORARY ON DATABASE {database} FROM PUBLIC;')
    (base/'fixture.key').write_bytes(os.urandom(32)); (base/'fixture.key').chmod(0o600)
    (base/'assets').mkdir(); (base/'assets/fixture.txt').write_bytes(b'fixture-asset'); (base/'assets/manifest').write_bytes(b'fixture-manifest')
    print(json.dumps({'PostgreSQL': version, 'socket_only': True, 'fsync': True,
        'real_service_roles': True, 'evidence_directory': str(output)}), flush=True)
    run([node, '--test', '--test-isolation=none', '--test-reporter=tap', 'tests/payment/reorg-regression.test.mjs'], timeout=60)
    assert b'SYNTHETIC-DB-ERROR-CANARY' not in (base/'server.log').read_bytes(), 'database log leaked canary'
    shutil.copyfile(base/'evm-public-evidence.json', output/'evm-public-evidence.json')
    before = run([node, 'scripts/payment-recovery.mjs'], capture_output=True, text=True).stdout
    stop(); started = False; start(); started = True
    after = run([node, 'scripts/payment-recovery.mjs'], capture_output=True, text=True).stdout
    assert before == after, 'restart data changed'
    run([pg/'pg_dump', '-h', base, '-p', '55442', '-U', 'fixture_admin', '-d', 'dispatch', '-Fc', '-f', base/'fixture.dump'])
    backup = base/'backup'; backup.mkdir(); shutil.copytree(base/'assets', backup/'assets'); shutil.copyfile(base/'fixture.key', backup/'fixture.key')
    # Restore matching assets/key from the independent backup, not from the originals.
    shutil.rmtree(base/'assets'); (base/'fixture.key').unlink()
    shutil.copytree(backup/'assets', base/'assets'); shutil.copyfile(backup/'fixture.key', base/'fixture.key')
    sql('postgres', 'CREATE DATABASE restored; REVOKE CREATE,TEMPORARY ON DATABASE restored FROM PUBLIC;')
    run([pg/'pg_restore', '-h', base, '-p', '55442', '-U', 'fixture_admin', '-d', 'restored', '--exit-on-error', base/'fixture.dump'])
    restored = run([node, 'scripts/payment-recovery.mjs', 'restored'], capture_output=True, text=True).stdout
    assert after == restored, 'restore data changed'
    recovery = {'immediate_restart': 'passed', 'isolated_dump_restore': 'passed', 'synthetic_key_asset_restore': 'passed', 'rows': json.loads(after), 'production_restore': 'not_run'}
    (output/'recovery.json').write_text(json.dumps(recovery, indent=2)+'\n')
    print(json.dumps(recovery), flush=True)
finally:
    if (base/'evm-public-evidence.json').exists(): shutil.copyfile(base/'evm-public-evidence.json', output/'evm-public-evidence.json')
    if started: stop()
    shutil.rmtree(base)
