"""Validate actual captured private/public operator projections and negative controls."""
import copy,json,pathlib,sys,hashlib
import yaml
from jsonschema import Draft202012Validator,FormatChecker
path=pathlib.Path('docs/architecture/openapi.yaml');doc=yaml.safe_load(path.read_text())
records=json.loads(pathlib.Path(sys.argv[1]).read_text());controls=0
for record in records:
 name=record['schema'];schema={'$ref':'#/components/schemas/'+name,'components':doc['components']}
 validator=Draft202012Validator(schema,format_checker=FormatChecker());validator.validate(record['body'])
 for field in doc['components']['schemas'][name].get('required',[]):
  changed=copy.deepcopy(record['body']);del changed[field];assert not validator.is_valid(changed);controls+=1
 assert not validator.is_valid({**record['body'],'unapproved_private_field':'forbidden'});controls+=1
print(json.dumps({'actual_captures':len(records),'negative_controls':controls,'openapi_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'result':'passed'}))
