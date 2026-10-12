# Configuration

This candidate deliberately provides a local-only composition. It does not load a `.env` file, accept production database/RPC URLs, or enable mainnet through an environment switch. `.env.example` documents optional nonsecret developer tool settings; it is not a deployment template.

## Merchant configuration

The local bootstrap command creates a password verifier and trusted loopback origin. It does not create a merchant/product or permit payment. `demo.sh up` invokes this CLI with a generated password on stdin. The operator signs in, saves receiving wallet twice, merchant name and a versioned policy URL, then publishes a product tied to an imported immutable asset. Prices are **integer token units**, six decimals. Tax treatment must be explicit.

Payment and fulfillment pauses are independent. Resume only the generated local demonstration. Unknown payment outcomes retain their original attempt and budget exposure. Refunds require fresh operator and wallet authority; refunded purchases keep access under the current policy.

For the native inspection runtime, its printed environment identifies the newly generated socket-only database. With that environment in a second terminal, run:

```sh
node scripts/operator-local.mjs begin https://127.0.0.1:18443 /tmp/dispatch-operator-bootstrap
node scripts/operator-local.mjs complete /tmp/dispatch-operator-bootstrap
```

The first command refuses an existing file and writes a mode-0600 one-time capability. The second reads the chosen password from stdin; end input with EOF. Use a password manager/piped private file outside source control. Never pass a password as an argument. The private bootstrap expires after fifteen minutes; initialization cannot be repeated against an initialized database.

## Local tools

| Setting | Meaning |
| --- | --- |
| `DISPATCH_TEST_PG_BIN` | PostgreSQL 17 bin directory for native tests; otherwise discovered on PATH |
| `DISPATCH_BROWSER_PATH` | Existing compatible Chromium executable; otherwise Playwright's installed Chromium |
| `PLAYWRIGHT_BROWSERS_PATH` | Optional isolated Playwright browser/video-tool installation directory |
| `DISPATCH_SCHEMA_PYTHON` | Python executable in the virtual environment containing response validators |
| `DOCKER_HOST`, `DOCKER_CONFIG` | Ordinary Docker connection settings for a local rootless daemon |
| `npm_config_cache` | Optional verified npm download cache |

Container-local `DISPATCH_MODE=local`, `DISPATCH_RUNTIME=digital-fixture` and `DISPATCH_DB_HOST=postgres` are fixed by the owned composition. API/worker/migration/operator use separate database roles; public `fixture-only-*` passwords are disposable values, never production credentials.

## Future deployment

Production has no supported enablement recipe in this candidate. A separately reviewed composition must qualify actual Base/native USDC, provider authentication, RPC, real wallet integration, public TLS/ingress, scoped secret delivery, key custody, backups/recovery, security and operations. Secrets must be provisioned separately from source and image layers. Do not mount a production `.env`, wallet, key directory or database into the demo.
