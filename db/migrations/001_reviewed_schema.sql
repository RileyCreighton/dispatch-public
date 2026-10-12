-- Port of R3 schema; role/schema bootstrap and transaction are runner-owned.
-- Unconstrained numeric avoids rounding fractional input before CHECK.
-- Exactly the integer/range domain of uint256 and at most 78 decimal digits.
CREATE DOMAIN atomic_amount AS numeric CHECK (
  VALUE >= 0 AND VALUE = trunc(VALUE) AND
  VALUE <= 115792089237316195423570985008687907853269984665640564039457584007913129639935
);
CREATE DOMAIN evm_address AS text CHECK (VALUE ~ '^0x[0-9a-f]{40}$');
CREATE DOMAIN hash32 AS text CHECK (VALUE ~ '^0x[0-9a-f]{64}$');

CREATE TABLE merchant_config_versions (
  -- version is the immutable config counter, not merchant_control.version.
  -- No version-zero row: first authenticated updateConfig inserts version 1.
  id uuid PRIMARY KEY, version bigint NOT NULL UNIQUE CHECK (version > 0),
  merchant_id text NOT NULL CHECK (merchant_id = 'single'),
  pay_origin text NOT NULL, merchant_name text NOT NULL,
  payee evm_address NOT NULL CHECK (payee <> '0x0000000000000000000000000000000000000000'),
  chain_id integer NOT NULL CHECK (chain_id = 8453),
  network text NOT NULL CHECK (network = 'eip155:8453'),
  token evm_address NOT NULL CHECK (token = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'),
  decimals smallint NOT NULL CHECK (decimals = 6),
  policy_version text NOT NULL, policy_urls jsonb NOT NULL,
  finality_policy text NOT NULL CHECK (finality_policy IN ('safe','finalized','l2_receipt_risk_accepted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id,network,token,payee)
);
CREATE TABLE merchant_control (
  merchant_id text PRIMARY KEY CHECK (merchant_id = 'single'),
  config_id uuid REFERENCES merchant_config_versions(id),
  mainnet_enabled boolean NOT NULL DEFAULT false,
  payment_paused boolean NOT NULL DEFAULT true,
  fulfillment_paused boolean NOT NULL DEFAULT false,
  physical_enabled boolean NOT NULL DEFAULT false,
  max_order atomic_amount NOT NULL DEFAULT 1000000 CHECK (max_order > 0),
  max_day_gross atomic_amount NOT NULL DEFAULT 10000000 CHECK (max_day_gross > 0),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  budget_rolled_through date,
  CHECK (max_order <= max_day_gross),
  CONSTRAINT unconfigured_controls_fail_closed CHECK
    (config_id IS NOT NULL OR (NOT mainnet_enabled AND payment_paused AND NOT physical_enabled))
);
-- Clean install has zero orders AND zero config versions. Local auth bootstrap
-- does not seed config. operatorConfig exposes config_version=0, config=NULL.
INSERT INTO merchant_control(merchant_id) VALUES ('single');
CREATE TABLE provider_capability_snapshots (
  id uuid PRIMARY KEY, provider_origin text NOT NULL,
  supported_kinds jsonb NOT NULL, fetched_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL, content_digest hash32 NOT NULL,
  CHECK(expires_at > fetched_at)
);
CREATE TABLE asset_versions (
  id uuid PRIMARY KEY, manifest_sha256 hash32 NOT NULL,
  file_sha256 hash32 NOT NULL, private_relative_path text NOT NULL,
  mime_type text NOT NULL, download_name text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
  -- realpath, no-symlink, owner/permission and hash checks in trusted file importer.
);
CREATE TABLE products (
  product_id uuid NOT NULL, version integer NOT NULL CHECK (version > 0),
  title text NOT NULL, description text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('digital','physical')),
  asset_id uuid REFERENCES asset_versions(id), connector_key text,
  unit_amount atomic_amount NOT NULL CHECK (unit_amount > 0),
  tax_status text NOT NULL CHECK (tax_status IN ('calculated','tax_included','merchant_attested_zero')),
  tax_source text NOT NULL, tax_version text NOT NULL, policy_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(product_id,version), UNIQUE(product_id,version,asset_id),
  CHECK ((kind='digital' AND asset_id IS NOT NULL) OR (kind='physical' AND asset_id IS NULL))
);
CREATE TABLE product_publication (
  product_id uuid PRIMARY KEY, version integer NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  FOREIGN KEY(product_id,version) REFERENCES products(product_id,version)
);
CREATE TABLE buyer_sessions (
  id uuid PRIMARY KEY, capability_hash hash32 NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('browser','agent','recovery')),
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  confirmed_at timestamptz, revoked_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE TABLE orders (
  id uuid PRIMARY KEY, config_id uuid NOT NULL REFERENCES merchant_config_versions(id),
  product_id uuid NOT NULL, product_version integer NOT NULL,
  merchant_order_reference text UNIQUE,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','quoted','payment_pending','paid','fulfillment_pending','fulfilled','cancelled','expired','review_required')),
  fulfillment_state text NOT NULL DEFAULT 'not_ready' CHECK (fulfillment_state IN ('not_ready','queued','processing','available','handoff_complete','retry_pending','blocked','revoked')),
  shipment_state text NOT NULL DEFAULT 'not_applicable' CHECK (shipment_state IN ('not_applicable','awaiting_merchant','merchant_marked_shipped','review_required')),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  contact_ciphertext bytea, contact_key_id text, contact_iv bytea, contact_tag bytea,
  contact_consent_version text, contact_consent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(product_id,product_version) REFERENCES products(product_id,version),
  UNIQUE(id,product_id,product_version), UNIQUE(id,config_id),
  CHECK ((contact_ciphertext IS NULL AND contact_key_id IS NULL AND contact_iv IS NULL AND contact_tag IS NULL) OR
         (contact_ciphertext IS NOT NULL AND contact_key_id IS NOT NULL AND contact_iv IS NOT NULL AND contact_tag IS NOT NULL AND octet_length(contact_iv)=12 AND octet_length(contact_tag)=16 AND contact_consent_at IS NOT NULL AND contact_consent_version IS NOT NULL))
);
CREATE TABLE buyer_grants (
  session_id uuid NOT NULL REFERENCES buyer_sessions(id),
  order_id uuid NOT NULL REFERENCES orders(id),
  PRIMARY KEY(session_id,order_id)
  -- agent/recovery session must have one grant; browser session may own explicitly created orders.
);
CREATE TABLE reservations (
  id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders(id),
  operation_id uuid NOT NULL UNIQUE, merchant_reservation_id text UNIQUE,
  mode text NOT NULL CHECK (mode IN ('dedicated','adapter')),
  state text NOT NULL CHECK (state IN ('claiming','reserved','held_pending','consumed','released','review_required')),
  expires_at timestamptz NOT NULL, last_revalidated_at timestamptz,
  channel_claim_receipt text, release_evidence jsonb,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  UNIQUE(id,order_id)
);
CREATE UNIQUE INDEX reservation_live_order ON reservations(order_id)
 WHERE state IN ('claiming','reserved','held_pending','review_required');
CREATE TABLE quotes (
  id uuid PRIMARY KEY, order_id uuid NOT NULL, version integer NOT NULL CHECK (version > 0),
  config_id uuid NOT NULL, product_id uuid NOT NULL, product_version integer NOT NULL,
  quantity smallint NOT NULL CHECK (quantity=1), unit_amount atomic_amount NOT NULL,
  discount_amount atomic_amount NOT NULL DEFAULT 0 CHECK (discount_amount=0),
  tax_amount atomic_amount NOT NULL, shipping_amount atomic_amount NOT NULL,
  total atomic_amount NOT NULL CHECK (total > 0),
  network text NOT NULL CHECK (network='eip155:8453'), token evm_address NOT NULL, payee evm_address NOT NULL,
  tax_status text NOT NULL CHECK (tax_status IN ('calculated','tax_included','merchant_attested_zero')),
  tax_source text NOT NULL, tax_version text NOT NULL,
  shipping_source text NOT NULL, policy_version text NOT NULL,
  inputs_hash hash32 NOT NULL, quote_hash hash32 NOT NULL UNIQUE,
  reservation_id uuid, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  FOREIGN KEY(order_id,config_id) REFERENCES orders(id,config_id),
  FOREIGN KEY(config_id,network,token,payee) REFERENCES merchant_config_versions(id,network,token,payee),
  FOREIGN KEY(order_id,product_id,product_version) REFERENCES orders(id,product_id,product_version),
  FOREIGN KEY(reservation_id,order_id) REFERENCES reservations(id,order_id),
  UNIQUE(order_id,version), UNIQUE(id,order_id), UNIQUE(id,order_id,network,token,payee,total),
  CHECK(total=unit_amount-discount_amount+tax_amount+shipping_amount),
  CHECK(expires_at > created_at),
  CHECK(tax_status <> 'merchant_attested_zero' OR tax_amount=0)
);
CREATE TABLE payment_attempts (
  id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders(id), quote_id uuid NOT NULL,
  network text NOT NULL, token evm_address NOT NULL, authorizer evm_address NOT NULL,
  payee evm_address NOT NULL, amount atomic_amount NOT NULL CHECK(amount > 0), nonce hash32 NOT NULL,
  typed_digest hash32 NOT NULL, request_fingerprint hash32 NOT NULL,
  operation_id uuid NOT NULL UNIQUE, requirements jsonb NOT NULL,
  valid_after numeric(78,0) NOT NULL CHECK(valid_after >= 0),
  valid_before numeric(78,0) NOT NULL CHECK(valid_before > valid_after),
  authorization_ciphertext bytea, authz_key_id text, authz_iv bytea, authz_tag bytea,
  authorization_purged_at timestamptz,
  preaccept_block bigint NOT NULL CHECK(preaccept_block >= 0), preaccept_hash hash32 NOT NULL,
  preaccept_chain_time timestamptz NOT NULL, preaccept_observed_at timestamptz NOT NULL,
  submit_start_block bigint, submit_started_at timestamptz,
  state text NOT NULL CHECK(state IN ('bound','ready_to_submit','submitting','pending','settled','rejected_before_broadcast','expired_unspent','cancelled_onchain','review_required')),
  disposition_evidence jsonb, version bigint NOT NULL DEFAULT 0 CHECK(version >= 0),
  scan_through_block bigint, scan_through_hash hash32, scan_complete boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(quote_id,order_id,network,token,payee,amount) REFERENCES quotes(id,order_id,network,token,payee,total),
  UNIQUE(network,token,authorizer,nonce), UNIQUE(id,order_id), UNIQUE(id,amount),
  CHECK ((authorization_ciphertext IS NOT NULL AND authz_key_id IS NOT NULL AND authz_iv IS NOT NULL AND authz_tag IS NOT NULL AND octet_length(authz_iv)=12 AND octet_length(authz_tag)=16 AND authorization_purged_at IS NULL) OR
         (authorization_ciphertext IS NULL AND authz_key_id IS NULL AND authz_iv IS NULL AND authz_tag IS NULL AND authorization_purged_at IS NOT NULL AND state IN ('settled','rejected_before_broadcast','expired_unspent','cancelled_onchain'))),
  CHECK(state NOT IN ('submitting','pending') OR (submit_start_block IS NOT NULL AND submit_started_at IS NOT NULL)),
  CHECK(state NOT IN ('rejected_before_broadcast','expired_unspent','cancelled_onchain') OR disposition_evidence IS NOT NULL)
);
CREATE UNIQUE INDEX one_unresolved_attempt_per_order ON payment_attempts(order_id)
 WHERE state IN ('bound','ready_to_submit','submitting','pending','review_required');
CREATE INDEX attempts_reconcile ON payment_attempts(state,created_at);
CREATE TABLE submission_observations (
  id uuid PRIMARY KEY, attempt_id uuid NOT NULL REFERENCES payment_attempts(id),
  call_number integer NOT NULL CHECK(call_number > 0), provider_code text,
  transaction_hash hash32, outcome text NOT NULL CHECK(outcome IN ('pending','hint_success','affirmative_no_broadcast','unknown')),
  observed_at timestamptz NOT NULL DEFAULT now(), UNIQUE(attempt_id,call_number)
);
CREATE TABLE spend_budgets (
  merchant_id text NOT NULL REFERENCES merchant_control(merchant_id), utc_day date NOT NULL,
  gross_reserved atomic_amount NOT NULL DEFAULT 0, cap atomic_amount NOT NULL CHECK(cap > 0),
  PRIMARY KEY(merchant_id,utc_day)
  -- Do not CHECK gross<=cap: carry-in/late funds must be recorded even above cap.
  -- New claims use conditional UPDATE ... WHERE gross_reserved + amount <= cap.
);
CREATE TABLE budget_allocations (
  attempt_id uuid NOT NULL REFERENCES payment_attempts(id), merchant_id text NOT NULL,
  utc_day date NOT NULL, amount atomic_amount NOT NULL CHECK(amount > 0),
  released_at timestamptz, release_evidence jsonb,
  PRIMARY KEY(attempt_id,utc_day), FOREIGN KEY(attempt_id,amount) REFERENCES payment_attempts(id,amount), FOREIGN KEY(merchant_id,utc_day) REFERENCES spend_budgets(merchant_id,utc_day),
  CHECK(released_at IS NULL OR release_evidence IS NOT NULL)
);
CREATE TABLE settlements (
  id uuid PRIMARY KEY, attempt_id uuid NOT NULL, order_id uuid NOT NULL,
  chain_id integer NOT NULL CHECK(chain_id=8453), tx_hash hash32 NOT NULL,
  call_path text NOT NULL, authorization_log_index integer NOT NULL CHECK(authorization_log_index >= 0),
  transfer_log_index integer NOT NULL CHECK(transfer_log_index >= 0),
  block_number bigint NOT NULL CHECK(block_number >= 0), block_hash hash32 NOT NULL,
  chain_time timestamptz NOT NULL, amount atomic_amount NOT NULL CHECK(amount > 0),
  observed_head bigint NOT NULL CHECK(observed_head >= block_number), observed_head_hash hash32 NOT NULL,
  observation_policy text NOT NULL CHECK(observation_policy IN ('safe','finalized','l2_receipt_risk_accepted')),
  verifier_version text NOT NULL, evidence_digest hash32 NOT NULL,
  disposition text NOT NULL CHECK(disposition IN ('credited','late','surplus','review')),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(attempt_id,order_id) REFERENCES payment_attempts(id,order_id),
  UNIQUE(chain_id,tx_hash,transfer_log_index), UNIQUE(chain_id,tx_hash,call_path,authorization_log_index),
  UNIQUE(id,order_id)
);
CREATE UNIQUE INDEX one_credited_settlement_per_order ON settlements(order_id) WHERE disposition='credited';
CREATE TABLE payment_incidents (
  id uuid PRIMARY KEY, order_id uuid REFERENCES orders(id), attempt_id uuid REFERENCES payment_attempts(id),
  settlement_id uuid REFERENCES settlements(id), kind text NOT NULL,
  evidence jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz
  -- Unattributed public transfers stay incidents; never mint an order/entitlement from them.
);
CREATE TABLE entitlements (
  id uuid PRIMARY KEY, order_id uuid NOT NULL, product_id uuid NOT NULL, product_version integer NOT NULL,
  settlement_id uuid NOT NULL, asset_id uuid NOT NULL REFERENCES asset_versions(id),
  state text NOT NULL CHECK(state IN ('available','revoked','blocked')),
  created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
  FOREIGN KEY(order_id,product_id,product_version) REFERENCES orders(id,product_id,product_version),
  FOREIGN KEY(settlement_id,order_id) REFERENCES settlements(id,order_id),
  FOREIGN KEY(product_id,product_version,asset_id) REFERENCES products(product_id,version,asset_id),
  UNIQUE(order_id,product_id,product_version)
);
CREATE TABLE outbox_jobs (
  id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders(id), attempt_id uuid REFERENCES payment_attempts(id),
  effect_type text NOT NULL CHECK(effect_type IN ('submit','reconcile','entitlement','merchant_paid','reservation')),
  effect_version integer NOT NULL CHECK(effect_version > 0), effect_key text NOT NULL UNIQUE,
  payload_reference uuid NOT NULL, state text NOT NULL CHECK(state IN ('queued','leased','done','retry','dead_letter')),
  available_at timestamptz NOT NULL DEFAULT now(), lease_owner uuid, lease_until timestamptz,
  fence bigint NOT NULL DEFAULT 0 CHECK(fence >= 0), attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  last_safe_error text, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(attempt_id,order_id) REFERENCES payment_attempts(id,order_id),
  CHECK(state <> 'leased' OR (lease_owner IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX outbox_claim ON outbox_jobs(available_at,id) WHERE state IN ('queued','retry','leased');
CREATE TABLE webhook_attempts (
  id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES outbox_jobs(id), event_id uuid NOT NULL,
  attempt_number integer NOT NULL CHECK(attempt_number > 0), target_id text NOT NULL,
  body_hash hash32 NOT NULL, signing_key_id text NOT NULL, signed_at timestamptz NOT NULL,
  http_status smallint CHECK(http_status BETWEEN 100 AND 599), durable_remote_receipt text,
  safe_error text, UNIQUE(event_id,attempt_number)
);
CREATE TABLE refunds (
  id uuid PRIMARY KEY, settlement_id uuid NOT NULL REFERENCES settlements(id),
  destination evm_address NOT NULL, amount atomic_amount NOT NULL CHECK(amount > 0), token evm_address NOT NULL,
  expected_signer evm_address NOT NULL, operation_id uuid NOT NULL UNIQUE,
  state text NOT NULL CHECK(state IN ('requested','prepared','wallet_pending','broadcast_unknown','submitted','confirmed','rejected','review_required')),
  -- Server-observed binding is written once, before the external wallet call.
  chain_id integer CHECK(chain_id=8453),
  wallet_account_nonce atomic_amount, prepare_block bigint CHECK(prepare_block >= 0),
  prepare_block_hash hash32, prepare_observed_at timestamptz, wallet_started_at timestamptz,
  transaction_to evm_address, transaction_value atomic_amount CHECK(transaction_value=0),
  transaction_calldata text CHECK(transaction_calldata ~ '^0xa9059cbb[0-9a-f]{128}$'),
  tx_hash hash32, transfer_log_index integer CHECK(transfer_log_index >= 0),
  block_number bigint CHECK(block_number >= 0), block_hash hash32, verification_evidence jsonb,
  no_send_evidence jsonb,
  approved_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), version bigint NOT NULL DEFAULT 0,
  CHECK(num_nonnulls(chain_id,wallet_account_nonce,prepare_block,prepare_block_hash,
    prepare_observed_at,wallet_started_at,transaction_to,transaction_value,transaction_calldata) IN (0,9)),
  CHECK(wallet_started_at IS NULL OR
    (approved_at IS NOT NULL AND prepare_observed_at <= wallet_started_at AND transaction_to=token)),
  CHECK(state NOT IN ('wallet_pending','broadcast_unknown','submitted','confirmed') OR wallet_started_at IS NOT NULL),
  CHECK(state <> 'rejected' OR wallet_started_at IS NULL OR no_send_evidence IS NOT NULL),
  CHECK(state <> 'confirmed' OR (tx_hash IS NOT NULL AND transfer_log_index IS NOT NULL AND
    block_number IS NOT NULL AND block_number > prepare_block AND block_hash IS NOT NULL AND verification_evidence IS NOT NULL))
);
CREATE UNIQUE INDEX one_nonrejected_refund ON refunds(settlement_id)
 WHERE state <> 'rejected' OR wallet_started_at IS NOT NULL;
CREATE UNIQUE INDEX unique_refund_signer_nonce ON refunds(chain_id,expected_signer,wallet_account_nonce)
 WHERE wallet_started_at IS NOT NULL;
CREATE UNIQUE INDEX unique_refund_transfer ON refunds(chain_id,tx_hash,transfer_log_index) WHERE tx_hash IS NOT NULL AND transfer_log_index IS NOT NULL;
CREATE TABLE operator_sessions (
  id uuid PRIMARY KEY, token_hash hash32 NOT NULL UNIQUE, csrf_hash hash32 NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL, fresh_auth_at timestamptz, revoked_at timestamptz,
  CHECK(expires_at > created_at)
);
CREATE TABLE audit_events (
  id uuid PRIMARY KEY, actor_kind text NOT NULL CHECK(actor_kind IN ('buyer','operator','worker','system')),
  actor_reference uuid, order_id uuid REFERENCES orders(id), action text NOT NULL,
  safe_fields jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE idempotency_records (
  scope_id uuid NOT NULL REFERENCES orders(id), operation text NOT NULL, key_hash hash32 NOT NULL,
  fingerprint hash32 NOT NULL, operation_id uuid NOT NULL, result_reference uuid,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(scope_id,operation,key_hash)
);
-- Single-merchant operator commands work even before the first order exists.
-- Insert a completed record atomically with mutation/audit; never a pending cache row.
CREATE TABLE operator_command_records (
  merchant_id text NOT NULL REFERENCES merchant_control(merchant_id) CHECK(merchant_id='single'),
  operation text NOT NULL CHECK(operation IN ('updateConfig','pausePayments','pauseFulfillment',
    'createProduct','versionProduct','retryDelivery','prepareRefund','refundWalletStart','refundObservation','markShipment')),
  key_hash hash32 NOT NULL, fingerprint hash32 NOT NULL, operation_id uuid NOT NULL UNIQUE,
  result_reference uuid NOT NULL REFERENCES audit_events(id),
  result_status smallint NOT NULL CHECK(result_status BETWEEN 200 AND 299),
  result_body jsonb NOT NULL CHECK(jsonb_typeof(result_body)='object' AND octet_length(result_body::text) <= 65536),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(merchant_id,operation,key_hash)
  -- result_body is a bounded allowlisted command response, never password/session/PII.
);
CREATE TABLE abuse_counters (
  bucket_hash hash32 NOT NULL, window_start timestamptz NOT NULL,
  count integer NOT NULL CHECK(count >= 0), PRIMARY KEY(bucket_hash,window_start)
);
CREATE INDEX grants_by_order ON buyer_grants(order_id);
CREATE INDEX quotes_by_order ON quotes(order_id,version DESC);
CREATE INDEX orders_operator_list ON orders(created_at DESC,id);
CREATE INDEX settlement_attempt ON settlements(attempt_id);
CREATE INDEX audit_order_time ON audit_events(order_id,created_at);

CREATE FUNCTION reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable record; append a version or incident'; END $$;
CREATE FUNCTION protect_authorization_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.order_id,NEW.quote_id,NEW.network,NEW.token,NEW.authorizer,NEW.payee,NEW.amount,NEW.nonce,NEW.typed_digest,NEW.request_fingerprint,NEW.operation_id,NEW.requirements,NEW.valid_after,NEW.valid_before,NEW.preaccept_block,NEW.preaccept_hash,NEW.preaccept_chain_time,NEW.preaccept_observed_at)
     IS DISTINCT FROM
     ROW(OLD.id,OLD.order_id,OLD.quote_id,OLD.network,OLD.token,OLD.authorizer,OLD.payee,OLD.amount,OLD.nonce,OLD.typed_digest,OLD.request_fingerprint,OLD.operation_id,OLD.requirements,OLD.valid_after,OLD.valid_before,OLD.preaccept_block,OLD.preaccept_hash,OLD.preaccept_chain_time,OLD.preaccept_observed_at)
  THEN RAISE EXCEPTION 'authorization identity is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_authorization_binding BEFORE UPDATE ON payment_attempts FOR EACH ROW EXECUTE FUNCTION protect_authorization_binding();
CREATE FUNCTION protect_refund_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state NOT IN ('requested','prepared') OR NEW.wallet_started_at IS NOT NULL
    THEN RAISE EXCEPTION 'refund must begin as an unbound intent'; END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id,NEW.settlement_id,NEW.destination,NEW.amount,NEW.token,NEW.expected_signer,NEW.operation_id)
     IS DISTINCT FROM
     ROW(OLD.id,OLD.settlement_id,OLD.destination,OLD.amount,OLD.token,OLD.expected_signer,OLD.operation_id)
  THEN RAISE EXCEPTION 'refund identity is immutable'; END IF;
  IF OLD.wallet_started_at IS NOT NULL AND
     ROW(NEW.chain_id,NEW.wallet_account_nonce,NEW.prepare_block,NEW.prepare_block_hash,
       NEW.prepare_observed_at,NEW.wallet_started_at,NEW.transaction_to,NEW.transaction_value,NEW.transaction_calldata)
     IS DISTINCT FROM
     ROW(OLD.chain_id,OLD.wallet_account_nonce,OLD.prepare_block,OLD.prepare_block_hash,
       OLD.prepare_observed_at,OLD.wallet_started_at,OLD.transaction_to,OLD.transaction_value,OLD.transaction_calldata)
  THEN RAISE EXCEPTION 'refund wallet binding is immutable'; END IF;
  IF OLD.wallet_started_at IS NULL AND NEW.wallet_started_at IS NOT NULL AND
     (OLD.state <> 'prepared' OR NEW.state <> 'wallet_pending')
  THEN RAISE EXCEPTION 'refund binding requires prepared to wallet_pending transition'; END IF;
  IF NEW.version <> OLD.version + 1
  THEN RAISE EXCEPTION 'refund mutation must increment version'; END IF;
  IF OLD.wallet_started_at IS NOT NULL AND OLD.state <> 'wallet_pending' AND NEW.state = 'wallet_pending' AND
     (OLD.state <> 'rejected' OR OLD.no_send_evidence IS NULL OR NEW.no_send_evidence IS NOT NULL)
  THEN RAISE EXCEPTION 'explicit retry requires prior no-send proof and clearing current proof'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_refund_binding BEFORE INSERT OR UPDATE ON refunds FOR EACH ROW EXECUTE FUNCTION protect_refund_binding();
CREATE TRIGGER retain_refund_binding BEFORE DELETE ON refunds FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER immutable_operator_command BEFORE UPDATE OR DELETE ON operator_command_records FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER immutable_config BEFORE UPDATE OR DELETE ON merchant_config_versions FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER immutable_product BEFORE UPDATE OR DELETE ON products FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER immutable_asset BEFORE UPDATE OR DELETE ON asset_versions FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER immutable_quote BEFORE UPDATE OR DELETE ON quotes FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER immutable_settlement BEFORE UPDATE OR DELETE ON settlements FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- Application transaction guards MUST additionally verify: confirmed buyer grant;
-- exact typed-data/signature/nonce freshness; quote/reservation time; state transitions;
-- new-attempt prohibition on credited/fulfilled orders; original-payer full refund;
-- credited settlement and exact purchased asset before entitlement; pause/fencing;
-- per-day allocation/gross equality and finality evidence. SQL cannot validate RPC truth.
-- Refund guards verify canonical prepare hash, independently observed unused signer
-- nonce, exact encoded transfer, freshness, complete recovery scans and inclusion
-- strictly after prepare_block. A nonce reservation is never released by a timeout.
-- Operator commands lock merchant_control before lookup/target mutation; matching
-- replay precedes stale-version checks and never repeats an external wallet action.
-- PR-004 updateConfig guard (proposed transaction, not a stored procedure):
-- Authenticate/fresh-auth/Origin/CSRF on first save and replay. Under control lock,
-- lookup merchant/operation/key and compare fingerprint before any version guard.
-- Derive current config version from linked immutable row; zero only if config_id
-- IS NULL and no config rows exist. Inconsistent/orphaned state fails NOT_READY.
-- Compare ConfigUpdate.expected_config_version, never control.version. New key
-- mismatch is STALE_CONFIG; same key/different input is IDEMPOTENCY_CONFLICT.
-- Insert version current+1; link config_id and increment CURRENT control.version
-- once; append operator audit (old/new config id/version, control versions, payee
-- confirmation, operation_id); insert original 200/body referencing that audit.
-- All changes commit together; failure at any point rolls back all four. No
-- pending ledger, partial commit, dummy order, runtime config seed or network I/O.
-- First save fixes Base/native USDC/6 decimals/finality safe and leaves mainnet
-- false, payments paused, physical false; other controls including fulfillment
-- pause are preserved. Later config saves preserve other fields/finality too.
-- Config pointer cannot be cleared or moved backward. Pause/budget rollover only
-- advance control.version; immutable config versions advance on config saves only.
-- These cross-table, version, audit/result and role/auth guards require real-DB
-- tests; the FK/CHECK and SQL parser alone do not establish atomic behavior.
-- BUILD-002/003 test these guards with actual roles/real DB, not parser-only checks.
GRANT USAGE ON SCHEMA dispatch TO dispatch_api,dispatch_worker,dispatch_operator;
GRANT USAGE ON TYPE atomic_amount,evm_address,hash32 TO dispatch_api,dispatch_worker,dispatch_operator;
GRANT SELECT ON ALL TABLES IN SCHEMA dispatch TO dispatch_worker;
GRANT SELECT ON provider_capability_snapshots,merchant_config_versions,merchant_control,products,product_publication,asset_versions,
  orders,quotes,buyer_sessions,buyer_grants,payment_attempts,settlements,entitlements,reservations,
  spend_budgets,budget_allocations,idempotency_records,abuse_counters TO dispatch_api;
GRANT INSERT,UPDATE ON buyer_sessions,buyer_grants,orders,payment_attempts,reservations,
  spend_budgets,budget_allocations,idempotency_records,abuse_counters TO dispatch_api;
GRANT INSERT ON quotes,outbox_jobs,audit_events TO dispatch_api;
GRANT UPDATE(budget_rolled_through,version) ON merchant_control TO dispatch_api,dispatch_worker;
GRANT INSERT,UPDATE ON outbox_jobs,orders,payment_attempts,reservations,spend_budgets,
  budget_allocations,entitlements,refunds TO dispatch_worker;
GRANT INSERT ON provider_capability_snapshots,submission_observations,settlements,payment_incidents,webhook_attempts,audit_events TO dispatch_worker;
GRANT SELECT ON ALL TABLES IN SCHEMA dispatch TO dispatch_operator;
GRANT INSERT ON operator_command_records TO dispatch_operator;
-- retryDelivery only reschedules the existing non-leased effect under row lock;
-- application guard verifies retry/dead_letter, same effect and expected fence.
GRANT UPDATE(state,available_at) ON outbox_jobs TO dispatch_operator;
GRANT INSERT ON merchant_config_versions,products,asset_versions,audit_events TO dispatch_operator;
GRANT INSERT,UPDATE ON product_publication,operator_sessions,refunds,abuse_counters TO dispatch_operator;
GRANT UPDATE ON merchant_control,orders,entitlements TO dispatch_operator;
-- Production uses separate LOGIN members provisioned by owner, no passwords in SQL.
-- API process uses operator connection only after operator authentication; never public routing.
-- Table owner and actual role membership/REVOKE DEFAULT PRIVILEGES validated in BUILD-002.
