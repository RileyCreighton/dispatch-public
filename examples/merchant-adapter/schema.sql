-- Apply only to the isolated reference merchant database/schema, as its owner.
CREATE SCHEMA merchant_adapter;
CREATE TABLE merchant_adapter.orders (
 merchant_order_id text PRIMARY KEY, event_id uuid NOT NULL UNIQUE, effect_id text NOT NULL UNIQUE,
 dispatch_order_id uuid NOT NULL UNIQUE, content_hash text NOT NULL, receipt_id uuid NOT NULL UNIQUE,
 payment_state text NOT NULL CHECK(payment_state='recorded'), fulfillment_state text NOT NULL CHECK(fulfillment_state='scheduled'),
 shipment_state text NOT NULL CHECK(shipment_state='not_applicable'), created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- A single atomic row is order + durable deduplication + receipt. No processed marker before order creation.
REVOKE ALL ON SCHEMA merchant_adapter FROM PUBLIC;
REVOKE ALL ON merchant_adapter.orders FROM PUBLIC;
