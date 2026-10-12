-- CC-B2-001: explicit trigger resolution and snapshot-safe restricted grants.
-- Keep 001/002 bytes and checksums unchanged. Conflicts require owner review.
LOCK TABLE dispatch.buyer_sessions, dispatch.buyer_grants IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
 IF EXISTS (
  SELECT 1 FROM dispatch.buyer_sessions s JOIN dispatch.buyer_grants g ON g.session_id=s.id
  WHERE s.kind IN ('agent','recovery') GROUP BY s.id HAVING count(*)>1
 ) THEN RAISE EXCEPTION 'restricted_session_grant_conflict'; END IF;
END $$;

ALTER TABLE dispatch.buyer_sessions ADD COLUMN bound_order_id uuid REFERENCES dispatch.orders(id),
 ADD CONSTRAINT browser_has_no_single_order_binding CHECK(kind<>'browser' OR bound_order_id IS NULL);
UPDATE dispatch.buyer_sessions s SET bound_order_id=g.order_id
 FROM dispatch.buyer_grants g WHERE g.session_id=s.id AND s.kind IN ('agent','recovery');

CREATE OR REPLACE FUNCTION dispatch.protect_session_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF ROW(NEW.id,NEW.capability_hash,NEW.kind,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.capability_hash,OLD.kind,OLD.created_at)
 THEN RAISE EXCEPTION 'immutable_session_identity'; END IF;
 IF OLD.bound_order_id IS NOT NULL AND NEW.bound_order_id IS DISTINCT FROM OLD.bound_order_id
 THEN RAISE EXCEPTION 'immutable_session_order_binding'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION dispatch.check_grant_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE k text;
BEGIN
 SELECT kind INTO k FROM dispatch.buyer_sessions WHERE id=NEW.session_id;
 IF k IN ('agent','recovery') THEN
  -- A real row update creates a write conflict under stale snapshots. A lock
  -- followed by EXISTS alone does not. Kind and an established binding are immutable.
  UPDATE dispatch.buyer_sessions SET bound_order_id=NEW.order_id
   WHERE id=NEW.session_id AND (bound_order_id IS NULL OR bound_order_id=NEW.order_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'single_order_grant'; END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION dispatch.check_call_claim() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE j dispatch.outbox_jobs;
BEGIN
 SELECT * INTO j FROM dispatch.outbox_jobs WHERE id=NEW.job_id FOR UPDATE;
 IF NOT FOUND OR j.order_id<>NEW.order_id OR j.attempt_id IS DISTINCT FROM NEW.attempt_id
  OR j.effect_type<>'submit' OR j.state<>'leased' OR j.lease_owner IS DISTINCT FROM NEW.lease_owner
  OR j.fence<>NEW.fence OR j.lease_until<=clock_timestamp()
 THEN RAISE EXCEPTION 'invalid_call_lease'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION dispatch.conservative_exposure() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
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
  IF NEW.state='released' AND EXISTS(SELECT 1 FROM dispatch.quotes q JOIN dispatch.payment_attempts a ON a.quote_id=q.id WHERE q.reservation_id=NEW.id)
   THEN RAISE EXCEPTION 'release_disabled'; END IF;
 END IF;
 RETURN NEW;
END $$;

-- The other 002 function has no table/type lookups, but also gets a trusted path.
ALTER FUNCTION dispatch.protect_order_binding() SET search_path = pg_catalog, pg_temp;
-- CREATE OR REPLACE preserves the existing invoker security and revoked ACLs.
