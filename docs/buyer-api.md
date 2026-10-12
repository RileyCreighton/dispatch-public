# Buyer API

The machine-readable interface is [OpenAPI](architecture/openapi.yaml). Its schema also describes reserved/disabled interfaces; actual runtime admission and tests determine supported behavior. The preview supports digital quantity-one purchases only.

Discover a published product, create a purchase scoped to the buyer, read its immutable policy, confirm that policy and request an exact quote. The payment route returns an x402 `PAYMENT-REQUIRED` challenge. The buyer's upstream client constructs one EIP-3009 authorization and submits `PAYMENT-SIGNATURE`. A successful submission is not proof of settlement: poll authenticated purchase status until independent settlement and delivery evidence exist.

Agent/recovery grants are private bearer capabilities scoped to one order. Browser cookies and CSRF protect browser state; a public order ID or transaction hash grants no access. Keep credentials out of URLs, logs, screen recordings and shell arguments. Recovery must use the original journal/grant and original order. There is no generic retry that creates another signature or settlement effect.

Use the [maintained agent API](../examples/agent/src/purchase.ts) rather than hand-building a signed replay. It exposes `createPurchase`, `authorizePurchase`, `resumePurchase` and `retrievePurchase`. See [agent integration](agent-integration.md) for policy and persistence requirements.

Delivery exposes status separately from payment. Download only through the authenticated route once available; exact bytes must match the immutable asset digest. Range/traversal/symlink and cross-buyer access regressions are included in the test suite. Webhook receiver receipts and manually approved refunds are separate state dimensions.
