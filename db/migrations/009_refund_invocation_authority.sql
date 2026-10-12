-- Permission and reported invocation are different facts. Earlier rows are never backfilled.
CREATE TABLE dispatch.refund_authorizations (
 refund_id uuid NOT NULL, wallet_start_version bigint NOT NULL,
 operator_session uuid NOT NULL REFERENCES dispatch.operator_sessions(id),
 anchor_block bigint NOT NULL CHECK(anchor_block>=0), anchor_hash dispatch.hash32 NOT NULL,
 observed_at timestamptz NOT NULL, authorized_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(refund_id,wallet_start_version),
 FOREIGN KEY(refund_id,wallet_start_version) REFERENCES dispatch.refund_invocations(refund_id,wallet_start_version)
);
CREATE TRIGGER immutable_refund_authorization BEFORE UPDATE OR DELETE ON dispatch.refund_authorizations
 FOR EACH ROW EXECUTE FUNCTION dispatch.reject_mutation();
GRANT SELECT,INSERT ON dispatch.refund_authorizations TO dispatch_operator;
GRANT SELECT ON dispatch.refund_authorizations TO dispatch_worker;
