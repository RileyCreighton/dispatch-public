"""Full disposable container purchase/recovery regression, separate from persistent demo."""
import json,os,pathlib,subprocess,tempfile,time
import demo
root=demo.ROOT
parent=root/'.local/test-results';parent.mkdir(parents=True,exist_ok=True)
out=pathlib.Path(tempfile.mkdtemp(prefix='containers-',dir=parent));out.chmod(0o700)
demo.STATE=pathlib.Path(tempfile.mkdtemp(prefix='dispatch-container-test-'));state=demo.STATE
result={'status':'failed','private_state':str(state)}
try:
 demo.preflight(build=True);demo.save('owner.json',{'project':'dispatch-test-'+str(time.time_ns())})
 demo.install();demo.build_images()
 c=demo.load('compose.json');c['services']['edge']['volumes'][0]=str(state/'source/infra/Caddy.digital')+':/etc/caddy/Caddyfile:ro';demo.save('compose.json',c)
 demo.provision();demo.start(fresh=True);demo.runtime_controls()
 (state/'home').mkdir(mode=0o700)
 env=dict(demo.ENV,HOME=str(state/'home'),NODE_EXTRA_CA_CERTS=str(state/'tls.crt'),DISPATCH_DIGITAL_STATE=str(state),DISPATCH_DIGITAL_OUTPUT=str(out),DISPATCH_DIGITAL_CONFIG=str(state/'compose.json'),DISPATCH_DIGITAL_REPO=str(root))
 if os.environ.get('DISPATCH_BROWSER_PATH'):env['DISPATCH_BROWSER_PATH']=os.environ['DISPATCH_BROWSER_PATH']
 else:env['DISPATCH_BROWSER_PATH']=subprocess.check_output(['node','--input-type=module','-e',"import{chromium}from'playwright';process.stdout.write(chromium.executablePath())"],cwd=root,text=True).strip()
 with (out/'product.log').open('wb') as log:
  r=subprocess.run(['node','tests/containers/product.mjs'],cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=1800)
 assert r.returncode==0,'container_product_assertion_failed'
 result['status']='passed'
finally:
 for name in ['images.json','source-manifest.json','preflight.json','runtime-controls.json']:
  if (state/name).exists():(out/name).write_bytes((state/name).read_bytes())
 if (state/'compose.json').exists():
  try:(out/'services.log').write_bytes(demo.compose('logs','--no-color'))
  finally:demo.compose('down','--volumes','--remove-orphans')
  if (state/'restore-volumes.json').exists():
   project=demo.load('owner.json')['project'];volumes=demo.load('restore-volumes.json')+[project+'_'+v for v in demo.load('original-compose.json')['volumes']]
   for v in sorted(set(volumes)):
    assert v.startswith(project)
    subprocess.run(['docker','volume','rm',v],env=demo.ENV,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 (out/'result.json').write_text(json.dumps(result,indent=2)+'\n');print('Private container results: '+str(out),flush=True)
