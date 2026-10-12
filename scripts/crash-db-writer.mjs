import { localPool } from '../dist/packages/db/src/config.js';
const pool = localPool('api'); const client = await pool.connect();
await client.query('BEGIN');
await client.query('UPDATE dispatch.abuse_counters SET count=count+100');
process.stdout.write('uncommitted\n');
setInterval(() => {}, 1000);
