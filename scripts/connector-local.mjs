// Local owner configuration: preserve immutable product versions; no URL input.
import {localPool} from '../dist/packages/db/src/config.js';
const [product,expected]=process.argv.slice(2);
if(process.env.DISPATCH_RUNTIME!=='digital-fixture'||!/^\d+$/.test(expected??'')||! /^[0-9a-f-]{36}$/.test(product??''))throw new Error('local_connector_arguments');
const pool=localPool('operator'),c=await pool.connect();
try{
 await c.query('BEGIN');
 const ctl=(await c.query("SELECT payment_paused FROM dispatch.merchant_control WHERE merchant_id='single' FOR UPDATE")).rows[0];
 if(!ctl?.payment_paused)throw new Error('pause_required');
 const row=(await c.query('SELECT version FROM dispatch.product_publication WHERE product_id=$1 FOR UPDATE',[product])).rows[0];
 if(row?.version!==Number(expected))throw new Error('stale_version');
 const next=Number(expected)+1;
 await c.query(`INSERT INTO dispatch.products(product_id,version,title,description,kind,asset_id,unit_amount,tax_status,tax_source,tax_version,policy_version,connector_key)
  SELECT product_id,$3,title,description,kind,asset_id,unit_amount,tax_status,tax_source,tax_version,policy_version,'local-receiver'
  FROM dispatch.products WHERE product_id=$1 AND version=$2 AND kind='digital'`,[product,Number(expected),next]);
 await c.query('UPDATE dispatch.product_publication SET version=$2 WHERE product_id=$1',[product,next]);
 await c.query('COMMIT');console.log(JSON.stringify({product,version:next,connector:'local-receiver'}));
}catch{await c.query('ROLLBACK');process.exitCode=1;console.error('Local connector configuration refused. Check pause and expected product version.');}
finally{c.release();await pool.end();}
