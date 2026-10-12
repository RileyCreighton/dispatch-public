# Architecture

Dispatch adds an ordinary purchase link to an existing merchant site. Its API/worker/frontend share strict TypeScript packages; PostgreSQL is the durable ledger and outbox. There is no mandatory Dispatch cloud or custody service.

| Component | Responsibility |
| --- | --- |
| `apps/web` | React checkout, wallet discovery, private recovery journal and operator UI |
| `apps/api` | Input/authentication checks, immutable quote binding, durable payment acceptance, status and downloads |
| `apps/worker` | One authorized settlement call, independent chain reconciliation, outbox delivery and refund observation |
| `packages/db` | Parameterized SQL, short transactions, role boundaries, leases, migrations and audit |
| `packages/payments` | x402 wire contracts, exact EIP-3009 semantics and independent RPC evidence |
| `packages/buyer` | Guarded upstream buyer transport and signer boundary |
| `packages/fulfillment` | Private immutable file manifests and signed merchant handoffs |
| Caddy | TLS/static frontend and routing, with no private asset or database mount |

The retained container recipe adds PostgreSQL, a non-forked Anvil chain, a synthetic token and a labelled facilitator sidecar. Its complete installation and recovery remain unqualified for this revision. Only Caddy publishes a loopback port. Services run without root, with read-only root filesystems, dropped capabilities and resource limits. API/worker share the fixture network namespace for fixed loopback RPC/provider endpoints. Only the demo-specific Caddy configuration exposes authenticated operator routes on loopback; the default edge refuses them.

The primary native walkthrough instead runs a socket-only PostgreSQL cluster, local HTTPS API, managed Chromium browser, non-forked EVM and an in-process facilitator fixture. It invokes actual worker functions for settlement and delivery, then removes its generated runtime on exit. It does not run Caddy or establish a persistent container deployment.

## Payment safety

Persist the original immutable order/quote/nonce before allowing the first settlement call. Never hold a database transaction across network I/O. Record one durable call intent. A timeout, expired authorization or missing receipt does not authorize another call, fresh signature or exposure release. Read-only reconciliation may examine an existing reference, but public transaction/signature data is never buyer authentication. Credit requires independently validated exact transaction evidence and current fenced authority.

Browser and server cannot make a wallet call atomic. Already-started outcomes remain evidence. Refund invocation ownership, final authorization, wallet-call reports and confirmed reconciliation are distinct. Private delivery follows a scoped authenticated grant and the exact purchased asset version, not possession of a public receipt. Merchant receipts prove durable receiver bookkeeping; they are not shipment evidence.

## Recovery

Retain database history, immutable assets/manifests and matching encryption material together. A restored database cannot prove that no later wallet invocation occurred. Restore gates therefore remain quarantined and paused until proper reconciliation. The container tools retain synthetic chain state for restart investigations; that path remains unqualified here. The native walkthrough checks API restart and same-purchase recovery within one run, then removes the disposable runtime. Neither is production backup evidence.

Numbered SQL migration bytes are intentionally immutable, including legacy test identifiers in comments. Do not edit their checksums to clean up wording. Add forward migrations with real PostgreSQL upgrade/recovery tests.

Physical ordering and a future easy-setup RPC gateway are roadmap items only. No implementation, UI or production enablement is promised here.
