# Dispatch

**Self-hostable x402 checkout and private digital delivery for existing websites.**

Dispatch adds a separate wallet and software-agent purchase path to a merchant's website. Publish a digital product, attach a private file, and add its purchase link to your site. Your existing checkout remains independent: Dispatch does not intercept its forms or replace its payment processor.

The API, worker, PostgreSQL ledger and private files run under the merchant's control. Payment verification, delivery and recovery have separate durable states, so an interrupted request does not become permission to charge again.

**Experimental developer preview.** The supported demonstration uses generated wallets, a synthetic USDC-compatible token and a non-forked local EVM. Mainnet payments are disabled. Production security, real named wallets and the container installation are not qualified; outstanding compiler/build-chain and image security findings remain unresolved. There is no independent audit certification. [Security and limitations](SECURITY.md).

## Features

- **Human purchasing:** browser wallet discovery, an exact quote and EIP-3009 authorization, exercised with a generated local wallet.
- **Agent purchasing:** the maintained upstream x402 client and EVM scheme, with explicit buyer policy and a durable private journal.
- **Payment state:** PostgreSQL settlement intent, worker reconciliation and independent transaction verification.
- **Private delivery:** order-scoped authentication and immutable file manifests; public transaction identifiers do not grant access.
- **Recovery:** recover the original purchase after a lost response without another authorization or signed submission.
- **Merchant operations:** product versions, payment and fulfillment pauses, readiness, receipts and manually approved refunds. Refunds preserve purchased access under the current policy.
- **Existing-checkout independence:** an ordinary purchase link and optional receipt adapter alongside the merchant's current flow.

Physical ordering and the future RPC gateway are not implemented. This preview does not establish compatibility with MetaMask, Rabby, every x402 client, or a live facilitator.

## Quick start

Supported host: **Linux x86_64**, **Node 24.21.0 / npm 11.19.0**, **Python 3.12+**, **PostgreSQL 17** (17.11 tested), OpenSSL, NSS `certutil` and Chromium's host libraries. Keep at least **2 GiB free in the checkout filesystem** and **512 MiB in `/tmp`**. Set `DISPATCH_TEST_PG_BIN` if PostgreSQL's binaries are not on PATH. [Prerequisite setup](docs/getting-started.md).

From an authorized checkout of this repository:

```sh
git clone https://github.com/RileyCreighton/dispatch-public.git
cd dispatch-public
./scripts/demo.sh local
```

The helper installs both exact npm lockfiles with lifecycle scripts disabled, builds the server and web application, prepares Chromium and runs the complete automated walkthrough. It starts its own socket-only PostgreSQL, generated TLS profile, non-forked EVM and local facilitator fixture. It does not read a `.env` file or require a provider account.

The walkthrough:

1. Configures **Local Demo Studio** and publishes **The local demonstration guide** through the real merchant UI.
2. Purchases the product for **100 atomic synthetic USDC units** using one generated-wallet authorization in Chromium.
3. Verifies the local transaction, downloads and compares the exact **35-byte private file**, and recovers access after browser reload.
4. Makes a separate upstream x402 agent purchase, deliberately loses its signed response, and retrieves the file through the original journal without signing or submitting payment again.
5. Stops the Dispatch API, submits the independent merchant checkout, then restores the API and checks the existing purchase.

It prints safe progress and a `COMPLETE` result, then closes its services and removes generated credentials and database state. Diagnostics and the sample download remain under `.local/test-results/local-demo-*`, excluded from Git. Ctrl-C stops the owned run; an interrupted or failed purchase is never retried automatically. Keep diagnostics private, and remove only a completed run's directory when no longer needed.

To watch the automated browser on an X11/XWayland desktop:

```sh
./scripts/demo.sh local --headed
```

During the run, the operator is at `https://127.0.0.1:18443/operator`, the generated buyer URL is printed, and the ordinary merchant example uses `http://127.0.0.1:18446`. These temporary URLs and generated browser credentials are managed by the helper; a separately opened browser does not have its fixture wallet or TLS trust. This is a run-and-exit developer walkthrough, not persistent hosting. [Troubleshooting](docs/troubleshooting.md).

## Architecture

```text
Existing website ── purchase link ──> Browser / upstream x402 agent
                                           │ HTTPS
                                      Web + API
                                      │       │
                              Private files  PostgreSQL ledger
                                                  │
                                                Worker
                                                  │
                               Local facilitator + local EVM

Existing checkout ──────────────────> Existing merchant backend
Dispatch delivery ── signed receipt ──> Optional merchant adapter
```

The API validates identity, immutable quotes and scoped grants. The worker commits settlement intent before network I/O, reconciles chain evidence and advances delivery separately. Private assets are served only after authentication and exact-byte validation. The demo invokes actual worker functions with a local facilitator fixture; it does not qualify a deployed worker or container installation. [Architecture](docs/architecture.md).

## Agent example

[The maintained example](examples/agent/README.md) exports `createPurchase`, `authorizePurchase`, `resumePurchase` and `retrievePurchase`. The buyer supplies an explicit spending policy and signer; Dispatch does not custody buyer keys.

```sh
# Includes a distinct agent transaction and lost-response recovery:
./scripts/demo.sh local
```

The runnable driver is [scripts/demo-native.mjs](scripts/demo-native.mjs). It calls the actual upstream x402 integration, checks one authorization and one signed submission, and compares recovered private bytes. [Agent integration](docs/agent-integration.md) documents journal and policy requirements.

## Development

```sh
npm ci --ignore-scripts
npm ci --prefix tests/payment/tooling --ignore-scripts
npm run build
npm run build:web
npm run check
npm run check:web
npm run lint
npm run format:check
npm test
python3 scripts/validate-public.py
python3 scripts/test-all.py
```

The full suite also needs Chromium and the Python response validators. See [Contributing](CONTRIBUTING.md) for setup, safety regressions and exact test categories. CI is manual and non-deploying; no remote CI pass is claimed.

The retained container tools are **not qualified** for this source revision. They are documented in [infra](infra/README.md) for investigation, not as the primary Quick Start. Do not supply funded wallets, live provider credentials or production databases.

[Configuration](docs/configuration.md) · [Buyer API](docs/buyer-api.md) · [Verification scope](docs/verification.md) · [Security reporting](SECURITY.md)

## License

**A public-source license has not yet been granted.** Apache-2.0 is the proposed license, pending owner approval and final attribution review. [LICENSE](LICENSE) states the current status; [NOTICE](NOTICE), [third-party notices](THIRD_PARTY_NOTICES.md) and the [licensing proposal](licenses/README.md) preserve upstream terms. Public visibility requires a separate owner decision after independent export review.
