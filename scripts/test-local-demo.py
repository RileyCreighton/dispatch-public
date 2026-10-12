"""Real local walkthrough, repeatability, exclusive start and shutdown checks."""
import json, os, pathlib, signal, socket, subprocess, tempfile, time
root = pathlib.Path(__file__).resolve().parents[1]
parent = root / '.local/test-results'
parent.mkdir(parents=True, exist_ok=True)
out = pathlib.Path(tempfile.mkdtemp(prefix='local-demo-check-', dir=parent))
out.chmod(0o700)
results = []

def closed():
    for port in [18443, 18446, 18546, 19999]:
        with socket.socket() as probe:
            assert probe.connect_ex(('127.0.0.1', port)) != 0, 'owned_listener_remains'

def execute(name, interrupt=False, contention=False):
    log = out / (name + '.log')
    with log.open('w') as output:
        child = subprocess.Popen(['./scripts/demo.sh', 'local'], cwd=root,
                                 stdout=output, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 90
            while 'READY:' not in log.read_text():
                assert child.poll() is None, 'walkthrough_failed_before_ready'
                assert time.monotonic() < deadline, 'walkthrough_readiness_timeout'
                time.sleep(0.1)
            if contention:
                competing = subprocess.run(['./scripts/demo.sh', 'local'], cwd=root,
                                           capture_output=True, text=True, timeout=15)
                (out / 'competing.log').write_text(competing.stdout + competing.stderr)
                assert competing.returncode != 0
                assert 'Another Dispatch validation/demo is active' in competing.stdout
            if interrupt:
                child.send_signal(signal.SIGTERM)
            code = child.wait(timeout=120)
        finally:
            if child.poll() is None:
                child.send_signal(signal.SIGTERM)
                child.wait(timeout=75)
    text = log.read_text()
    assert 'STOPPED: owned native services closed; disposable credentials removed.' in text
    closed()
    if interrupt:
        assert code != 0 and 'COMPLETE:' not in text
    else:
        assert code == 0 and 'COMPLETE:' in text
        location = next(line.removeprefix('Private results: ') for line in text.splitlines()
                        if line.startswith('Private results: '))
        report = json.loads((pathlib.Path(location) / 'native-result.json').read_text())
        assert report['status'] == 'passed' and report['orders'] == 2
        for key in ['human_authorizations', 'human_signed_submissions',
                    'agent_authorizations', 'agent_signed_submissions']:
            assert report[key] == 1
        for key in ['private_bytes_equal', 'unauthenticated_download_denied',
                    'human_reload_recovery', 'agent_lost_response_recovery',
                    'ordinary_checkout_during_api_outage', 'api_restart_recovered']:
            assert report[key] is True
        assert report['mainnet_enabled'] is False
        assert len(set(report['transactions'])) == 2
        assert not list(pathlib.Path(location).rglob('*.webm'))
        if name == 'repeat':
            assert 'Reusing installed dependencies' in text
    results.append({'name': name, 'passed': True, 'exit': code})
    (out / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
    print('PASS ' + name, flush=True)

closed()
execute('complete-with-exclusive-start', contention=True)
execute('repeat')
execute('interrupted', interrupt=True)
print('Private local results: ' + str(out))
