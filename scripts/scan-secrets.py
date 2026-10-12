"""Scan explicit candidate source/build files, with a generated positive control; no history/state."""
import hashlib,json,os,pathlib,shutil,subprocess,sys,tempfile
root=pathlib.Path(__file__).resolve().parents[1]
scanner=pathlib.Path(sys.argv[1]).resolve()
assert scanner.is_file()
parent=root/'.local/test-results';parent.mkdir(parents=True,exist_ok=True)
out=pathlib.Path(tempfile.mkdtemp(prefix='secrets-',dir=parent))
work=pathlib.Path(tempfile.mkdtemp(prefix='dispatch-source-secrets-'));work.chmod(0o700)
env={'PATH':'/usr/bin:/bin','HOME':str(work),'LC_ALL':'C'}
inventory={}
try:
 candidate=work/'candidate';candidate.mkdir()
 for p in sorted(root.rglob('*')):
  relative=p.relative_to(root)
  if set(relative.parts)&{'.git','.local','node_modules','__pycache__'}:continue
  if not p.is_file():continue
  assert not p.is_symlink()
  target=candidate/relative;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(p,target)
  inventory[str(relative)]=hashlib.sha256(p.read_bytes()).hexdigest()
 control=work/'control';control.mkdir()
 subprocess.run(['openssl','genpkey','-algorithm','ED25519','-out',str(control/'generated.pem')],env=env,check=True,capture_output=True)
 records=[]
 for name,path in [('candidate',candidate),('positive-control',control)]:
  raw=work/(name+'.json')
  argv=[str(scanner),'fs','--scanners','secret','--format','json','--output',str(raw),'--timeout','2m',str(path)]
  result=subprocess.run(argv,env=env,capture_output=True,timeout=150)
  (out/(name+'.stderr.log')).write_bytes(result.stderr)
  assert result.returncode==0,'secret_scan_execution_failed'
  data=json.loads(raw.read_text());findings=[]
  for group in data.get('Results',[]):
   for item in group.get('Secrets',[]):
    findings.append({'path':group['Target'],'rule':item['RuleID'],'severity':item['Severity'],'start_line':item.get('StartLine'),'end_line':item.get('EndLine')})
  # Scanner match/context values can themselves contain a credential. Preserve safe metadata
  # and raw-output hash, never persist generated PEM or scanner snippets in repository evidence.
  records.append({'selection':name,'argv':argv,'exit_code':result.returncode,'raw_sha256':hashlib.sha256(raw.read_bytes()).hexdigest(),'findings':findings})
 (out/'source-manifest.json').write_text(json.dumps(inventory,sort_keys=True,indent=2)+'\n')
 (out/'results.json').write_text(json.dumps({'scanner_sha256':hashlib.sha256(scanner.read_bytes()).hexdigest(),'records':records,'raw_output_retained':False,'excluded':'Git history, historical evidence, private state, dependencies, runtime mounts'},indent=2)+'\n')
 assert records[1]['findings'],'positive_control_not_detected'
 assert not records[0]['findings'],'candidate_secret_findings_require_disposition'
 print(json.dumps({'output':str(out),'scanned_members':len(inventory),'positive_control_detected':True,'candidate_findings':0}))
finally:shutil.rmtree(work)
