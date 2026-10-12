# Existing merchant-site example

[server.ts](src/server.ts) serves an ordinary checkout form and an additive Dispatch purchase link. It does not proxy, replace or depend on Dispatch for the ordinary form. The fulfillment integration suite tests the form while Dispatch is unavailable.

From the repository root, `npm run demo:fulfillment` starts the isolated native demonstration for five minutes. See [getting started](../../docs/getting-started.md) for prerequisites. This example handles synthetic data only; it is not an integration claim about an existing merchant's production website.
