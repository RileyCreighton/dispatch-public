"""Real PostgreSQL regression for checked-out connection failure; disposable only."""
import os, pathlib, shutil, subprocess, tempfile
root = pathlib.Path(__file__).resolve().parents[1]
pg = pathlib.Path(os.environ.get('DISPATCH_TEST_PG_BIN', str(pathlib.Path(shutil.which('pg_ctl') or '/missing/pg_ctl').parent)))
base = pathlib.Path(tempfile.mkdtemp(prefix='dispatch-b2-')); base.chmod(0o700)
out = root / '.local/test-results'; out.mkdir(parents=True, exist_ok=True)
out = pathlib.Path(tempfile.mkdtemp(prefix='transaction-', dir=out))
env = {'PATH': os.environ['PATH'], 'LC_ALL': 'C', 'DISPATCH_MODE': 'local', 'DISPATCH_DB_HOST': str(base), 'DISPATCH_DB_PORT': '55442'}
started = False
def run(args, **kw):
    return subprocess.run([str(x) for x in args], cwd=root, env=env, check=True, **kw)
try:
    run([pg/'initdb', '-D', base/'data', '-U', 'fixture_admin', '--auth-local=trust', '--auth-host=reject', '--no-locale'], stdout=subprocess.DEVNULL)
    run([pg/'pg_ctl', '-D', base/'data', '-l', base/'server.log', '-o', f"-k {base} -p 55442 -c listen_addresses='' -c fsync=on -c log_error_verbosity=terse -c log_min_error_statement=panic", '-w', 'start'], stdout=subprocess.DEVNULL); started = True
    run([pg/'psql', '-X', '-h', base, '-p', '55442', '-U', 'fixture_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE DATABASE dispatch'], stdout=subprocess.DEVNULL)
    run([pg/'psql', '-X', '-h', base, '-p', '55442', '-U', 'fixture_admin', '-d', 'dispatch', '-v', 'ON_ERROR_STOP=1'], input=(root/'db/bootstrap.sql').read_bytes()+(root/'infra/local-logins.sql').read_bytes(), stdout=subprocess.DEVNULL)
    run(['node', '--test', '--test-isolation=none', '--test-reporter=tap', 'tests/foundation/transaction-lifecycle.test.mjs'], timeout=60)
finally:
    if started: run([pg/'pg_ctl', '-D', base/'data', '-m', 'immediate', '-w', 'stop'], stdout=subprocess.DEVNULL)
    if (base/'server.log').exists(): shutil.copyfile(base/'server.log', out/'postgres.log')
    shutil.rmtree(base)
    print('Private transaction evidence: ' + str(out), flush=True)
