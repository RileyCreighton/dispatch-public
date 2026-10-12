-- CC-B2-002 / B2-R2-001: repair existing and future function execution ACLs.
-- Per-schema defaults only add to global defaults; omit IN SCHEMA to remove
-- PostgreSQL's built-in PUBLIC EXECUTE for functions owned by this creator.
ALTER DEFAULT PRIVILEGES FOR ROLE dispatch_migrator REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
-- Default privileges do not change existing functions (including NULL ACLs).
REVOKE EXECUTE ON FUNCTION dispatch.protect_session_identity() FROM PUBLIC;
