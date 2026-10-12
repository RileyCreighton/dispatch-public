"""Reuse the documented disposable operator topology; execute the new hardening selection."""
import pathlib, os, sys
root=pathlib.Path(__file__).resolve().parents[1]
source=(root/'scripts/test-operator.py').read_text()
selection=sys.argv[1] if len(sys.argv)>1 else 'restore'
assert selection in ['restore','diagnostics']
sys.argv=sys.argv[:1]
source=source.replace("'tests/operator/integration.test.mjs'", repr('tests/hardening/'+selection+'.test.mjs'))
source=source.replace("root / '.local/test-results'", "root / '.local/test-results'")
source=source.replace("env['NODE_EXTRA_CA_CERTS']=str(base/'tls.crt')", "env['NODE_EXTRA_CA_CERTS']=str(base/'tls.crt')\n    env['DISPATCH_TEST_PG_BIN']=str(pg)")
# The operator recovery tail expects suite-specific rows; new tests verify their own stale backups.
start=source.index('    before = run(')
end=source.index('\nfinally:',start)
source=source[:start]+source[end:]
exec(compile(source,str(root/'scripts/test-operator.py'),'exec'),{'__file__':str(root/'scripts/test-operator.py'),'__name__':'__main__'})
