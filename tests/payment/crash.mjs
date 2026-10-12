import { Pool } from 'pg';
import { PaymentWorker } from '../../dist/packages/db/src/payment-worker.js';
const pool=new Pool({host:process.env.DISPATCH_DB_HOST,port:55442,user:'local_worker',database:'dispatch'});
const worker=new PaymentWorker(pool,Buffer.alloc(32));
await worker.claim(process.argv[2],'verify');
process.stdout.write('committed\n');
setInterval(()=>{},1000);
