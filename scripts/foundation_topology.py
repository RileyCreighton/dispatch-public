"""Bounded static contract for the reviewed, single-file foundation Compose source.

This is deliberately not a Compose renderer. Accept only literal JSON (a YAML
subset), explicit network lists and the reviewed short-form port. Reject merge,
include, inheritance and interpolation inputs instead of guessing their effective
values. Runtime/CLI overrides still require the existing container verifier.
"""
import json


def load_literal_compose(text):
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            assert key not in result, 'duplicate_compose_key: ' + key
            result[key] = value
        return result

    # Compose interpolates JSON string values too. Do not consult environment
    # files or accept even a currently safe default that the environment can alter.
    def invalid_constant(value):
        raise ValueError('non_json_constant: ' + value)

    compose = json.loads(text, object_pairs_hook=unique_object, parse_constant=invalid_constant)
    assert '$' not in json.dumps(compose), 'compose_interpolation_refused'
    return compose


def validate_topology(compose):
    assert set(compose) == {'name', 'services', 'networks', 'volumes'}, 'compose_composition_refused'
    expected = {
        'postgres': {'data'}, 'migration': {'data'}, 'api': {'app', 'data'},
        'worker': {'data'}, 'edge': {'app', 'ingress'},
    }
    assert set(compose['services']) == set(expected), 'unexpected_services'
    assert set(compose['networks']) == {'app', 'data', 'ingress'}, 'unexpected_networks'
    for name, network in compose['networks'].items():
        # Project-owned default bridge networks only: no external/name/driver,
        # driver_opts, IPAM or other settings that alter network isolation.
        assert set(network) == {'internal'}, 'network_override_refused: ' + name
        assert network['internal'] is (name != 'ingress'), 'network_isolation: ' + name
    allowed_fields = {
        'build', 'image', 'platform', 'user', 'read_only', 'cap_drop', 'security_opt',
        'tmpfs', 'pids_limit', 'mem_limit', 'init', 'networks', 'environment',
        'depends_on', 'profiles', 'command', 'volumes', 'healthcheck', 'ports',
        'restart', 'entrypoint',
    }
    for name, service in compose['services'].items():
        # In particular reject network_mode (host/service/container/none),
        # extends, provider, cap_add, privileged, env_file and secrets.
        assert set(service) <= allowed_fields, 'service_override_refused: ' + name
        networks = service.get('networks')
        assert isinstance(networks, list) and all(isinstance(n, str) for n in networks), 'explicit_network_list_required: ' + name
        assert len(networks) == len(expected[name]) and set(networks) == expected[name], 'network_topology: ' + name
        if name == 'edge':
            # Exact host IP, host port, container port and implicit TCP; reject
            # omitted IPs, wildcards, IPv6, ranges, UDP and extra publications.
            assert service.get('ports') == ['127.0.0.1:8080:8080'], 'loopback_caddy_port_required'
        else:
            assert 'ports' not in service, 'non_caddy_publication: ' + name
