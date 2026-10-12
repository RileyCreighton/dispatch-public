"""Offline regression tests for the active foundation static topology contract."""
import copy
import json
import pathlib
import unittest

from foundation_topology import load_literal_compose, validate_topology

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = (ROOT / 'infra/compose.yaml').read_text()
APPROVED = load_literal_compose(SOURCE)


def check(compose):
    # Exercise the same parser and assertions as verify-foundation.py.
    validate_topology(load_literal_compose(json.dumps(compose)))


class Topology(unittest.TestCase):
    def test_unchanged_approved_compose_passes(self):
        validate_topology(load_literal_compose(SOURCE))

    def test_source_matches_reviewed_effective_topology(self):
        # Exact public baseline plus semantic negative controls below; not historical execution evidence.
        import hashlib
        expected = json.loads((ROOT / 'tests/foundation/source-contract.json').read_text())
        self.assertEqual(hashlib.sha256(SOURCE.encode()).hexdigest(), expected['compose_sha256'])
        self.assertEqual(APPROVED['services']['postgres']['healthcheck']['test'][1],
                         'pg_isready -h 127.0.0.1 -U local_cluster_admin -d dispatch')
        self.assertEqual(APPROVED['services']['postgres']['healthcheck']['start_period'], '180s')

    def test_duplicate_key_refused(self):
        text = SOURCE.replace('"internal": true', '"internal": false, "internal": true', 1)
        with self.assertRaisesRegex(AssertionError, 'duplicate_compose_key'):
            validate_topology(load_literal_compose(text))

    def test_escaped_interpolation_refused(self):
        text = SOURCE.replace('127.0.0.1:8080:8080', r'\u0024{BIND:-127.0.0.1}:8080:8080')
        with self.assertRaisesRegex(AssertionError, 'compose_interpolation_refused'):
            validate_topology(load_literal_compose(text))

    def test_yaml_merge_representation_refused(self):
        with self.assertRaises(json.JSONDecodeError):
            load_literal_compose('services: &base\n  edge: {}\nnetworks: {<<: *base}\n')


def rejection(name, path, value, reason, delete=False):
    def test(self):
        config = copy.deepcopy(APPROVED)
        target = config
        for part in path[:-1]:
            target = target[part]
        if delete:
            del target[path[-1]]
        else:
            target[path[-1]] = value
        with self.assertRaisesRegex(AssertionError, reason):
            check(config)
    setattr(Topology, 'test_reject_' + name, test)


for network in ['app', 'data', 'ingress']:
    for label, value in [('reversed', network == 'ingress'), ('string', 'false'), ('number', 1)]:
        rejection(network + '_' + label, ['networks', network, 'internal'], value, 'network_isolation')
    rejection(network + '_implicit', ['networks', network, 'internal'], None, 'network_override', delete=True)
    for field, value in [('external', True), ('name', 'host'), ('driver', 'host'),
                         ('driver_opts', {'com.docker.network.bridge.gateway_mode_ipv4': 'nat-unprotected'}),
                         ('ipam', {'driver': 'default'})]:
        rejection(network + '_' + field, ['networks', network, field], value, 'network_override')
rejection('extra_noninternal_network', ['networks', 'public'], {'internal': False}, 'unexpected_networks')
rejection('extra_internal_network', ['networks', 'extra'], {'internal': True}, 'unexpected_networks')
rejection('missing_ingress_network', ['networks', 'ingress'], None, 'unexpected_networks', delete=True)
rejection('unauthorized_ingress_service', ['services', 'other'], {'networks': ['ingress']}, 'unexpected_services')
for service in ['api', 'worker', 'postgres', 'migration']:
    rejection(service + '_ingress', ['services', service, 'networks'],
              APPROVED['services'][service]['networks'] + ['ingress'], 'network_topology')
    rejection(service + '_publication', ['services', service, 'ports'], ['127.0.0.1:8080:8080'], 'non_caddy_publication')
for service in APPROVED['services']:
    rejection(service + '_missing_membership', ['services', service, 'networks'], [], 'network_topology')
    rejection(service + '_implicit_default', ['services', service, 'networks'], None, 'explicit_network_list', delete=True)
    for mode in ['host', 'service:edge', 'container:external', 'none']:
        rejection(service + '_mode_' + mode, ['services', service, 'network_mode'], mode, 'service_override')
rejection('caddy_missing_ingress', ['services', 'edge', 'networks'], ['app'], 'network_topology')
rejection('caddy_data', ['services', 'edge', 'networks'], ['app', 'ingress', 'data'], 'network_topology')
rejection('api_data_missing', ['services', 'api', 'networks'], ['app'], 'network_topology')
rejection('membership_options', ['services', 'edge', 'networks'], {'app': None, 'ingress': {}}, 'explicit_network_list')
for label, ports in {
    'wildcard_ipv4': ['0.0.0.0:8080:8080'], 'unrestricted': ['8080:8080'],
    'empty_ip': [':8080:8080'], 'wildcard_ipv6': ['[::]:8080:8080'],
    'unapproved_ipv6_loopback': ['[::1]:8080:8080'], 'dynamic_port': ['8080'],
    'udp': ['127.0.0.1:8080:8080/udp'], 'extra_port': ['127.0.0.1:8080:8080', '127.0.0.1:8443:443'],
    'changed_target': ['127.0.0.1:8080:80'], 'changed_published': ['127.0.0.1:8081:8080'],
    'missing_port': [], 'long_unrestricted': [{'target': 8080, 'published': '8080'}],
    'interpolated_binding': ['${BIND:-127.0.0.1}:8080:8080'],
}.items():
    rejection(label, ['services', 'edge', 'ports'], ports,
              'compose_interpolation' if label == 'interpolated_binding' else 'loopback_caddy_port')
rejection('include', ['include'], ['override.yaml'], 'compose_composition')
rejection('extends', ['services', 'api', 'extends'], {'file': 'override.yaml', 'service': 'api'}, 'service_override')
for field, value in [('privileged', True), ('cap_add', ['NET_ADMIN']),
                     ('env_file', 'production.env'), ('secrets', ['production'])]:
    rejection(field, ['services', 'api', field], value, 'service_override')


if __name__ == '__main__':
    unittest.main(verbosity=2)
