-- Run once by a local disposable-cluster administrator, never by API/worker.
CREATE ROLE dispatch_migrator NOLOGIN;
CREATE ROLE dispatch_api NOLOGIN;
CREATE ROLE dispatch_worker NOLOGIN;
CREATE ROLE dispatch_operator NOLOGIN;
CREATE SCHEMA dispatch AUTHORIZATION dispatch_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA dispatch FROM PUBLIC;
REVOKE CREATE,TEMPORARY ON DATABASE dispatch FROM PUBLIC;
