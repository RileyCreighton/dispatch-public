import {resumePurchase} from '../../dist/examples/agent/src/purchase.js';
const result=await resumePurchase(process.argv[2]);
process.stdout.write(JSON.stringify({id:result.id,order_state:result.order_state,payment_state:result.payment_state,delivery:result.delivery,version:result.version}));
