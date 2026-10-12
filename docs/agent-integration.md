# Agent integration

The maintained example is [purchase.ts](../examples/agent/src/purchase.ts), with an exclusive [file journal](../examples/agent/src/journal.ts). It uses the pinned upstream x402 client/fetch and exact EVM scheme through the guarded buyer package. The buyer controls its signing policy and supplies its own signer; Dispatch does not custody buyer keys.

A policy binds the origin, product/version, maximum integer amount, permitted payee, network/token and accepted policy version/URLs. Persist a private journal before authorizing. The journal permanently reserves signing ownership so two processes cannot both sign the same purchase. Keep it on a private local filesystem, outside public source, backups intended for sharing and browser-visible assets.

`createPurchase(policy, directory)` creates the durable journal. `authorizePurchase(directory, policy, signer)` may perform its one authorization. After response loss, use `resumePurchase(directory)` and `retrievePurchase(directory)` for the same recorded order. Do not call authorize again, fabricate a confirmation or infer no broadcast from a timeout. A saved signature does not grant permission to resend before server acceptance.

For the verified native fixture that includes an independent agent purchase:

```sh
./scripts/demo.sh local
```

The container-specific `./scripts/demo.sh agent` command is retained for the incomplete container qualification and is not claimed as a passing installation path.

The fixture driver derives policy from the configured local merchant/product, creates a generated synthetic signer, submits once, deliberately loses the response after delivery to the server, recovers by authenticated status, verifies settlement and compares the actual private download. Output contains no key, bearer token or journal capability. The private journal persists outside the checkout. Successful execution proves local compatibility only; a production facilitator and real signing policy need separate qualification.
