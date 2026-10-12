-- Confirm possession for each explicit order grant, including multi-order browser sessions.
ALTER TABLE dispatch.buyer_grants ADD COLUMN confirmed_at timestamptz;
-- Existing single-order accepted credentials retain their proven confirmation.
UPDATE dispatch.buyer_grants g SET confirmed_at=s.confirmed_at
 FROM dispatch.buyer_sessions s WHERE g.session_id=s.id AND s.kind IN ('agent','recovery');
GRANT UPDATE(confirmed_at) ON dispatch.buyer_grants TO dispatch_api;
