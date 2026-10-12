import { Pool } from 'pg';
export type Service = 'api' | 'worker' | 'migrator' | 'operator';
// Local-build configuration only. No dotenv, generic DATABASE_URL or inherited PG credentials.
export function localPool(service: Service): Pool {
  if (process.env.DISPATCH_MODE !== 'local') throw new Error('local_mode_required');
  const host = process.env.DISPATCH_DB_HOST ?? '127.0.0.1';
  if (!['127.0.0.1', 'postgres'].includes(host) && !/^\/tmp\/dispatch-b[24]-[a-zA-Z0-9_-]+$/.test(host))
    throw new Error('local_database_required');
  const database = process.env.DISPATCH_DB_NAME ?? 'dispatch';
  if (!['dispatch', 'restored', 'upgrade'].includes(database)) throw new Error('local_database_required');
  const port = Number(process.env.DISPATCH_DB_PORT ?? '5432');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid_port');
  const pool = new Pool({ host, port, database, user: `local_${service}`, password: `fixture-only-${service}`,
    max: 5, connectionTimeoutMillis: 2000, idleTimeoutMillis: 5000, statement_timeout: 3000,
    idle_in_transaction_session_timeout: 3000, application_name: `dispatch-local-${service}` });
  pool.on('error', () => { /* Requests recheck dependency state; never log database error payloads. */ });
  return pool;
}
