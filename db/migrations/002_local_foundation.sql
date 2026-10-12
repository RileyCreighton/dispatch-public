-- BUILD-002 enforcement of the accepted R3 contract plus AM-B1-001.
ALTER DEFAULT PRIVILEGES FOR ROLE dispatch_migrator IN SCHEMA dispatch REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE dispatch_migrator IN SCHEMA dispatch REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA dispatch FROM PUBLIC;
REVOKE ALL ON schema_migrations FROM dispatch_api,dispatch_worker,dispatch_operator;
GRANT SELECT ON schema_migrations TO dispatch_api,dispatch_worker,dispatch_operator;
-- Never round authorization timestamps before validation.
ALTER TABLE payment_attempts ALTER COLUMN valid_after TYPE atomic_amount,
  ALTER COLUMN valid_before TYPE atomic_amount;
-- Read access is scoped by process role as well as by application grant checks.
REVOKE SELECT ON operator_sessions FROM dispatch_worker;
REVOKE SELECT ON payment_attempts FROM dispatch_operator;
GRANT SELECT(id,order_id,quote_id,network,token,authorizer,payee,amount,nonce,typed_digest,
  operation_id,state,version,created_at) ON payment_attempts TO dispatch_operator;
REVOKE UPDATE ON merchant_control FROM dispatch_operator;
GRANT UPDATE(config_id,payment_paused,fulfillment_paused,max_order,max_day_gross,version)
  ON merchant_control TO dispatch_operator;
ALTER TABLE merchant_control ADD CONSTRAINT local_mainnet_disabled CHECK(NOT mainnet_enabled AND NOT physical_enabled);
CREATE TRIGGER immutable_support BEFORE UPDATE OR DELETE ON provider_capability_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER retain_authorization BEFORE DELETE ON payment_attempts FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER immutable_idempotency BEFORE UPDATE OR DELETE ON idempotency_records FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER immutable_observation BEFORE UPDATE OR DELETE ON submission_observations FOR EACH ROW EXECUTE FUNCTION reject_mutation();
ALTER TABLE submission_observations ADD CONSTRAINT initial_observation_only CHECK(call_number=1);

CREATE TABLE call_intents (
 id uuid PRIMARY KEY, attempt_id uuid NOT NULL, order_id uuid NOT NULL,
 operation text NOT NULL CHECK(operation IN ('verify','settle')),
 job_id uuid NOT NULL, lease_owner uuid NOT NULL, fence bigint NOT NULL CHECK(fence>0),
 call_number integer NOT NULL DEFAULT 1 CHECK(call_number=1),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(attempt_id,order_id) REFERENCES payment_attempts(id,order_id),
 FOREIGN KEY(job_id) REFERENCES outbox_jobs(id), UNIQUE(attempt_id,operation)
);
CREATE TABLE call_outcomes (
 call_id uuid PRIMARY KEY REFERENCES call_intents(id),
 safe_code text NOT NULL CHECK(safe_code IN ('pending','unknown','hint_success','affirmative_no_broadcast')),
 transaction_hash hash32, observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER immutable_intent BEFORE UPDATE OR DELETE ON call_intents FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER immutable_outcome BEFORE UPDATE OR DELETE ON call_outcomes FOR EACH ROW EXECUTE FUNCTION reject_mutation();
GRANT SELECT,INSERT ON call_intents,call_outcomes TO dispatch_worker;

CREATE FUNCTION protect_order_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.config_id,NEW.product_id,NEW.product_version,NEW.merchant_order_reference)
 IS DISTINCT FROM ROW(OLD.id,OLD.config_id,OLD.product_id,OLD.product_version,OLD.merchant_order_reference)
 THEN RAISE EXCEPTION 'immutable_order_binding'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_order_binding BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION protect_order_binding();
CREATE FUNCTION conservative_exposure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='budget_allocations' THEN
  IF TG_OP='INSERT' THEN
   IF NEW.released_at IS NOT NULL THEN RAISE EXCEPTION 'release_disabled'; END IF;
  ELSIF ROW(NEW.attempt_id,NEW.merchant_id,NEW.utc_day,NEW.amount,NEW.released_at,NEW.release_evidence)
   IS DISTINCT FROM ROW(OLD.attempt_id,OLD.merchant_id,OLD.utc_day,OLD.amount,OLD.released_at,OLD.release_evidence)
   THEN RAISE EXCEPTION 'release_disabled'; END IF;
 ELSIF TG_TABLE_NAME='spend_budgets' THEN
  IF NEW.gross_reserved<OLD.gross_reserved OR ROW(NEW.merchant_id,NEW.utc_day) IS DISTINCT FROM ROW(OLD.merchant_id,OLD.utc_day)
   THEN RAISE EXCEPTION 'release_disabled'; END IF;
 ELSIF TG_TABLE_NAME='payment_attempts' THEN
  IF NEW.state IN ('expired_unspent','cancelled_onchain','rejected_before_broadcast') THEN RAISE EXCEPTION 'release_disabled'; END IF;
 ELSIF TG_TABLE_NAME='reservations' THEN
  IF NEW.state='released' AND EXISTS(SELECT 1 FROM quotes q JOIN payment_attempts a ON a.quote_id=q.id WHERE q.reservation_id=NEW.id)
   THEN RAISE EXCEPTION 'release_disabled'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER no_allocation_release BEFORE INSERT OR UPDATE ON budget_allocations FOR EACH ROW EXECUTE FUNCTION conservative_exposure();
CREATE TRIGGER no_budget_decrease BEFORE UPDATE ON spend_budgets FOR EACH ROW EXECUTE FUNCTION conservative_exposure();
CREATE TRIGGER no_attempt_release BEFORE INSERT OR UPDATE ON payment_attempts FOR EACH ROW EXECUTE FUNCTION conservative_exposure();
CREATE TRIGGER no_reservation_release BEFORE UPDATE ON reservations FOR EACH ROW EXECUTE FUNCTION conservative_exposure();
CREATE FUNCTION check_call_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j outbox_jobs;
BEGIN
 SELECT * INTO j FROM outbox_jobs WHERE id=NEW.job_id FOR UPDATE;
 IF NOT FOUND OR j.order_id<>NEW.order_id OR j.attempt_id IS DISTINCT FROM NEW.attempt_id
  OR j.effect_type<>'submit' OR j.state<>'leased' OR j.lease_owner IS DISTINCT FROM NEW.lease_owner
  OR j.fence<>NEW.fence OR j.lease_until<=clock_timestamp()
 THEN RAISE EXCEPTION 'invalid_call_lease'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER valid_call_claim BEFORE INSERT ON call_intents FOR EACH ROW EXECUTE FUNCTION check_call_claim();
-- Agent/recovery credentials cannot acquire a second order; serialize grant races.
CREATE FUNCTION check_grant_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k text;
BEGIN
 SELECT kind INTO k FROM buyer_sessions WHERE id=NEW.session_id FOR UPDATE;
 IF k IN ('agent','recovery') AND EXISTS(SELECT 1 FROM buyer_grants WHERE session_id=NEW.session_id AND order_id<>NEW.order_id)
 THEN RAISE EXCEPTION 'single_order_grant'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER single_order_grant BEFORE INSERT OR UPDATE ON buyer_grants FOR EACH ROW EXECUTE FUNCTION check_grant_scope();
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA dispatch FROM PUBLIC;
-- Grants and session kind cannot be rewritten to evade one-order scope.
REVOKE UPDATE ON buyer_grants FROM dispatch_api;
CREATE FUNCTION protect_session_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.capability_hash,NEW.kind,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.capability_hash,OLD.kind,OLD.created_at)
 THEN RAISE EXCEPTION 'immutable_session_identity'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_session_identity BEFORE UPDATE ON buyer_sessions FOR EACH ROW EXECUTE FUNCTION protect_session_identity();
