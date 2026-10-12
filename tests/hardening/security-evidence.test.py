"""Synthetic security-evidence binding controls; never actual artifact disposition.

No private ledger, scanner report or primary advisory is imported. These fixtures
exercise rejection semantics only; they do not establish a vulnerability exception.
"""
import copy
import hashlib
import json
from pathlib import Path
import sys
import unittest
import tempfile
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts'))
from security_evidence import verified_aliases, archive_tar_absence, load_go_advisories

class AliasTests(unittest.TestCase):
    def setUp(self):
        self.finding={'VulnerabilityID':'CVE-2026-56852','PkgName':'golang.org/x/text','References':['https://example.invalid/CVE-2026-56852/CVE-2026-56853']}
        self.record={'id':'GO-2026-5970','aliases':['CVE-2026-56852'],'affected':[{'package':{'ecosystem':'Go','name':'golang.org/x/text'}}]}
    def test_related_reference_not_alias(self):
        self.assertEqual(verified_aliases(self.finding,[])[0],['CVE-2026-56852'])
    def test_verified_alias(self):
        self.assertEqual(verified_aliases(self.finding,[(self.record,{})])[0],['CVE-2026-56852','GO-2026-5970'])
    def test_malformed_or_missing(self):
        for value in [None,'CVE-2026-56852',[None],['not-an-id']]:
            record={**self.record,'aliases':value}
            self.assertEqual(verified_aliases(self.finding,[(record,{})])[0],['CVE-2026-56852'])
    def test_duplicate_references(self):
        self.finding['References']*=4
        self.assertEqual(verified_aliases(self.finding,[(self.record,{})])[0],['CVE-2026-56852','GO-2026-5970'])
    def test_distinct_row_identity(self):
        self.finding['VulnerabilityID']='CVE-2026-56853'
        self.assertEqual(verified_aliases(self.finding,[(self.record,{})])[0],['CVE-2026-56853'])
    def test_wrong_component(self):
        self.finding['PkgName']='stdlib'
        self.assertEqual(verified_aliases(self.finding,[(self.record,{})])[0],['CVE-2026-56852'])
    def test_withdrawn(self):
        self.record['withdrawn']='2026-10-11'
        self.assertEqual(verified_aliases(self.finding,[(self.record,{})])[0],['CVE-2026-56852'])
    def test_hash_bound_synthetic_record(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);raw=json.dumps(self.record).encode();(root/'advisory.json').write_bytes(raw)
            receipt={'url':'https://vuln.go.dev/ID/GO-2026-5970.json','status':200,'path':'advisory.json','sha256':hashlib.sha256(raw).hexdigest()}
            (root/'receipts.json').write_text(json.dumps([receipt]));records=load_go_advisories(root,root/'receipts.json')
            self.assertEqual(verified_aliases(self.finding,records)[0],['CVE-2026-56852','GO-2026-5970'])
            (root/'advisory.json').write_bytes(raw+b' ')
            with self.assertRaises(ValueError):load_go_advisories(root,root/'receipts.json')

class PerlTests(unittest.TestCase):
    def setUp(self):
        self.spec={'stage':'build','image':'sha256:'+'1'*64}
        self.raw=b'PACKAGE\tperl-base\t5.36.0-7+deb12u4\nABSENCE_PROBES\nABSENT /usr/share/perl/5.36.0/Archive/Tar.pm\nREMOVAL_SIMULATION\n'
        self.receipt={'stage':'build','image':self.spec['image'],'platform':'linux/amd64','exit_code':0,'stdout_sha256':hashlib.sha256(self.raw).hexdigest(),'argv':['docker','run',self.spec['image'],'inspect /usr/share/perl/5.36.0/Archive/Tar.pm']}
        self.finding={'VulnerabilityID':'CVE-2026-9538','PkgName':'perl-base','InstalledVersion':'5.36.0-7+deb12u4'}
        self.vendor='CVE-2026-9538 Archive::Tar'
    def check(self):return archive_tar_absence(self.spec,self.finding,self.receipt,self.raw,self.vendor)
    def rehash(self):self.receipt['stdout_sha256']=hashlib.sha256(self.raw).hexdigest()
    def test_six_synthetic_stage_bindings(self):
        for stage in ['build','edge-build','fixtures','foundation-api','foundation-build','runtime']:
            spec={**self.spec,'stage':stage};receipt={**self.receipt,'stage':stage}
            self.assertTrue(archive_tar_absence(spec,self.finding,receipt,self.raw,self.vendor),stage)
    def test_synthetic_present_module(self):
        self.raw=self.raw.replace(b'ABSENT /usr/share/perl/5.36.0/Archive/Tar.pm',b'a'*64+b'  /usr/share/perl/5.36.0/Archive/Tar.pm');self.rehash();self.assertFalse(self.check())
    def test_wrong_module_only(self):
        self.raw=self.raw.replace(b'ABSENT /usr/share/perl/5.36.0/Archive/Tar.pm\n',b'');self.rehash();self.assertFalse(self.check())
    def test_present_module(self):
        self.raw=self.raw.replace(b'ABSENT /usr/share/perl/5.36.0/Archive/Tar.pm',b'a'*64+b'  /usr/share/perl/5.36.0/Archive/Tar.pm');self.rehash();self.assertFalse(self.check())
    def test_contradictory_presence(self):
        self.raw+=b'abc  /usr/share/perl/5.36.0/Archive/Tar.pm\n';self.rehash();self.assertFalse(self.check())
    def test_different_image(self):
        self.receipt['image']='sha256:wrong';self.assertFalse(self.check())
    def test_different_stage(self):
        self.receipt['stage']='runtime';self.assertFalse(self.check())
    def test_wrong_report_row(self):
        self.finding['VulnerabilityID']='CVE-2026-56852';self.assertFalse(self.check())
    def test_missing_receipt(self):
        self.receipt=None;self.assertFalse(self.check())
    def test_hash_mismatch(self):
        self.raw+=b'changed';self.assertFalse(self.check())
    def test_failed_inventory(self):
        self.receipt['exit_code']=1;self.assertFalse(self.check())
    def test_missing_advisory(self):
        self.vendor='CVE-2026-9538 IO::Compress';self.assertFalse(self.check())
    def test_full_perl_package(self):
        self.raw+=b'PACKAGE\tperl-modules-5.36\t5.36.0-7+deb12u4\n';self.rehash();self.assertFalse(self.check())
    def test_version_mismatch(self):
        self.finding['InstalledVersion']='5.36.0-7+deb12u3';self.assertFalse(self.check())
    def test_probe_not_in_command(self):
        self.receipt['argv'][-1]=self.receipt['argv'][-1].replace('/Archive/Tar.pm','/IO/Compress/Base.pm');self.assertFalse(self.check())

if __name__=='__main__':unittest.main(verbosity=2)
