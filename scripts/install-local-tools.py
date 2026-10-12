"""Provision pinned disposable Linux/amd64 test tools; no system or production changes."""
import hashlib, json, os, pathlib, platform, subprocess, sys, tarfile, urllib.request
assert platform.system()=='Linux' and platform.machine()=='x86_64'
root=pathlib.Path(__file__).resolve().parents[1]
target=pathlib.Path(sys.argv[1]).resolve();target.mkdir(mode=0o700,parents=True,exist_ok=False)
items=[('https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz','fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6'),('https://ftp.postgresql.org/pub/source/v17.11/postgresql-17.11.tar.bz2','dd27f2b3c59e73ed14aa3324901242bf69a032a6347805f274e6260322d42979')]
for url,sha in items:
 p=target/url.rsplit('/',1)[1]
 with urllib.request.urlopen(url,timeout=120) as response,p.open('wb') as output:
  while chunk:=response.read(1024*1024):output.write(chunk)
 assert hashlib.sha256(p.read_bytes()).hexdigest()==sha, 'tool_archive_integrity'
 with tarfile.open(p) as archive:archive.extractall(target,filter='data')
pgsource=target/'postgresql-17.11'
for argv in [['./configure','--prefix='+str(target/'pg17'),'--without-readline','--without-zlib','--without-icu'],['make','-j2'],['make','install']]:subprocess.run(argv,cwd=pgsource,check=True)
subprocess.run([sys.executable,'-m','venv',str(target/'python')],check=True)
subprocess.run([str(target/'python/bin/python'),'-m','pip','install','--disable-pip-version-check','-r',str(root/'tests/hardening/python-requirements.txt')],check=True)
print(json.dumps({'DISPATCH_TEST_NODE_BIN':str(target/'node-v24.21.0-linux-x64/bin'),'DISPATCH_TEST_PG_BIN':str(target/'pg17/bin'),'DISPATCH_TEST_NPM_CACHE':str(target/'npm-cache'),'DISPATCH_SCHEMA_PYTHON':str(target/'python/bin/python')},indent=2))
