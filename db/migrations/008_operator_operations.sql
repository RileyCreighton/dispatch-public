-- Local owner setup is the only writer of bootstrap authority and password verifier.
CREATE TABLE dispatch.operator_identity (
 merchant_id text PRIMARY KEY CHECK(merchant_id='single'),
 trusted_origin text NOT NULL, bootstrap_hash dispatch.hash32 NOT NULL,
 bootstrap_expires_at timestamptz NOT NULL, initialized_at timestamptz,
 password_salt bytea, password_verifier bytea,
 CHECK ((initialized_at IS NULL AND password_salt IS NULL AND password_verifier IS NULL) OR
 (initialized_at IS NOT NULL AND octet_length(password_salt)=16 AND octet_length(password_verifier)=32))
);
GRANT SELECT ON dispatch.operator_identity TO dispatch_operator;
CREATE TABLE dispatch.operator_challenges (
 token_hash dispatch.hash32 PRIMARY KEY, csrf_hash dispatch.hash32 NOT NULL,
 expires_at timestamptz NOT NULL, consumed_at timestamptz
);
GRANT SELECT,INSERT,UPDATE ON dispatch.operator_challenges TO dispatch_operator;
CREATE TABLE dispatch.refund_observations (
 id uuid PRIMARY KEY, refund_id uuid NOT NULL REFERENCES dispatch.refunds(id),
 kind text NOT NULL, evidence jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER immutable_refund_observation BEFORE UPDATE OR DELETE ON dispatch.refund_observations
 FOR EACH ROW EXECUTE FUNCTION dispatch.reject_mutation();
GRANT SELECT,INSERT ON dispatch.refund_observations TO dispatch_operator,dispatch_worker;
GRANT SELECT ON dispatch.payment_incidents,dispatch.merchant_events,dispatch.merchant_receipts TO dispatch_operator;
GRANT SELECT ON dispatch.refunds TO dispatch_api;
-- No server-provided rejection assertion enables another wallet call in this build.
-- All bound rejected rows still retain permanent settlement/nonce exclusions.
CREATE FUNCTION dispatch.protect_operator_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.initialized_at IS NOT NULL OR ROW(NEW.merchant_id,NEW.trusted_origin) IS DISTINCT FROM ROW(OLD.merchant_id,OLD.trusted_origin)
 OR ((NEW.bootstrap_hash IS DISTINCT FROM OLD.bootstrap_hash OR NEW.bootstrap_expires_at IS DISTINCT FROM OLD.bootstrap_expires_at)
 AND (OLD.bootstrap_expires_at>clock_timestamp() OR NEW.initialized_at IS NOT NULL))
 THEN RAISE EXCEPTION 'operator initialization is permanent'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION dispatch.protect_operator_identity() FROM PUBLIC;
CREATE TRIGGER immutable_initialized_operator BEFORE UPDATE ON dispatch.operator_identity
 FOR EACH ROW EXECUTE FUNCTION dispatch.protect_operator_identity();
CREATE TRIGGER retain_operator_identity BEFORE DELETE ON dispatch.operator_identity
 FOR EACH ROW EXECUTE FUNCTION dispatch.reject_mutation();
ALTER TABLE dispatch.refunds ADD COLUMN scan_cursor bigint, ADD COLUMN scan_hash dispatch.hash32;
CREATE TABLE dispatch.runtime_health (
 service text PRIMARY KEY CHECK(service='operations_worker'), checked_at timestamptz NOT NULL
);
GRANT SELECT ON dispatch.runtime_health TO dispatch_api,dispatch_operator;
GRANT SELECT,INSERT,UPDATE ON dispatch.runtime_health TO dispatch_worker;

ALTER TABLE dispatch.refunds ADD COLUMN wallet_start_version bigint;
CREATE TABLE dispatch.refund_invocations (
 refund_id uuid NOT NULL REFERENCES dispatch.refunds(id), wallet_start_version bigint NOT NULL,
 operator_session uuid NOT NULL REFERENCES dispatch.operator_sessions(id), claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(refund_id,wallet_start_version)
);
CREATE TRIGGER immutable_refund_invocation BEFORE UPDATE OR DELETE ON dispatch.refund_invocations
 FOR EACH ROW EXECUTE FUNCTION dispatch.reject_mutation();
GRANT SELECT,INSERT ON dispatch.refund_invocations TO dispatch_operator;
GRANT SELECT ON dispatch.refund_invocations TO dispatch_worker;
CREATE TABLE dispatch.refund_transaction_hints (
 refund_id uuid NOT NULL REFERENCES dispatch.refunds(id), transaction_hash dispatch.hash32 NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(refund_id,transaction_hash)
);
CREATE TRIGGER immutable_refund_hint BEFORE UPDATE OR DELETE ON dispatch.refund_transaction_hints
 FOR EACH ROW EXECUTE FUNCTION dispatch.reject_mutation();
GRANT SELECT,INSERT ON dispatch.refund_transaction_hints TO dispatch_operator,dispatch_worker;
