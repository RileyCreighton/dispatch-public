-- PUBLIC DISPOSABLE FIXTURE PASSWORDS. LOCAL COMPOSE ONLY. Never reuse on a host with real data.
CREATE ROLE local_migrator LOGIN PASSWORD 'fixture-only-migrator' IN ROLE dispatch_migrator;
CREATE ROLE local_api LOGIN PASSWORD 'fixture-only-api' IN ROLE dispatch_api;
CREATE ROLE local_worker LOGIN PASSWORD 'fixture-only-worker' IN ROLE dispatch_worker;
CREATE ROLE local_operator LOGIN PASSWORD 'fixture-only-operator' IN ROLE dispatch_operator;
