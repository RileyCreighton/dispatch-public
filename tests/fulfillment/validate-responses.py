"""Validate captured actual HTTP JSON with the unchanged OpenAPI 3.1 schemas.
Run using jsonschema 4.25.1 + PyYAML 6.0.2; Python retains arbitrary-size JSON integers.
"""
import copy, hashlib, json, pathlib, sys
import yaml
from jsonschema import Draft202012Validator, FormatChecker
root = pathlib.Path(__file__).resolve().parents[2]
contract = root/'docs/architecture/openapi.yaml'
spec = yaml.safe_load(contract.read_text())
validators = {}
for name in ['CheckoutStatus', 'Error', 'PaidEvent', 'OperationReceipt']:
    schema = {'$ref': '#/components/schemas/'+name, 'components': spec['components']}
    Draft202012Validator.check_schema(schema)
    validators[name] = Draft202012Validator(schema, format_checker=FormatChecker())
records = json.loads(pathlib.Path(sys.argv[1]).read_text())
for i, r in enumerate(records):
    body = json.loads(r['raw'])
    validators[r['schema']].validate(body)
    if 'expected_version' in r:
        assert type(body['version']) is int and body['version'] == int(r['expected_version'])
    if r['schema'] == 'CheckoutStatus':
        assert body['refund_state'] == 'none' and body['shipment_state'] == 'not_applicable'
        assert 'state' not in body and 'fulfillment_state' not in body
# Mutation controls ensure required fields, additionalProperties, enums and integer type really run.
sample = json.loads(next(r['raw'] for r in records if r['schema'] == 'CheckoutStatus'))
negatives = []
for field in spec['components']['schemas']['CheckoutStatus']['required']:
    bad = copy.deepcopy(sample); del bad[field]; negatives.append(bad)
for field, value in [('state', 'paid'), ('fulfillment_state', 'queued'), ('version', '2'), ('version', 1.5), ('delivery', {'state': 'invented'}), ('delivery', {'state': 'queued', 'internal': True})]:
    bad = copy.deepcopy(sample); bad[field] = value; negatives.append(bad)
for bad in negatives:
    assert not validators['CheckoutStatus'].is_valid(bad), bad
for name in ['PaidEvent','OperationReceipt']:
 sample=json.loads(next(r['raw'] for r in records if r['schema']==name))
 for field in spec['components']['schemas'][name]['required']:
  bad=copy.deepcopy(sample);del bad[field];assert not validators[name].is_valid(bad);negatives.append(bad)
 bad={**sample,'secret':'unexpected'};assert not validators[name].is_valid(bad);negatives.append(bad)
print(json.dumps({'captured_contracts_validated':len(records),'schema_negative_controls':len(negatives),'openapi_sha256':hashlib.sha256(contract.read_bytes()).hexdigest(),'result':'passed'}))
