-- BUILD-005: retain immutable fulfillment identity and append-only dispatch attempts.
CREATE FUNCTION dispatch.protect_entitlement_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.order_id,NEW.product_id,NEW.product_version,NEW.settlement_id,NEW.asset_id,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.order_id,OLD.product_id,OLD.product_version,OLD.settlement_id,OLD.asset_id,OLD.created_at)
 OR (OLD.state='revoked' AND NEW.state<>'revoked') THEN RAISE EXCEPTION 'immutable entitlement identity'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION dispatch.protect_entitlement_identity() FROM PUBLIC;
CREATE TRIGGER immutable_entitlement_identity BEFORE UPDATE ON dispatch.entitlements
 FOR EACH ROW EXECUTE FUNCTION dispatch.protect_entitlement_identity();
CREATE TRIGGER no_entitlement_delete BEFORE DELETE ON dispatch.entitlements
 FOR EACH ROW EXECUTE FUNCTION dispatch.reject_mutation();
CREATE TABLE dispatch.merchant_events (
 event_id uuid PRIMARY KEY, job_id uuid NOT NULL UNIQUE REFERENCES dispatch.outbox_jobs(id),
 order_id uuid NOT NULL UNIQUE REFERENCES dispatch.orders(id), effect_id text NOT NULL UNIQUE,
 target_id text NOT NULL, target_binding dispatch.hash32 NOT NULL, raw_body text NOT NULL CHECK(octet_length(raw_body)<=32768),
 body_hash dispatch.hash32 NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER immutable_merchant_event BEFORE UPDATE OR DELETE ON dispatch.merchant_events
 FOR EACH ROW EXECUTE FUNCTION dispatch.reject_mutation();
CREATE TABLE dispatch.merchant_receipts (
 event_id uuid PRIMARY KEY REFERENCES dispatch.merchant_events(event_id),
 receipt_id text NOT NULL, merchant_order_id text NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER immutable_merchant_receipt BEFORE UPDATE OR DELETE ON dispatch.merchant_receipts
 FOR EACH ROW EXECUTE FUNCTION dispatch.reject_mutation();
CREATE TABLE dispatch.webhook_results (
 attempt_id uuid PRIMARY KEY REFERENCES dispatch.webhook_attempts(id),
 http_status integer CHECK(http_status BETWEEN 100 AND 599),
 safe_code text NOT NULL CHECK(safe_code IN ('committed','unknown','rejected','conflict')),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER immutable_webhook_result BEFORE UPDATE OR DELETE ON dispatch.webhook_results
 FOR EACH ROW EXECUTE FUNCTION dispatch.reject_mutation();
GRANT SELECT,INSERT ON dispatch.merchant_events,dispatch.merchant_receipts,dispatch.webhook_results TO dispatch_worker;
GRANT SELECT ON dispatch.merchant_receipts TO dispatch_api;
GRANT SELECT(order_id) ON dispatch.payment_incidents TO dispatch_api;
GRANT SELECT(order_id,effect_type,state) ON dispatch.outbox_jobs TO dispatch_api;
GRANT SELECT(event_id,order_id) ON dispatch.merchant_events TO dispatch_api;
CREATE FUNCTION dispatch.protect_delivery_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.effect_type IN ('entitlement','merchant_paid') AND
 ROW(NEW.id,NEW.order_id,NEW.attempt_id,NEW.effect_type,NEW.effect_version,NEW.effect_key,NEW.payload_reference,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.order_id,OLD.attempt_id,OLD.effect_type,OLD.effect_version,OLD.effect_key,OLD.payload_reference,OLD.created_at)
 THEN RAISE EXCEPTION 'immutable delivery job'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION dispatch.protect_delivery_job() FROM PUBLIC;
CREATE TRIGGER immutable_delivery_job BEFORE UPDATE ON dispatch.outbox_jobs
 FOR EACH ROW EXECUTE FUNCTION dispatch.protect_delivery_job();
