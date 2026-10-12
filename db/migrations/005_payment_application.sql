-- BUILD-003: application snapshots and append-only reconciliation evidence.
CREATE TABLE dispatch.payment_challenges (
 quote_id uuid PRIMARY KEY, order_id uuid NOT NULL, resource_url text NOT NULL,
 requirements jsonb NOT NULL, deadline timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(quote_id,order_id) REFERENCES dispatch.quotes(id,order_id)
);
CREATE TRIGGER immutable_challenge BEFORE UPDATE OR DELETE ON dispatch.payment_challenges
 FOR EACH ROW EXECUTE FUNCTION dispatch.reject_mutation();
GRANT SELECT,INSERT ON dispatch.payment_challenges TO dispatch_api;
GRANT SELECT ON dispatch.payment_challenges TO dispatch_worker;
-- Verify affirmative status is separate from a settlement hint. Old rows remain unknown.
ALTER TABLE dispatch.call_outcomes ADD COLUMN verified boolean NOT NULL DEFAULT false;
CREATE TABLE dispatch.chain_observations (
 id uuid PRIMARY KEY, attempt_id uuid NOT NULL REFERENCES dispatch.payment_attempts(id),
 evidence_digest dispatch.hash32 NOT NULL, transaction_hash dispatch.hash32,
 result text NOT NULL CHECK(result IN ('exact','unknown','conflict','reorg')),
 observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER immutable_chain_observation BEFORE UPDATE OR DELETE ON dispatch.chain_observations
 FOR EACH ROW EXECUTE FUNCTION dispatch.reject_mutation();
GRANT SELECT,INSERT ON dispatch.chain_observations TO dispatch_worker;
CREATE UNIQUE INDEX payment_incident_kind_settlement ON dispatch.payment_incidents(settlement_id,kind)
 WHERE settlement_id IS NOT NULL;
-- A second outbox row cannot recreate an already scheduled effect.
CREATE UNIQUE INDEX outbox_order_effect_version ON dispatch.outbox_jobs(order_id,effect_type,effect_version)
 WHERE effect_type IN ('entitlement','merchant_paid');

-- API needs only the coarse unresolved-incident gate, not incident evidence.
GRANT SELECT(kind,resolved_at) ON dispatch.payment_incidents TO dispatch_api;
