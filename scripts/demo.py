"""Owned, loopback-only rootless container demonstration. No production settings."""
import argparse, base64, fcntl, hashlib, json, os, pathlib, platform, secrets, shutil, socket, subprocess, sys, tempfile, time
ROOT = pathlib.Path(__file__).resolve().parents[1]
ORIGIN = 'https://127.0.0.1:18443'
IDENTITY = hashlib.sha256(str(ROOT).encode()).hexdigest()[:12]
STATE = pathlib.Path(tempfile.gettempdir()) / ('dispatch-demo-' + str(os.getuid()) + '-' + IDENTITY)
os.umask(0o077)
# Explicit tool/UI environment only; no inherited application credentials.
ENV = {k:v for k,v in os.environ.items() if k in {'PATH','HOME','TMPDIR','XDG_RUNTIME_DIR','DOCKER_HOST','DOCKER_CONFIG','DOCKER_CONTEXT','DISPLAY','WAYLAND_DISPLAY','XAUTHORITY','DBUS_SESSION_BUS_ADDRESS','npm_config_cache','NPM_CONFIG_CACHE'}}
# The demo never reads a .env file. Docker interpolation is not used.
ENV['LC_ALL'] = 'C'

def run(args, data=None, timeout=600, capture=True):
    r = subprocess.run([str(x) for x in args], input=data, cwd=ROOT, env=ENV,
                       stdout=subprocess.PIPE if capture else None, stderr=subprocess.PIPE if capture else None, timeout=timeout)
    if r.returncode:
        # Keep command outputs privately; never echo credentials or arbitrary server responses.
        if STATE.exists():
            log = STATE / ('failure-' + str(time.time_ns()) + '.log')
            log.write_bytes((r.stdout or b'') + (r.stderr or b''))
            print('Command failed; private diagnostic: ' + str(log), file=sys.stderr)
        raise RuntimeError('command_failed: ' + str(args[0]) + ' (exit ' + str(r.returncode) + ')')
    return r.stdout or b''

def docker(*args, **kwargs): return run(['docker', *args], **kwargs)
def compose(*args, **kwargs): return docker('compose', '-f', STATE / 'compose.json', *args, **kwargs)
def load(name): return json.loads((STATE / name).read_text())
def save(name, value):
    tmp = STATE / (name + '.new'); tmp.write_text(json.dumps(value, indent=2) + '\n'); tmp.replace(STATE / name)

def check_state():
    if STATE.is_symlink(): raise RuntimeError('demo_state_symlink_refused')
    if STATE.exists():
        s = STATE.stat()
        if s.st_uid != os.getuid() or s.st_mode & 0o077: raise RuntimeError('demo_state_not_private')
    else: STATE.mkdir(mode=0o700)

def preflight(build=False):
    if platform.system() != 'Linux' or platform.machine() != 'x86_64': raise RuntimeError('Linux x86_64 is the tested platform')
    for tool in ['docker', 'openssl', 'node', 'npm', 'certutil']:
        if not shutil.which(tool): raise RuntimeError('Missing ' + tool + '; see docs/getting-started.md')
    if run(['node', '--version']).strip() != b'v24.21.0': raise RuntimeError('Node 24.21.0 required; no automatic compiler/runtime substitution')
    if run(['npm', '--version']).strip() != b'11.19.0': raise RuntimeError('npm 11.19.0 required')
    info = json.loads(docker('info', '--format', '{{json .}}'))
    if 'name=rootless' not in info.get('SecurityOptions', []): raise RuntimeError('Select an existing rootless Docker context; host security settings are never changed')
    docker('compose', 'version')
    data = pathlib.Path(info['DockerRootDir'])
    if not data.is_dir(): raise RuntimeError('The rootless daemon must be local; remote Docker is unsupported')
    free = shutil.disk_usage(data).free
    mem = {x.split(':')[0]: int(x.split()[1]) * 1024 for x in pathlib.Path('/proc/meminfo').read_text().splitlines() if x.startswith(('MemAvailable:', 'MemTotal:'))}
    if free <= 20 * 1024**3 or mem['MemAvailable'] <= 1024**3 or shutil.disk_usage('/tmp').free <= 512 * 1024**2:
        raise RuntimeError('Need >20 GiB free on the actual Docker store, >1 GiB available RAM and >512 MiB free /tmp; no resources will be pruned')
    save('preflight.json', {'rootless': True, 'engine': info['ServerVersion'], 'driver': info['Driver'], 'store_free_bytes': free, 'memory': mem})
    if build:
        for port in [18443, 18546, 18447]:
            with socket.socket() as s:
                if s.connect_ex(('127.0.0.1', port)) == 0: raise RuntimeError('Local port ' + str(port) + ' is occupied; stop its owning demo first')

def source_files():
    # A reviewed path allowlist is an isolation boundary; ignore rules are not.
    for rel in json.loads((ROOT/'infra/build-context.json').read_text())['files']:
        p=ROOT/rel
        if pathlib.Path(rel).is_absolute() or '..' in pathlib.Path(rel).parts or p.resolve()!=p or not p.is_file():
            raise RuntimeError('build_source_path_refused: '+rel)
        yield p,rel


def install():
    print('Installing locked local dependencies (lifecycle scripts disabled)…', flush=True)
    for args in [['npm','ci','--ignore-scripts'], ['npm','ci','--prefix','tests/payment/tooling','--ignore-scripts'], ['npm','run','build'], ['npm','run','check:web'], ['npm','run','build:web']]: run(args, capture=False)

def build_images():
    stage = STATE / 'source'; stage.mkdir(exist_ok=True)
    manifest = {}
    for p, rel in source_files():
        q = stage / rel; q.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(p, q); q.chmod(0o644)
        manifest[rel] = hashlib.sha256(p.read_bytes()).hexdigest()
    save('source-manifest.json', manifest)
    tag = load('owner.json')['project']
    for target in ['build','runtime','fixtures']:
        print('Building local container ' + target + '…', flush=True)
        args = ['docker','build','--platform','linux/amd64','--target',target,'-f',str(stage/'infra/Digital.Dockerfile'),'-t',tag+':'+target,str(stage)]
        with (STATE/(target+'-build.log')).open('wb') as log:
            r = subprocess.run(args,env=ENV,cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,timeout=1200)
        if r.returncode: raise RuntimeError('Image build failed; private log: ' + str(STATE/(target+'-build.log')))
    artifact = tag + '-web-artifact'; web = stage/'edge-web'; web.mkdir(exist_ok=True)
    docker('create','--name',artifact,'--network','none','--read-only','--cap-drop','ALL','--user','1000:1000',tag+':build','/bin/true')
    try: docker('cp',artifact+':/app/apps/web/dist/.',web)
    finally: docker('rm',artifact)
    with (STATE/'edge-build.log').open('wb') as log:
        r = subprocess.run(['docker','build','--platform','linux/amd64','-f',str(stage/'infra/Caddy.security.Dockerfile'),'-t',tag+':edge',str(stage)],env=ENV,cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,timeout=1200)
    if r.returncode: raise RuntimeError('Edge build failed; inspect private edge-build.log')
    ids = {t:json.loads(docker('image','inspect',tag+':'+t))[0]['Id'] for t in ['build','runtime','fixtures','edge']}
    save('images.json', ids)
    c = json.loads((stage/'infra/compose.digital.yaml').read_text()); c['name'] = tag
    for name,s in c['services'].items():
        if 'build' in s:
            del s['build'];s['image'] = ids['edge' if name=='edge' else 'fixtures' if name=='fixtures' else 'runtime']
        if 'volumes' in s:
            s['volumes'] = [str((stage/'infra'/v.rsplit(':',2)[0]).resolve())+':'+':'.join(v.rsplit(':',2)[1:]) if v.startswith(('../','./')) else v for v in s['volumes']]
    c['services']['edge']['volumes'][0] = str(stage/'infra/Caddy.demo') + ':/etc/caddy/Caddyfile:ro'
    save('compose.json',c)

def material(volume, files, target='/run/dispatch'):
    image = load('images.json')['runtime']; project = load('owner.json')['project']
    code = "import{writeFile}from'node:fs/promises';let s='';for await(const b of process.stdin)s+=b;for(const[n,v]of Object.entries(JSON.parse(s)))await writeFile('"+target+"/'+n,Buffer.from(v,'base64'),{mode:0o600});"
    docker('run','--rm','-i','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--user','1000:1000','--mount','type=volume,source='+project+'_'+volume+',target='+target,image,'node','--input-type=module','-e',code,data=json.dumps({n:base64.b64encode(v).decode() for n,v in files.items()}).encode())

def provision():
    print('Preparing private generated fixture material…', flush=True)
    # Generated material is written once. Interrupted operations can resume with the same keys.
    if not (STATE/'material.json').exists():
        run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',STATE/'tls.key','-out',STATE/'tls.crt','-days','7','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'])
        save('material.json', {n:base64.b64encode(secrets.token_bytes(32)).decode() for n in ['encryption','webhook','bearer']})
    m={n:base64.b64decode(v) for n,v in load('material.json').items()};key=m['encryption'];tls={'tls.key':(STATE/'tls.key').read_bytes(),'tls.crt':(STATE/'tls.crt').read_bytes()}
    enc={'encryption.key':key,'encryption.sha256':hashlib.sha256(key).hexdigest().encode()};hook={'webhook.key':m['webhook'],'webhook.bearer':base64.urlsafe_b64encode(m['bearer']).rstrip(b'=')}
    for volume,files in {'api-material':{**tls,**enc},'worker-material':{'tls.crt':tls['tls.crt'],**enc,**hook},'edge-material':tls,'fixture-material':tls,'receiver-material':{**tls,**hook}}.items(): material(volume,files)
    material('private-assets',{'guide.txt':(ROOT/'examples/assets/guide.txt').read_bytes()},'/private-assets')
    material('receiver-journal',{'product':b''},'/journal')
    compiler = "import solc from './tests/payment/tooling/node_modules/solc/index.js';import{readFileSync}from'node:fs';const sources={};for(const [p,n]of [['tests/payment/TokenFixture.sol','TokenFixture.sol'],['tests/buyer/BuyerTokenFixture.sol','BuyerTokenFixture.sol'],['tests/operator/OperatorTokenFixture.sol','OperatorTokenFixture.sol']])sources[n]={content:readFileSync(p,'utf8').replace('bytes32 s) public {','bytes32 s) public virtual {')};const o=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources,settings:{evmVersion:'cancun',outputSelection:{'*':{'*':['evm.deployedBytecode.object']}}}})));if(o.errors?.some(e=>e.severity==='error'))throw Error('compile');console.log(JSON.stringify({bytecode:'0x'+o.contracts['OperatorTokenFixture.sol'].OperatorTokenFixture.evm.deployedBytecode.object}));"
    material('fixture-journal',{'chain.json':run(['node','--input-type=module','-e',compiler])},'/journal')

def start(fresh=False):
    print('Initializing disposable PostgreSQL and checking migrations…', flush=True)
    compose('up','-d','--wait','postgres');compose('run','--rm','-T','migration')
    if fresh:
        # Idempotent fixture-only receiver provisioning, never application product/order seed SQL.
        sql=b"SELECT 'CREATE USER local_receiver PASSWORD ''fixture-only-receiver''' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname='local_receiver')\\gexec\nSELECT 'CREATE DATABASE merchant OWNER local_receiver' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='merchant')\\gexec\n"
        compose('exec','-T','postgres','psql','-v','ON_ERROR_STOP=1','-U','local_cluster_admin','-d','dispatch',data=sql)
        exists=compose('exec','-T','postgres','psql','-At','-U','local_receiver','-d','merchant','-c',"SELECT to_regclass('merchant_adapter.orders')").strip()
        if not exists: compose('exec','-T','postgres','psql','-v','ON_ERROR_STOP=1','-U','local_receiver','-d','merchant',data=(ROOT/'examples/merchant-adapter/schema.sql').read_bytes())
    print('Starting the local chain, API, worker and loopback edge…', flush=True)
    compose('up','-d','fixtures');compose('up','-d','--wait','api');compose('up','-d','receiver');compose('up','-d','--wait','worker','edge')

def runtime_controls():
    ids=compose('ps','-aq').decode().split();containers=json.loads(docker('inspect',*ids));rows=[]
    for c in containers:
        name=c['Config']['Labels']['com.docker.compose.service'];h=c['HostConfig']
        assert h['ReadonlyRootfs'] and 'ALL' in h['CapDrop'] and 'no-new-privileges:true' in h['SecurityOpt'],'container_privilege_control'
        assert c['Config']['User'] in ['1000:1000','999:999'] and h['Memory']>0 and h['PidsLimit']>0,'container_user_resource_control'
        for m in c['Mounts']:
            if m['Destination'] in ['/private-assets','/run/dispatch']:assert not m['RW'],'private_mount_readonly'
        ports=c['NetworkSettings']['Ports'] or {}
        for bindings in ports.values():
            for b in bindings or []:assert name=='edge' and b['HostIp']=='127.0.0.1' and b['HostPort']=='18443','loopback_publication_required'
        rows.append({'service':name,'image':c['Image'],'read_only':h['ReadonlyRootfs'],'user':c['Config']['User'],'ports':ports})
    assert {'postgres','api','worker','edge','fixtures','receiver'}<=set(r['service'] for r in rows),'missing_runtime_service'
    save('runtime-controls.json',rows)

def bootstrap():
    print('Initializing the local operator and importing the sample file…', flush=True)
    if not (STATE/'operator.password').exists(): (STATE/'operator.password').write_text(secrets.token_urlsafe(32)+'\n')
    if not (STATE/'bootstrap-begun').exists():
        compose('run','--rm','-T','migration','node','scripts/operator-local.mjs','begin',ORIGIN,'/bootstrap/operator',timeout=60)
        (STATE/'bootstrap-begun').touch()
    if not (STATE/'bootstrap-complete').exists():
        compose('run','--rm','-T','migration','node','scripts/operator-local.mjs','complete','/bootstrap/operator',data=(STATE/'operator.password').read_bytes(),timeout=60)
        (STATE/'bootstrap-complete').touch()
    if not (STATE/'asset.json').exists():
        imported=json.loads(compose('run','--rm','-T','migration','node','scripts/operator-local.mjs','import','/private-assets','guide.txt','guide.txt','text/plain',timeout=60));save('asset.json',imported)

def status():
    if not (STATE/'compose.json').exists(): print('Demo has not been initialized. Run ./scripts/demo.sh up');return
    rows=[json.loads(x) for x in compose('ps','-a','--format','json').splitlines()]
    for r in rows: print(r['Service']+': '+r['State']+' '+r.get('Health',''))
    print('Local fixture only: '+ORIGIN+'/operator')
    print('Merchant configuration and product readiness are shown in the operator UI.')

def client(mode):
    if not (STATE/'asset.json').exists(): raise RuntimeError('Run up first')
    ENV.update({'DISPATCH_DEMO_STATE':str(STATE),'NODE_EXTRA_CA_CERTS':str(STATE/'tls.crt')})
    if 'DISPATCH_BROWSER_PATH' in os.environ: ENV['DISPATCH_BROWSER_PATH']=os.environ['DISPATCH_BROWSER_PATH']
    run(['node','scripts/demo-client.mjs',mode],timeout=3600 if mode in ['operator','browser'] else 600,capture=False)

def main():
    global STATE
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('command',choices=['up','status','operator','browser','agent','recover','verify','down','reset','doctor']);args=parser.parse_args()
    check_state()
    with (STATE/'command.lock').open('a') as lock:
        # Interactive clients coexist; lifecycle changes wait until they close.
        mode=fcntl.LOCK_SH if args.command in ['status','operator','browser','agent','recover','verify','doctor'] else fcntl.LOCK_EX
        fcntl.flock(lock,mode|fcntl.LOCK_NB)
        if args.command=='status':status();return
        if args.command=='doctor':preflight();print('Prerequisites available; security qualification remains separate.');return
        if args.command in ['operator','browser','agent','recover','verify']:client(args.command);return
        if args.command=='down':
            if (STATE/'compose.json').exists():compose('stop',timeout=120)
            print('Stopped only this demo. Volumes and private recovery material retained.');return
        if args.command=='reset':
            if (STATE/'compose.json').exists():compose('down','--volumes','--remove-orphans',timeout=120)
            archived=STATE.with_name(STATE.name+'-retired-'+str(time.time_ns()));STATE.rename(archived)
            print('Only this demo was reset; private diagnostics retained at '+str(archived));return
        preflight(build=not (STATE/'ready').exists())
        if not (STATE/'owner.json').exists():save('owner.json',{'project':'dispatch-demo-'+secrets.token_hex(6),'source_identity':IDENTITY})
        if not (STATE/'compose.json').exists():install();build_images()
        fresh=not (STATE/'ready').exists()
        if fresh:provision()
        start(fresh);runtime_controls();bootstrap();(STATE/'ready').touch();status()
        print('Next: ./scripts/demo.sh operator (generated login stays off screen).')
        print('To inspect the private password privately: '+str(STATE/'operator.password'))

if __name__=='__main__':
    try:main()
    except (RuntimeError,AssertionError,subprocess.TimeoutExpired,BlockingIOError) as e:
        print('Demo stopped: '+str(e)+'. See docs/troubleshooting.md. No new payment authorization was retried.',file=sys.stderr);sys.exit(1)
