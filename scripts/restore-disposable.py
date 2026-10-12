"""Restore generated local fixtures only. Runtime access stays blocked, including on failure."""
import json, os, pathlib, re, subprocess, sys
base = pathlib.Path(os.environ['DISPATCH_DB_HOST'])
assert re.fullmatch(r'/tmp/dispatch-b4-[A-Za-z0-9_-]+', str(base))
assert base.is_dir() and base.stat().st_uid == os.getuid() and not base.stat().st_mode & 0o077
pg = pathlib.Path(os.environ['DISPATCH_TEST_PG_BIN'])
dump = pathlib.Path(sys.argv[1]).resolve(); name = sys.argv[2]
assert dump.is_relative_to(base) and dump.is_file() and not dump.is_symlink()
assert re.fullmatch(r'b8_restore_[a-z0-9_]+', name)
args = ['-h',str(base),'-p','55442','-U','fixture_admin']
env = {'PATH':str(pg)+':/usr/bin:/bin','LC_ALL':'C'}
def sql(database, statement):
    subprocess.run([str(pg/'psql'),*args,'-X','-v','ON_ERROR_STOP=1','-d',database],input=statement,text=True,env=env,check=True,stdout=subprocess.DEVNULL)
# Fresh database only. Never overwrite an existing restoration or active source database.
# The validated database identifier is the sole interpolation; no untrusted values enter SQL.
sql('postgres',f'CREATE DATABASE {name}; REVOKE CONNECT,CREATE,TEMPORARY ON DATABASE {name} FROM PUBLIC;')
subprocess.run([str(pg/'pg_restore'),*args,'-d',name,'--exit-on-error','--single-transaction',str(dump)],env=env,check=True)
sql(name,"""BEGIN;
UPDATE dispatch.merchant_control SET payment_paused=true,fulfillment_paused=true,version=version+1;
COMMIT;""")
# No grants or unblock command: external history may postdate even a perfectly valid snapshot.
print(json.dumps({'database':name,'runtime_connect':'denied','payment_paused':True,'fulfillment_paused':True,'connection_fenced':True,
                  'release_authorized':False,'reason':'backup cannot prove absence of later broadcast, invocation or credential revocation'}))
