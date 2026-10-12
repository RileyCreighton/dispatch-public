# Getting started

## Prerequisites

Use Linux x86_64, Node **24.21.0**, npm **11.19.0**, Python **3.12+**, PostgreSQL **17** (17.11 tested), OpenSSL, NSS `certutil`, and Chromium's host shared libraries. The helper does not install system packages, use sudo or modify system certificate trust. Registry and browser-download access is needed on first use. Reserve at least 2 GiB in the checkout filesystem and 512 MiB in `/tmp`.

Expose PostgreSQL's `postgres`, `pg_ctl`, `initdb` and `psql` on PATH, or set `DISPATCH_TEST_PG_BIN` to their directory. Full regression tests additionally require `pg_dump`, `pg_restore` and the pinned validators in [python-requirements.txt](../tests/hardening/python-requirements.txt).

If you have a C compiler, GNU make and Python venv support, the optional helper downloads checksum-pinned Node and PostgreSQL archives, builds PostgreSQL and installs the validator environment. Choose a new, nonexistent directory:

```sh
python3 scripts/install-local-tools.py /tmp/dispatch-dev-tools
export PATH="/tmp/dispatch-dev-tools/node-v24.21.0-linux-x64/bin:$PATH"
export DISPATCH_TEST_PG_BIN=/tmp/dispatch-dev-tools/pg17/bin
export DISPATCH_SCHEMA_PYTHON=/tmp/dispatch-dev-tools/python/bin/python
```

These tools are disposable and may disappear after reboot. Browser system libraries and Docker are not installed by this helper.

## Native demo

```sh
./scripts/demo.sh local
```

This is an automated run-and-exit walkthrough. First use runs both locked npm installations with lifecycle scripts disabled, builds current server/web source and prepares the pinned Chromium browser. Later runs reuse dependencies only when their lock identity and required files match; source is rebuilt every time. Set `PLAYWRIGHT_BROWSERS_PATH` to reuse an existing matching browser download.

The real operator UI publishes a private digital product. The browser purchase uses one generated-wallet authorization; worker functions independently check local settlement before the exact private file becomes available. A separate upstream x402 purchase loses its signed response and recovers the same order without another signature or submission. The ordinary merchant checkout succeeds with the Dispatch API stopped, after which the existing purchase recovers through the restarted API.

To see the browser on an X11/XWayland desktop with `DISPLAY` configured:

```sh
./scripts/demo.sh local --headed
```

The managed browser uses a temporary NSS profile for its generated TLS certificate and its own fixture wallet. It never changes host trust. Operator: `https://127.0.0.1:18443/operator`; buyer: the generated purchase URL printed by the helper; ordinary merchant: `http://127.0.0.1:18446`. They exist only while the walkthrough runs. PostgreSQL accepts private Unix sockets only. Ports 18443, 18446, 18546 and 19999 must be free; another active demo or full validation run is refused.

The sample is **The local demonstration guide**, priced at `100` atomic units (0.000100 synthetic USDC). Its file is `Private local demonstration guide.` plus a newline, exactly 35 bytes. All wallet keys, TLS keys, session material and agent journals are generated locally and removed with the disposable runtime. No real funds or Base connection are needed. Base-shaped identifiers exercise the application contract against a non-forked local chain; they do not enable mainnet.

## Shutdown and local results

Completion closes services automatically. Ctrl-C or SIGTERM also stops owned services; failed/interrupted execution remains failed. Private diagnostics and `native-result.json` are printed under `.local/test-results/local-demo-*`. The result records authorization/submission counts, distinct local transactions, byte equality and recovery assertions without keys or capabilities. Keep logs private. After shutdown, you may remove that exact run directory; never delete an unresolved production ledger as a repair.

If an npm installation is damaged, remove only `.local/native-dependencies.json` to request a locked reinstall on the next run. The helper does not retry failed payments. [Troubleshooting](troubleshooting.md).

## Development and container tools

Read [Contributing](../CONTRIBUTING.md) for compilation and the full safety suite. The [container tools](../infra/README.md) require rootless Docker and more than 20 GiB free in its actual store; their complete installation/recovery flow is not qualified for this revision. Native success does not replace container verification.
