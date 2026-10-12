"""Fresh-volume restore for the isolated digital gate; original chain namespace survives."""
import hashlib,json,os,pathlib,subprocess,sys
state=pathlib.Path(os.environ['DISPATCH_DIGITAL_STATE']);out=pathlib.Path(os.environ['DISPATCH_DIGITAL_OUTPUT']);config=pathlib.Path(os.environ['DISPATCH_DIGITAL_CONFIG']);snapshot,index=sys.argv[1:]
assert snapshot in ['old','ambiguous','recent'] and index.isdigit()
tools=pathlib.Path(os.environ['DOCKER_HOST'].removeprefix('unix://')).parents[1]
subprocess.run(['python3','scripts/digital-resource-check.py',str(tools),str(out/('restore-'+index+'-resources.json'))],check=True)
c=json.loads(config.read_text());project=c['name'];original=state/'original-compose.json'
if not original.exists():original.write_text(config.read_text())
base=json.loads(original.read_text());docker=['docker'];command=docker+['compose','-f',str(config)]
def run(args,data=None):return subprocess.run(args,input=data,stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=True,timeout=180).stdout
def sql(query,db='dispatch'):return run(command+['exec','-T','postgres','psql','-At','-v','ON_ERROR_STOP=1','-U','local_cluster_admin','-d',db],query.encode())
# Stop every database client before replacing storage. Do not stop/reset the chain fixture.
run(command+['stop','edge','worker','receiver','api','postgres']);run(command+['rm','-f','postgres'])
created=[]
for volume in ['database','private-assets','api-material','worker-material','receiver-material','receiver-journal']:
 name=project+'-restore-'+index+'-'+volume;c['volumes'][volume]={'name':name};created.append(name)
 if volume!='database':
  source=project+'_'+volume;target='/private-assets' if volume=='private-assets' else '/journal' if volume=='receiver-journal' else '/run/dispatch'
  script="import{readdir,copyFile,chmod}from'node:fs/promises';for(const n of await readdir('/source')){await copyFile('/source/'+n,'"+target+"/'+n);await chmod('"+target+"/'+n,0o600);}"
  run(docker+['run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--user','1000:1000','--mount','type=volume,source='+source+',target=/source,readonly','--mount','type=volume,source='+name+',target='+target,base['services']['api']['image'],'node','--input-type=module','-e',script])
for service in ['api','worker','migration']:c['services'][service]['environment']['DISPATCH_RECOVERY']='quarantined'
config.write_text(json.dumps(c));registry=state/'restore-volumes.json';previous=json.loads(registry.read_text()) if registry.exists() else [];registry.write_text(json.dumps(previous+created))
run(command+['up','-d','--no-deps','--wait','postgres'])
# Fresh cluster bootstrap creates only roles/schema. Restore the captured database, not hidden seed SQL.
sql('DROP SCHEMA dispatch CASCADE;')
run(command+['exec','-T','postgres','pg_restore','-U','local_cluster_admin','-d','dispatch','--exit-on-error'],(state/(snapshot+'.dump')).read_bytes())
sql("CREATE USER local_receiver PASSWORD 'fixture-only-receiver'; CREATE DATABASE merchant OWNER local_receiver;")
run(command+['exec','-T','postgres','pg_restore','-U','local_cluster_admin','-d','merchant','--exit-on-error'],(state/'receiver-final.dump').read_bytes())
# Hash every retained row before runtime touches it. The explicit pause is the sole subsequent DB edit.
source="import{localPool}from'./dist/packages/db/src/config.js';import{createHash}from'node:crypto';const p=localPool('migrator');const hashes={};for(const{tablename:t}of(await p.query(\"SELECT tablename FROM pg_tables WHERE schemaname='dispatch' ORDER BY tablename\")).rows){if(!/^[a-z_]+$/.test(t))throw Error('table');hashes[t]=createHash('sha256').update(JSON.stringify((await p.query('SELECT row_to_json(t)::text r FROM dispatch.'+t+' t ORDER BY row_to_json(t)::text')).rows)).digest('hex');}await p.end();console.log(JSON.stringify(hashes));"
# Cluster administrator reads hashes; runtime roles do not gain privileges.
hashes={}
for table in sql("SELECT tablename FROM pg_tables WHERE schemaname='dispatch' ORDER BY tablename;").decode().split():
 assert table.replace('_','').isalnum()
 hashes[table]=hashlib.sha256(sql('SELECT row_to_json(t)::text FROM dispatch.'+table+' t ORDER BY row_to_json(t)::text;')).hexdigest()
expected=json.loads((state/(snapshot+'-hashes.json')).read_text());assert hashes==expected,'restored_rows_differ'
sql("UPDATE dispatch.merchant_control SET payment_paused=true, mainnet_enabled=false, physical_enabled=false;")
material_check=run(command+['run','--rm','--no-deps','-T','api','node','--input-type=module','-e',pathlib.Path('scripts/verify-recovery-material.mjs').read_text().replace('../dist/','./dist/')]);(out/('restore-'+index+'-materials.json')).write_bytes(material_check)
run(command+['up','-d','--no-deps','--wait','api']);run(command+['up','-d','--no-deps','receiver','worker','edge'])
(out/('restore-'+index+'.json')).write_text(json.dumps({'snapshot':snapshot,'fresh_volumes':created,'row_hashes':hashes,'all_snapshot_rows_match':True,'chain_reset':False,'runtime_recovery':'quarantined','dump_sha256':hashlib.sha256((state/(snapshot+'.dump')).read_bytes()).hexdigest()},indent=2)+'\n')
print('fresh-volume restore ready: '+snapshot)
