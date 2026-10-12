"""Run the portable safety selections serially; preserve all command results locally."""
import fcntl,hashlib,json,os,pathlib,signal,subprocess,sys,tempfile,time
root=pathlib.Path(__file__).resolve().parents[1]
parent=root/'.local/test-results';parent.mkdir(parents=True,exist_ok=True)
out=pathlib.Path(tempfile.mkdtemp(prefix='suite-',dir=parent));out.chmod(0o700)
selections=json.loads((root/'tests/selections.json').read_text())
requested=sys.argv[1:]
if requested:
 assert set(requested)<=set(x['name'] for x in selections),'Unknown selection; see tests/selections.json'
 selections=[x for x in selections if x['name'] in requested]
results=[]
# These suites use fixed loopback ports. Serialize the runner across checkouts.
lock_path=pathlib.Path(tempfile.gettempdir())/('dispatch-validation-'+str(os.getuid())+'.lock')
lock_fd=os.open(lock_path,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
assert os.fstat(lock_fd).st_uid==os.getuid(),'validation_lock_owner'
fcntl.flock(lock_fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
def interrupted(signum,frame):raise KeyboardInterrupt
signal.signal(signal.SIGTERM,interrupted)
for item in selections:
 name=item['name'];print('START '+name,flush=True);start=time.time()
 stopped=False
 with (out/(name+'.log')).open('wb') as log:
  process=subprocess.Popen(item['argv'],cwd=root,env=dict(os.environ,**item['environment']),stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
  try:code=process.wait()
  except KeyboardInterrupt:
   stopped=True
   # Python fixture runners unwind finally blocks and stop their own PostgreSQL.
   os.killpg(process.pid,signal.SIGINT)
   try:code=process.wait(timeout=20)
   except subprocess.TimeoutExpired:
    os.killpg(process.pid,signal.SIGKILL);code=process.wait()
 # Negative control must reach the intended competing-child failure, not fail in setup.
 text=(out/(name+'.log')).read_text();valid=not stopped and code==item['expected_exit']
 if name=='contention-negative':valid=valid and '23' in text and ('child' in text or 'competitor' in text)
 record={'name':name,'exit':code,'expected_exit':item['expected_exit'],'passed':valid,'interrupted':stopped,'seconds':round(time.time()-start,3),'log_sha256':hashlib.sha256(text.encode()).hexdigest()};results.append(record)
 (out/'results.json').write_text(json.dumps(results,indent=2)+'\n');print(('PASS ' if valid else 'FAIL ')+name,flush=True)
 if stopped:break
print('Private local results: '+str(out));sys.exit(int(any(not x['passed'] for x in results)))
