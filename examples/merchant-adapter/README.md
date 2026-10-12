# Merchant receipt adapter

The [receiver](src/server.ts) verifies a configured signature/bearer boundary and records idempotent merchant receipts in PostgreSQL using [schema.sql](schema.sql). A durable receipt means the receiver recorded the handoff; it does not establish shipment or inventory allocation.

The container test starts this receiver with generated fixture material, private networking and an isolated journal. Keep webhook keys separate from source in any future reviewed deployment. Retries may deliver the same event; they must not create a second business effect. The ordinary merchant checkout is independent of this optional adapter.
