# Contributing

Dispatch is an experimental developer preview. Public contribution and licensing terms remain owner-pending. Keep examples synthetic; do not submit keys, bearer grants, database dumps or private runtime logs.

Use the pinned Node/npm versions and both lockfiles. Install/build with the [getting-started instructions](docs/getting-started.md). PostgreSQL 17, Python validator packages, Chromium and NSS tools are needed for the full suite. `scripts/install-local-tools.py <new-private-directory>` optionally provisions pinned Node/PostgreSQL tools without changing system packages; building PostgreSQL requires an existing compiler and make.

```sh
npm run build
npm run build:web
npm run check
npm run check:web
npm run lint
npm run format:check
npm test
python3 scripts/test-foundation-topology.py
python3 tests/hardening/security-evidence.test.py
python3 scripts/validate-public.py
python3 scripts/test-all.py
```

`python3 scripts/test-local-demo.py` checks the generic local walkthrough, repeated execution, concurrent-start refusal and interruption cleanup. It uses real native services and must run separately from the other loopback suites.

`python3 scripts/test-transaction-lifecycle.py` exercises real checked-out timeouts, backend loss and unknown commit outcomes. `node --test tests/foundation/fixture-signer.test.mjs` checks demo signing refusal.

`python3 scripts/test-all.py` runs the safety selections in [tests/selections.json](tests/selections.json) serially, preserving private logs under `.local/test-results`. Select a named group, for example `python3 scripts/test-all.py buyer`, while developing. A selected pass is not full-suite evidence. The intentional contention negative control must fail at its actual competing-child diagnostic, not setup.

`npm run test:db`, `npm run test:payments`, `npm run test:payments:evm`, `npm run test:buyer`, `npm run test:fulfillment`, and `npm run test:operator` are smaller entrypoints. They start real disposable PostgreSQL clusters. No Docker/DB means blocked, not a mock pass. `python3 scripts/test-hardening.py restore` and `python3 scripts/test-hardening.py diagnostics` cover quarantined restoration and redacted captures. `python3 scripts/test-containers.py` exercises the full isolated container recovery sequence, including four fresh-volume restores. Stop the persistent demo first to release loopback ports.

Keep TypeScript strict and SQL parameterized. Preserve immutable migrations, durable bindings, authorization chronology, lease fences and private grant isolation. Never hold a database transaction across network I/O. Preserve genuine negative controls and failed attempts. Do not suppress findings, alter thresholds or weaken assertions to obtain a green result.

A pull request should state the concrete behavior change, reproduction, exact commands/results and limitations. Security-sensitive changes need fresh independent review. Local functional checks, browser fixtures, real wallets, container checks, advisory assessments and production tests are distinct categories. Remote CI is unrun until GitHub actually executes it. See [SECURITY](SECURITY.md) for disclosure and release restrictions.

The 23 security-evidence binding controls use explicit synthetic records. They test exact hashes, stage/image bindings, direct advisory aliases and rejection of contradictory package evidence. They never attest that an actual image is unaffected. Detailed occurrence assessment and image/build scanning remain separate required security work; the source candidate carries no private disposition ledger or vulnerability waivers.

Migration bytes and regression selector identifiers are compatibility inputs. Preserve their checksum and selection contracts; their historical labels do not assert release qualification.
