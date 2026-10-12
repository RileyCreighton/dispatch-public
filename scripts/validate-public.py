"""Portable packaging checks; never open runtime material or private source history."""
from pathlib import Path
import hashlib,json,re,sys,os
root=Path(__file__).resolve().parents[1]
excluded={'.git','.local','node_modules','dist','__pycache__','edge-web'}
files=[];errors=[]
for directory, dirs, names in os.walk(root):
 for name in list(dirs):
  p=Path(directory)/name
  if name in excluded:dirs.remove(name)
  elif p.is_symlink():errors.append(str(p.relative_to(root))+': source symlink');dirs.remove(name)
 for name in sorted(names):
  p=Path(directory)/name;rel=p.relative_to(root)
  if p.is_symlink():errors.append(str(rel)+': source symlink');continue
  if p.is_file():
   if p.stat().st_nlink!=1:errors.append(str(rel)+': multiply linked source')
   if name in ['AGENTS.md','DEMO_RECORDING_CHECKLIST.md','OWNER_RELEASE_CHECKLIST.md'] or p.suffix.lower() in ['.mp4','.webm','.mov','.pem','.key','.sqlite','.dump','.log']:
    errors.append(str(rel)+': non-source or private artifact')
   files.append(p)
private=re.compile(r'ventureos|docs/evidence|/home/[a-zA-Z0-9_-]+/|\.(?:codex|claude)/|ChatGPT|\bCodex\b|\bAstra\b|build/build-\d',re.I)
for p in files:
 rel=str(p.relative_to(root));raw=p.read_bytes()
 if len(raw)>3_000_000:errors.append(rel+': unexpectedly large source artifact')
 try:text=raw.decode('utf8')
 except UnicodeDecodeError:
  errors.append(rel+': unapproved binary type')
  continue
 if p.name!='validate-public.py' and private.search(text):errors.append(rel+': private workflow/path reference')
 if re.search(r'-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----',text):errors.append(rel+': embedded private key')
 if p.suffix=='.md' and not rel.startswith('licenses/'):
  for link in re.findall(r'!?\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)',text):
   if re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:',link):continue
   target=link.split('#')[0]
   if target and not (p.parent/target).is_file():errors.append(rel+': broken link '+target)
   if '#' in link and (p.parent/target if target else p).suffix=='.md':
    document=p.parent/target if target else p
    if document.is_file():
     anchors={re.sub(r'[^\w -]','',h.strip().lower()).replace(' ','-') for h in re.findall(r'^#{1,6} (.+)$',document.read_text(),re.M)}
     if link.split('#',1)[1] not in anchors:errors.append(rel+': broken heading '+link)
for name in ['package-lock.json','tests/payment/tooling/package-lock.json']:
 for path,e in json.loads((root/name).read_text())['packages'].items():
  if 'node_modules/' not in path or e.get('link'):continue
  if not e.get('integrity','').startswith('sha512-') or not e.get('resolved','').startswith('https://registry.npmjs.org/'):errors.append(name+': missing locked registry integrity '+path)
contract=json.loads((root/'tests/foundation/source-contract.json').read_text())
for name,sha in contract['migrations'].items():
 if hashlib.sha256((root/'db/migrations'/name).read_bytes()).hexdigest()!=sha:errors.append('Migration checksum changed: '+name)
if '--unpublished' in sys.argv and (root/'.git').exists():
 import subprocess
 if subprocess.check_output(['git','remote'],cwd=root,text=True).strip():errors.append('Candidate unexpectedly has a remote')
print(json.dumps({'source_files':len(files),'errors':errors,'pass':not errors},indent=2));sys.exit(bool(errors))
