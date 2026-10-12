# Agent purchase example

The maintained [purchase API](src/purchase.ts) uses the upstream x402 client through Dispatch's guarded buyer transport. [The durable journal](src/journal.ts) owns the one signing claim and same-order recovery. See [agent integration](../../docs/agent-integration.md).

The verified native demonstration (`./scripts/demo.sh local`) exercises this client with a separate agent purchase. The container-specific `./scripts/demo.sh agent` command remains unqualified until the complete container flow passes; it expects a published sample product and resumed local payments. The fixture driver generates a synthetic local wallet, performs an actual local-EVM purchase, loses the signed response deliberately, resumes the same order without signing again, and checks the private file bytes. Generated keys and grants are never printed. The buyer controls its own signing policy; this example is not a production signer or real-provider integration.
