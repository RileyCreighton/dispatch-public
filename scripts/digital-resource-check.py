"""Check the actual local rootless daemon's store without private host registrations."""
import json,os,pathlib,shutil,subprocess,sys
info=json.loads(subprocess.check_output(['docker','info','--format','{{json .}}']))
assert 'name=rootless' in info['SecurityOptions'],'rootless_required'
store=pathlib.Path(info['DockerRootDir']);assert store.is_dir(),'local_daemon_required'
free=shutil.disk_usage(store).free
mem={x.split(':')[0]:int(x.split()[1])*1024 for x in pathlib.Path('/proc/meminfo').read_text().splitlines() if x.startswith(('MemAvailable:','MemTotal:'))}
result={'rootless':True,'driver':info['Driver'],'store_available_bytes':free,'memory':mem,'tmp_available_bytes':shutil.disk_usage('/tmp').free}
out=pathlib.Path(sys.argv[-1]);assert not out.exists();out.write_text(json.dumps(result,indent=2)+'\n')
assert free>20*1024**3 and mem['MemAvailable']>1024**3 and result['tmp_available_bytes']>512*1024**2,'insufficient_storage_or_memory'
