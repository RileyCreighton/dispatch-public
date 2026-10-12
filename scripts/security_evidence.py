"""Exact scanner identity, structured primary aliases and retained Perl proof binding.

References are citations, never alias assertions. No disposition or row deduplication
is performed by alias handling. Missing or inconsistent absence proof fails closed.
"""
import hashlib
import json
import re
from pathlib import Path

ID = re.compile(r'(?:CVE-\d{4}-\d+|GO-\d{4}-\d+|GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})\Z')
TAR_MODULE = '/usr/share/perl/5.36.0/Archive/Tar.pm'


def load_go_advisories(root, receipts_path):
    """Only hash-bound official Go OSV records may supply this adapter's aliases."""
    records = []
    for receipt in json.loads(Path(receipts_path).read_text()):
        url = receipt.get('url', '')
        if not re.fullmatch(r'https://vuln\.go\.dev/ID/GO-\d{4}-\d+\.json', url):
            continue
        if receipt.get('status') != 200 or receipt.get('final_url', url) != url:
            continue
        path = (root / receipt['path']).resolve()
        if not path.is_relative_to(root.resolve()):
            raise ValueError('primary path outside repository')
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != receipt['sha256']:
            raise ValueError('primary evidence hash mismatch')
        record = json.loads(raw)
        if record.get('id') != url.rsplit('/', 1)[1][:-5]:
            raise ValueError('primary advisory identity mismatch')
        records.append((record, receipt))
    return records


def verified_aliases(finding, primary_records):
    """Return identity plus direct structured aliases, never transitive URL matches.

    The actual scanner row's package and ID must both match the primary record.
    A malformed record contributes nothing; it cannot change the scanner identity.
    """
    identity = finding['VulnerabilityID']
    result = {identity}
    evidence = []
    for record, receipt in primary_records:
        aliases = record.get('aliases')
        rid = record.get('id')
        if (not isinstance(rid, str) or not ID.fullmatch(rid)
                or not isinstance(aliases, list)
                or not all(isinstance(a, str) and ID.fullmatch(a) for a in aliases)):
            continue
        if identity not in [rid, *aliases] or record.get('withdrawn'):
            continue
        packages = [a.get('package', {}) for a in record.get('affected', []) if isinstance(a, dict)]
        if not any(p.get('ecosystem') == 'Go' and p.get('name') == finding['PkgName'] for p in packages):
            continue
        result.update([rid, *aliases])
        evidence.append(receipt)
    return sorted(result), evidence


def archive_tar_absence(spec, finding, receipt, raw, vendor_text):
    """Validate the exact retained image/stage inventory for CVE-2026-9538.

    This is package/component absence evidence for the recorded immutable artifact,
    not a fresh image inspection or a proof for arbitrary Perl installations.
    """
    if (finding.get('VulnerabilityID') != 'CVE-2026-9538'
            or finding.get('PkgName') != 'perl-base'
            or finding.get('InstalledVersion') != '5.36.0-7+deb12u4'):
        return False
    if not receipt or not isinstance(raw, bytes) or not vendor_text:
        return False
    if (receipt.get('stage') != spec.get('stage')
            or receipt.get('image') != spec.get('image')
            or receipt.get('platform') != 'linux/amd64'
            or receipt.get('exit_code') != 0
            or hashlib.sha256(raw).hexdigest() != receipt.get('stdout_sha256')):
        return False
    # The command receipt must actually inspect the module in the bound image.
    argv = receipt.get('argv', [])
    if spec['image'] not in argv or not argv or TAR_MODULE not in argv[-1]:
        return False
    if 'Archive::Tar' not in vendor_text or 'CVE-2026-9538' not in vendor_text:
        return False
    text = raw.decode('utf-8', errors='strict')
    lines = text.splitlines()
    if lines.count('ABSENCE_PROBES') != 1 or lines.count('REMOVAL_SIMULATION') != 1:
        return False
    probes = text.split('ABSENCE_PROBES\n', 1)[1].split('REMOVAL_SIMULATION\n', 1)[0].splitlines()
    if probes.count('ABSENT ' + TAR_MODULE) != 1:
        return False
    if any('Archive/Tar.pm' in line and line != 'ABSENT ' + TAR_MODULE for line in lines):
        return False
    packages = [line.split('\t') for line in lines if line.startswith('PACKAGE\t')]
    base = [p for p in packages if len(p) > 2 and p[1] == 'perl-base']
    if len(base) != 1 or base[0][2] != finding['InstalledVersion']:
        return False
    if any(len(p) > 1 and (p[1].startswith(('perl-modules', 'libarchive-tar-perl', 'libperl')) or p[1] == 'perl') for p in packages):
        return False
    return True
