"""One-command, disposable native developer walkthrough. No container or production configuration."""
import fcntl
import hashlib
import json
import os
import pathlib
import platform
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time

root = pathlib.Path(__file__).resolve().parents[1]
os.umask(0o077)
if any(arg not in ['--headed'] for arg in sys.argv[1:]) or len(sys.argv) > 2:
    sys.exit('Usage: ./scripts/demo.sh local [--headed]')
local = root / '.local'
local.mkdir(exist_ok=True)
output_parent = local / 'test-results'
output_parent.mkdir(exist_ok=True)
out = pathlib.Path(tempfile.mkdtemp(prefix='local-demo-', dir=output_parent))
print('Dispatch local developer demo — synthetic local funds; mainnet disabled.', flush=True)
print('Private results: ' + str(out), flush=True)
base = None
started = False
child = None
pg = None
interrupted = False

def progress(message):
    print(message, flush=True)

def run(args, *, env=None, name='setup', **kwargs):
    with (out / (name + '.log')).open('ab') as log:
        result = subprocess.run([str(x) for x in args], cwd=root, env=env,
                                stdout=log, stderr=subprocess.STDOUT, **kwargs)
    if result.returncode:
        raise RuntimeError(name + ' failed; private diagnostic: ' + str(out / (name + '.log')))

def version(args):
    return subprocess.check_output(args, text=True, stderr=subprocess.DEVNULL).strip()

try:
    if platform.system() != 'Linux' or platform.machine() != 'x86_64':
        raise RuntimeError('Native demo currently requires Linux x86_64.')
    if sys.version_info < (3, 12):
        raise RuntimeError('Python 3.12+ is required.')
    if os.geteuid() == 0:
        raise RuntimeError('Run as an ordinary user; PostgreSQL must not run as root.')
    for command in ['node', 'npm', 'openssl', 'certutil']:
        if not shutil.which(command):
            raise RuntimeError('Install prerequisite: ' + command)
    if version(['node', '--version']) != 'v24.21.0' or version(['npm', '--version']) != '11.19.0':
        raise RuntimeError('Use exactly Node 24.21.0 and npm 11.19.0 on PATH.')
    pg = pathlib.Path(os.environ.get('DISPATCH_TEST_PG_BIN', str(pathlib.Path(shutil.which('pg_ctl') or '/missing/pg_ctl').parent)))
    for command in ['postgres', 'pg_ctl', 'initdb', 'psql']:
        if not (pg / command).is_file():
            raise RuntimeError('Install PostgreSQL 17; set DISPATCH_TEST_PG_BIN to its bin directory.')
    if not version([str(pg / 'postgres'), '--version']).startswith('postgres (PostgreSQL) 17.'):
        raise RuntimeError('PostgreSQL 17 is required.')
    if '--headed' in sys.argv and not os.environ.get('DISPLAY'):
        raise RuntimeError('A graphical X11/XWayland DISPLAY is required; omit --headed for the default headless walkthrough.')
    for path, minimum in [(root, 2 * 1024**3), (pathlib.Path('/tmp'), 512 * 1024**2)]:
        free = shutil.disk_usage(path).free
        if free < minimum:
            raise RuntimeError(f'Insufficient disk space at {path}: need {minimum // 1024**2} MiB free, have {free // 1024**2} MiB.')
    lock = pathlib.Path(tempfile.gettempdir()) / ('dispatch-validation-' + str(os.getuid()) + '.lock')
    lock_fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    if os.fstat(lock_fd).st_uid != os.getuid():
        raise RuntimeError('Validation lock has another owner.')
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise RuntimeError('Another Dispatch validation/demo is active; stop it first.') from None
    for port in [18443, 18446, 18546, 19999]:
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind(('127.0.0.1', port))
            except OSError:
                raise RuntimeError(f'Loopback port {port} is occupied; stop its owner before starting.') from None
    progress('[1/5] Prerequisites, disk space and exclusive local ports checked.')
    install_env = dict(os.environ)
    browsers = pathlib.Path(os.environ.get('PLAYWRIGHT_BROWSERS_PATH', str(local / 'browsers'))).resolve()
    install_env['PLAYWRIGHT_BROWSERS_PATH'] = str(browsers)
    locks = ['package-lock.json', 'tests/payment/tooling/package-lock.json']
    identity = hashlib.sha256(b'node24.21.0/npm11.19.0' + b''.join((root / p).read_bytes() for p in locks)).hexdigest()
    marker = local / 'native-dependencies.json'
    cached = json.loads(marker.read_text()) if marker.exists() else {}
    modules = [root / 'node_modules/typescript/package.json', root / 'node_modules/playwright/package.json', root / 'tests/payment/tooling/node_modules/@foundry-rs/anvil-linux-amd64/bin/anvil']
    if cached.get('identity') != identity or not all(p.is_file() for p in modules):
        progress('[2/5] Installing both pinned npm locks (lifecycle scripts disabled)…')
        run(['npm', 'ci', '--ignore-scripts'], env=install_env, name='npm-root')
        run(['npm', 'ci', '--prefix', 'tests/payment/tooling', '--ignore-scripts'], env=install_env, name='npm-tooling')
        marker.write_text(json.dumps({'identity': identity}) + '\n')
    else:
        progress('[2/5] Reusing installed dependencies for the unchanged locks.')
    progress('[3/5] Building the current server and browser source…')
    run(['npm', 'run', 'build'], env=install_env, name='build')
    run(['npm', 'run', 'build:web'], env=install_env, name='build-web')
    progress('[4/5] Preparing pinned Chromium (existing downloads reused)…')
    run(['node', 'node_modules/playwright/cli.js', 'install', 'chromium'], env=install_env, name='browser-install')
    browser = subprocess.check_output(['node', '--input-type=module', '-e', "import{chromium}from'playwright';process.stdout.write(chromium.executablePath())"], cwd=root, env=install_env, text=True)
    base = pathlib.Path(tempfile.mkdtemp(prefix='dispatch-b4-', dir='/tmp'))
    env = {'PATH': str(pg) + ':' + str(pathlib.Path(shutil.which('node')).parent) + ':/usr/bin:/bin',
           'LC_ALL': 'C', 'DISPATCH_MODE': 'local', 'DISPATCH_DB_HOST': str(base),
           'DISPATCH_DB_PORT': '55442', 'DISPATCH_BUYER_EVIDENCE': str(out),
           'DISPATCH_BROWSER_PATH': browser, 'PLAYWRIGHT_BROWSERS_PATH': str(browsers)}
    for key in ['DISPLAY', 'XAUTHORITY']:
        if os.environ.get(key):
            env[key] = os.environ[key]
    progress('[5/5] Starting isolated PostgreSQL, non-forked EVM, fixture facilitator and application…')
    run([pg/'initdb', '-D', base/'data', '-U', 'fixture_admin', '--auth-local=trust', '--auth-host=reject', '--no-locale'], env=env, name='postgres-init')
    run([pg/'pg_ctl', '-D', base/'data', '-l', base/'server.log', '-o', f"-k {base} -p 55442 -c listen_addresses='' -c fsync=on -c synchronous_commit=on -c log_error_verbosity=terse -c log_min_error_statement=panic -c log_parameter_max_length=0 -c log_parameter_max_length_on_error=0", '-w', 'start'], env=env, name='postgres-start')
    started = True
    def sql(database, text):
        run([pg/'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-h', base, '-p', '55442', '-U', 'fixture_admin', '-d', database], env=env, name='postgres-bootstrap', input=text, text=True)
    sql('postgres', 'CREATE DATABASE dispatch;')
    sql('dispatch', (root/'db/bootstrap.sql').read_text() + (root/'infra/local-logins.sql').read_text())
    (base/'fixture.key').write_bytes(os.urandom(32))
    (base/'assets').mkdir()
    run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', base/'tls.key', '-out', base/'tls.crt', '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1,IP:::1'], env=env, name='tls')
    env['NODE_EXTRA_CA_CERTS'] = str(base/'tls.crt')
    # Child stdout is private diagnostic data. Only controlled, credential-free messages
    # reach the terminal; test errors and library dumps are never echoed.
    child = subprocess.Popen(['node', 'scripts/demo-native.mjs', *sys.argv[1:]], cwd=root, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)
    def interrupt(signum, frame):
        global interrupted
        interrupted = True
        if child.poll() is None:
            child.send_signal(signal.SIGTERM)
    signal.signal(signal.SIGINT, interrupt)
    signal.signal(signal.SIGTERM, interrupt)
    prefixes = ('READY:', 'PURCHASE LINK:', 'HUMAN:', 'AGENT:', 'RECOVERY:', 'INDEPENDENCE:', 'COMPLETE:', 'FAILED:')
    def pump():
        with (out/'driver.log').open('w') as log:
            for line in child.stdout:
                log.write(line)
                log.flush()
                if line.startswith(prefixes):
                    progress(line.rstrip())
    reader = threading.Thread(target=pump, daemon=True)
    reader.start()
    deadline = time.monotonic() + 180
    while child.poll() is None:
        try:
            child.wait(timeout=1)
        except subprocess.TimeoutExpired:
            if time.monotonic() > deadline:
                interrupted = True
                child.send_signal(signal.SIGTERM)
            if interrupted:
                try:
                    child.wait(timeout=60)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
    reader.join()
    if child.returncode or interrupted:
        raise RuntimeError('Local walkthrough failed; inspect private driver.log. No failed purchase was retried.')
    result = json.loads((out/'native-result.json').read_text())
    if result.get('status') != 'passed':
        raise RuntimeError('Local walkthrough did not produce a passing result.')

except Exception as error:
    import traceback
    (out/'failure-private.log').write_text(traceback.format_exc())
    # Only launcher-authored errors are printed. Third-party diagnostics stay in files.
    message = str(error) if type(error) is RuntimeError else type(error).__name__ + '; inspect private diagnostics'
    progress('FAILED: ' + message)
    (out/'failure.json').write_text(json.dumps({'type': type(error).__name__, 'message': message}) + '\n')
    sys.exit(1)
finally:
    if child and child.poll() is None:
        child.send_signal(signal.SIGTERM)
        try:
            child.wait(timeout=60)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
    # A failed pg_ctl readiness wait can still leave its owned postmaster running.
    if base and (base/'data/postmaster.pid').exists():
        started = True
    if child:
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    if started:
        if (base/'server.log').exists():
            shutil.copyfile(base/'server.log', out/'postgres.log')
        run([pg/'pg_ctl', '-D', base/'data', '-m', 'immediate', '-w', 'stop'], env=env, name='postgres-stop')
    if base:
        shutil.rmtree(base)
    progress('STOPPED: owned native services closed; disposable credentials removed. Private diagnostics: ' + str(out))
