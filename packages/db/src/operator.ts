import { getAddress } from 'viem';
import { deliveryProjection,handoffProjection } from './delivery.js';
import { readFile,readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { control, digest, transaction, type Commerce } from './commerce.js';
import { OperatorAuth, type OperatorAuthority } from './operator-auth.js';
import { canonical } from '../../payments/src/canonical.js';
import { digitalTotal, key, object, TOKEN, uuid } from '../../domain/src/payment.js';
import { address } from '../../buyer/src/contracts.js';
import type { PrivateFiles } from '../../fulfillment/src/files.js';
export const version = (v: unknown): number => { if (!Number.isSafeInteger(v) || Number(v) < 0) throw new Error('invalid_input'); return Number(v); };
export const text = (v: unknown, max = 240): string => {
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[\u0000-\u001f]/.test(v)) throw new Error('invalid_input'); return v;
};
export const recipient = (v: unknown): string => { const a = address(v); if (/^0x0{40}$/.test(a)) throw new Error('invalid_input'); return a; };
export const controls = (r: Record<string, unknown>) => ({ payment_paused: r.payment_paused, fulfillment_paused: r.fulfillment_paused,
  mainnet_enabled: false, physical_enabled: false, version: version(Number(r.version)) });
export type CommandResult = { body: Record<string, unknown>; replayed: boolean; status: number };
export class OperatorStore {
  readonly auth: OperatorAuth;
  constructor(readonly pool: Pool, readonly commerce: Commerce, readonly files?: PrivateFiles) { this.auth = new OperatorAuth(pool, commerce.origin); }
  async read<T>(auth: OperatorAuthority, action: (c: PoolClient, ctl: Record<string, unknown>) => Promise<T>) {
    return transaction(this.pool, async c => { const ctl = await control(c); await this.auth.require(c, auth); return action(c, ctl); });
  }
  async replay(auth: OperatorAuthority, operation: string, commandKey: string, input: Record<string, unknown>): Promise<CommandResult | undefined> {
    return transaction(this.pool, async c => {
      await control(c); await this.auth.require(c, auth, true, true);
      const row = (await c.query("SELECT * FROM dispatch.operator_command_records WHERE merchant_id='single' AND operation=$1 AND key_hash=$2", [operation,digest(key(commandKey))])).rows[0];
      if (!row) return undefined;
      if (row.fingerprint !== digest(canonical({operation,input}))) throw new Error('idempotency_conflict');
      return {body:row.result_body as Record<string,unknown>,status:row.result_status as number,replayed:true};
    });
  }
  async command(auth: OperatorAuthority, operation: string, commandKey: string, input: Record<string, unknown>,
    action: (c: PoolClient, ctl: Record<string, unknown>) => Promise<Record<string, unknown>>, status = 200): Promise<CommandResult> {
    const fingerprint = digest(canonical({ operation, input })); key(commandKey);
    return transaction(this.pool, async c => {
      const ctl = await control(c), session = await this.auth.require(c, auth, true, true);
      const old = (await c.query(`SELECT * FROM dispatch.operator_command_records
        WHERE merchant_id='single' AND operation=$1 AND key_hash=$2`, [operation, digest(commandKey)])).rows[0];
      if (old) {
        if (old.fingerprint !== fingerprint) throw new Error('idempotency_conflict');
        return { body: old.result_body as Record<string, unknown>, status: old.result_status as number, replayed: true };
      }
      const body = await action(c, ctl);
      // Recheck after target locks or SQL work: elapsed freshness cannot authorize a mutation.
      await this.auth.require(c, auth, true, true);
      const audit = randomUUID(), operationId = randomUUID();
      await c.query(`INSERT INTO dispatch.audit_events(id,actor_kind,actor_reference,action,safe_fields)
        VALUES($1,'operator',$2,$3,$4)`, [audit, session.id, operation, JSON.stringify({ input, result: body })]);
      await c.query(`INSERT INTO dispatch.operator_command_records(merchant_id,operation,key_hash,fingerprint,operation_id,result_reference,result_status,result_body)
        VALUES('single',$1,$2,$3,$4,$5,$6,$7)`, [operation, digest(commandKey), fingerprint, operationId, audit, status, JSON.stringify(body)]);
      return { body, status, replayed: false };
    });
  }
  async configView(c: PoolClient) {
    const row = (await c.query(`SELECT m.*,v.version config_version,v.merchant_name,v.pay_origin,v.payee,v.policy_version,v.policy_urls,v.finality_policy,
      (SELECT count(*) FROM dispatch.merchant_config_versions) config_count FROM dispatch.merchant_control m
      LEFT JOIN dispatch.merchant_config_versions v ON v.id=m.config_id WHERE m.merchant_id='single'`)).rows[0];
    if (!row || (!row.config_id && row.config_count !== '0') || (row.config_id && !row.config_version)) throw new Error('not_ready');
    return { state: row.config_id ? 'configured' : 'unconfigured', config_version: Number(row.config_version ?? 0),
      config: row.config_id ? { version: Number(row.config_version), merchant_name: row.merchant_name, pay_origin: row.pay_origin,
        payee: row.payee, network: 'eip155:8453', asset: getAddress(TOKEN),
        policy_version: row.policy_version, policy_urls: row.policy_urls, finality_policy: row.finality_policy } : null, controls: controls(row) };
  }
  config(auth: OperatorAuthority) { return this.read(auth, c => this.configView(c)); }
  async updateConfig(auth: OperatorAuthority, commandKey: string, input: unknown) {
    const v = object(input, ['expected_config_version','merchant_name','pay_origin','payee','policy_version','policy_urls','confirmation_payee']);
    const payee = recipient(v.payee), confirmation = recipient(v.confirmation_payee), expected = version(v.expected_config_version);
    if (confirmation !== payee || v.pay_origin !== this.commerce.origin || !Array.isArray(v.policy_urls) || !v.policy_urls.length || v.policy_urls.length > 8) throw new Error('invalid_input');
    const urls = v.policy_urls.map(value => { const u = new URL(text(value, 2048)); if (u.protocol !== 'https:' || u.username || u.password || u.hash) throw new Error('invalid_input'); return u.href; });
    const normalized = { ...v, payee, confirmation_payee: confirmation, policy_urls: urls, merchant_name: text(v.merchant_name,160), policy_version: text(v.policy_version,128) };
    return this.command(auth, 'updateConfig', commandKey, normalized, async (c, ctl) => {
      const current = await this.configView(c);
      if (current.config_version !== expected) throw new Error('stale_config');
      const prior = (await c.query('SELECT policy_urls FROM dispatch.merchant_config_versions WHERE policy_version=$1', [normalized.policy_version])).rows;
      if (prior.some(r => canonical(r.policy_urls) !== canonical(urls))) throw new Error('policy_version_conflict');
      const id = randomUUID();
      await c.query(`INSERT INTO dispatch.merchant_config_versions(id,version,merchant_id,pay_origin,merchant_name,payee,chain_id,network,token,decimals,policy_version,policy_urls,finality_policy)
        VALUES($1,$2,'single',$3,$4,$5,8453,'eip155:8453',$6,6,$7,$8,$9)`,
      [id, expected+1, this.commerce.origin, normalized.merchant_name, payee, TOKEN, normalized.policy_version, JSON.stringify(urls), current.config?.finality_policy ?? 'safe']);
      await c.query("UPDATE dispatch.merchant_control SET config_id=$1,version=version+1 WHERE merchant_id='single' AND version=$2", [id,ctl.version]);
      return this.configView(c);
    });
  }
  async pause(auth: OperatorAuthority, kind: 'payments' | 'fulfillment', commandKey: string, input: unknown) {
    const v = object(input, ['paused','expected_version','reason']); version(v.expected_version); text(v.reason);
    if (typeof v.paused !== 'boolean') throw new Error('invalid_input');
    // Dependency I/O precedes the transaction; its freshness is bounded again below.
    const old = await this.replay(auth,kind === 'payments' ? 'pausePayments' : 'pauseFulfillment',commandKey,v); if (old) return old;
    let checked = 0;
    if (kind === 'payments' && !v.paused) {
      const readiness = await this.readiness(auth);
      if (readiness.checks.some(c => !['payments_pause','fulfillment_pause','live_release'].includes(c.code) && c.status !== 'pass')) throw new Error('not_ready');
      checked = Date.now();
    }
    return this.command(auth, kind === 'payments' ? 'pausePayments' : 'pauseFulfillment', commandKey, v, async (c, ctl) => {
      if (Number(ctl.version) !== v.expected_version) throw new Error('stale_config');
      if (kind === 'payments' && !v.paused && (!ctl.config_id || ctl.quarantined || Date.now()-checked>5000)) throw new Error('not_ready');
      // Column identifiers are fixed alternatives, never supplied SQL.
      const sql = kind === 'payments' ? 'payment_paused' : 'fulfillment_paused';
      const r = await c.query(`UPDATE dispatch.merchant_control SET ${sql}=$1,version=version+1 WHERE merchant_id='single' RETURNING *`, [v.paused]);
      return controls(r.rows[0]);
    });
  }
  async products(auth: OperatorAuthority) {
    return this.read(auth, async c => ({ products: (await c.query(`SELECT p.product_id id,p.version,p.title,p.description,p.kind,
      p.asset_id asset_manifest_id,p.unit_amount::text unit_atomic,p.tax_status,p.tax_source,p.tax_version,p.policy_version,u.enabled,
      '/buy/'||p.product_id::text purchase_path FROM dispatch.products p JOIN dispatch.product_publication u
      ON (p.product_id,p.version)=(u.product_id,u.version) ORDER BY p.title,p.product_id`)).rows,
      assets: (await c.query('SELECT id,download_name,size_bytes::text FROM dispatch.asset_versions ORDER BY created_at')).rows }));
  }
  async product(auth: OperatorAuthority, commandKey: string, input: unknown, productId?: string) {
    const v = object(input, ['title','description','kind','asset_manifest_id','unit_atomic','tax_status','tax_source','tax_version','policy_version','enabled','expected_version']);
    const title = text(v.title,160), description = text(v.description,4000), asset = uuid(v.asset_manifest_id);
    const price = digitalTotal(text(v.unit_atomic,78),text(v.tax_status),text(v.tax_source),text(v.tax_version));
    const policy = text(v.policy_version,128);
    if (v.kind !== 'digital' || typeof v.enabled !== 'boolean') throw new Error('invalid_input');
    if (productId) { uuid(productId); version(v.expected_version); }
    const oldCommand = await this.replay(auth,productId ? 'versionProduct' : 'createProduct',commandKey,{...v,...(productId ? {product_id:productId} : {})}); if (oldCommand) return oldCommand;
    await this.auth.session(auth);
    const a = (await this.pool.query('SELECT id,private_relative_path,file_sha256,manifest_sha256,mime_type,download_name,size_bytes FROM dispatch.asset_versions WHERE id=$1',[asset])).rows[0];
    if (!a || !this.files) throw new Error('not_ready'); await this.files.read(a);
    return this.command(auth, productId ? 'versionProduct' : 'createProduct',commandKey,{...v,...(productId ? {product_id:productId} : {})},async(c,ctl)=>{
      const config = (await c.query('SELECT policy_version FROM dispatch.merchant_config_versions WHERE id=$1',[ctl.config_id])).rows[0];
      if (!config || config.policy_version !== policy || BigInt(price)>BigInt(String(ctl.max_order))) throw new Error('not_ready');
      const id = productId ?? randomUUID(), old = (await c.query('SELECT version FROM dispatch.product_publication WHERE product_id=$1 FOR UPDATE',[id])).rows[0];
      if (productId && (!old || old.version !== v.expected_version)) throw new Error('stale_config');
      const next = old ? old.version+1 : 1;
      await c.query(`INSERT INTO dispatch.products(product_id,version,title,description,kind,asset_id,unit_amount,tax_status,tax_source,tax_version,policy_version)
        VALUES($1,$2,$3,$4,'digital',$5,$6,$7,$8,$9,$10)`,[id,next,title,description,asset,price,v.tax_status,v.tax_source,v.tax_version,policy]);
      await c.query(`INSERT INTO dispatch.product_publication(product_id,version,enabled) VALUES($1,$2,$3)
        ON CONFLICT(product_id) DO UPDATE SET version=$2,enabled=$3`,[id,next,v.enabled]);
      return { id,version:next,title,description,kind:'digital',asset_manifest_id:asset,unit_atomic:price,
        tax_status:v.tax_status,tax_source:v.tax_source,tax_version:v.tax_version,policy_version:policy,enabled:v.enabled,purchase_path:'/buy/'+id };
    },productId ? 200 : 201);
  }
  async readiness(auth: OperatorAuthority) {
    await this.auth.session(auth);
    const checks: { code:string;status:'pass'|'blocked'|'unknown';safe_message:string }[] = [];
    const check = (code:string,ok:boolean,message:string) => checks.push({code,status:ok?'pass':'blocked',safe_message:message});
    const migrations = (await this.pool.query('SELECT name,sha256 FROM dispatch.schema_migrations ORDER BY name')).rows;
    const names = (await readdir('db/migrations')).filter(n => /^\d{3}_[a-z_]+\.sql$/.test(n)).sort();
    let schemaOk = names.length === 9 && migrations.length === names.length;
    for (const [i,name] of names.entries()) schemaOk &&= migrations[i]?.name === name && migrations[i]?.sha256 === createHash('sha256').update(await readFile('db/migrations/'+name)).digest('hex');
    check('schema',schemaOk,'Apply all reviewed forward migrations before use.');
    const worker = (await this.pool.query("SELECT EXISTS(SELECT 1 FROM dispatch.runtime_health WHERE service='operations_worker' AND checked_at>clock_timestamp()-interval '30 seconds') ready")).rows[0].ready;
    check('worker',worker,'Start the local operations worker; its last successful tick must be recent.');
    const config = await this.config(auth); check('configuration',config.state==='configured','Save merchant identity, receiving wallet and versioned policies.');
    const products = await this.products(auth); check('product',products.products.some(p=>p.enabled && p.policy_version===config.config?.policy_version),'Import a private asset locally and publish a product with explicit tax treatment.');
    let assetsOk = !!this.files && products.assets.length > 0;
    for (const a of (await this.pool.query('SELECT id,private_relative_path,file_sha256,manifest_sha256,mime_type,download_name,size_bytes FROM dispatch.asset_versions')).rows) { try { await this.files?.read(a); } catch { assetsOk=false; } }
    check('private_assets',assetsOk,'Restore matching immutable private bytes and manifest.');
    try { await this.commerce.readiness(); check('token_provider_rpc',true,'Local token, provider snapshot and RPC checks are current.'); }
    catch { check('token_provider_rpc',false,'Restore the isolated token/RPC and refresh the local provider capability snapshot.'); }
    const state = await this.config(auth);
    check('payments_pause',state.controls.payment_paused===false,'New payments require an explicit resume after readiness checks.');
    check('fulfillment_pause',state.controls.fulfillment_paused===false,'Future delivery requires fulfillment to be resumed.');
    checks.push({code:'live_release',status:'unknown',safe_message:'Real wallets, live providers and production release remain unverified. Mainnet is disabled.'});
    return { payments_ready:checks.filter(c=>!['live_release','fulfillment_pause'].includes(c.code)).every(c=>c.status==='pass'),physical_ready:false,
      checks,controls:state.controls };
  }
  async receipt(auth:OperatorAuthority,id:string) {
    const detail=await this.orders(auth,id);
    return this.read(auth,async(c,ctl)=>{
      const s=(await c.query("SELECT * FROM dispatch.settlements WHERE order_id=$1 AND disposition='credited'",[id])).rows[0];
      const payment=(await c.query('SELECT state FROM dispatch.payment_attempts WHERE id=$1',[s?.attempt_id])).rows[0];
      const refund=(await c.query('SELECT r.state FROM dispatch.refunds r WHERE settlement_id=$1 ORDER BY created_at DESC LIMIT 1',[s?.id])).rows[0];
      if(!s || !detail.product || !detail.order || payment?.state!=='settled')throw new Error('not_ready');
      return {order_id:id,product:detail.product,amount_atomic:s.amount,network:'eip155:8453',asset:getAddress(TOKEN),
        payer:detail.order.original_payer,payee:detail.order.original_payee,tx_hash:s.tx_hash,block_hash:s.block_hash,
        block_number:s.block_number,authorization_log_index:s.authorization_log_index,transfer_log_index:s.transfer_log_index,
        observation_policy:s.observation_policy,payment_status:'settled',fulfillment_status:(await deliveryProjection(c,id,ctl as {fulfillment_paused:boolean;quarantined:boolean})).state,
        refund_status:refund?.state??'none',created_at:s.recorded_at.toISOString(),settlement_id:s.id,
        label:'Purchase record; not an audit, escrow certificate, or proof of shipment.'};
    });
  }
  async retryDelivery(auth:OperatorAuthority,id:string,k:string,input:unknown) {
    uuid(id);const v=object(input,['job_id','expected_fence']);uuid(v.job_id);
    if(typeof v.expected_fence!=='string'||!/^(0|[1-9][0-9]*)$/.test(v.expected_fence))throw new Error('invalid_input');
    return this.command(auth,'retryDelivery',k,{order_id:id,...v},async(c,ctl)=>{
      const o=(await c.query('SELECT * FROM dispatch.orders WHERE id=$1 FOR UPDATE',[id])).rows[0];
      const j=(await c.query('SELECT * FROM dispatch.outbox_jobs WHERE id=$1 AND order_id=$2 FOR UPDATE',[v.job_id,id])).rows[0];
      if(!o||!j||ctl.fulfillment_paused||ctl.quarantined||!['entitlement','merchant_paid'].includes(j.effect_type)
        ||!['retry','dead_letter'].includes(j.state)||String(j.fence)!==v.expected_fence
        ||!['paid','fulfillment_pending','fulfilled'].includes(o.state)||['blocked','revoked'].includes(o.fulfillment_state)
        ||!(await c.query("SELECT s.id FROM dispatch.settlements s JOIN dispatch.payment_attempts a ON a.id=s.attempt_id WHERE s.order_id=$1 AND s.disposition='credited' AND a.state='settled'",[id])).rowCount
        ||(await c.query('SELECT id FROM dispatch.payment_incidents WHERE order_id=$1 AND resolved_at IS NULL',[id])).rowCount)throw new Error('delivery_blocked');
      await c.query("UPDATE dispatch.outbox_jobs SET state='retry',available_at=clock_timestamp() WHERE id=$1 AND fence=$2",[j.id,v.expected_fence]);
      const policy=(await c.query('SELECT policy_version,policy_urls FROM dispatch.merchant_config_versions WHERE id=$1',[o.config_id])).rows[0];
      const payment=(await c.query('SELECT state FROM dispatch.payment_attempts WHERE order_id=$1 ORDER BY created_at DESC LIMIT 1',[id])).rows[0];
      const refund=(await c.query('SELECT r.state FROM dispatch.refunds r JOIN dispatch.settlements s ON s.id=r.settlement_id WHERE s.order_id=$1 ORDER BY r.created_at DESC LIMIT 1',[id])).rows[0];
      return {id,order_state:o.state,payment_state:payment?.state??'none',delivery:await deliveryProjection(c,id,ctl as {fulfillment_paused:boolean;quarantined:boolean}),
        merchant_handoff:await handoffProjection(c,id),refund_state:refund?.state??'none',shipment_state:o.shipment_state,
        ...policy,version:Number(o.version),credential_confirmed:false,next_action:'poll_status',status_path:'/v1/operator/orders/'+id,request_id:randomUUID()};
    },202);
  }
  async orders(auth: OperatorAuthority, id?: string) {
    if (id) uuid(id);
    return this.read(auth, async (c,ctl) => {
      const rows = (await c.query(`SELECT o.id,o.state order_state,o.fulfillment_state delivery_state,o.shipment_state,o.created_at,o.version,
        p.title,p.description,p.product_id,p.version product_version,p.unit_amount::text unit_atomic,cv.merchant_name,cv.policy_version,cv.policy_urls,cv.payee original_payee,
        COALESCE((SELECT a.state FROM dispatch.payment_attempts a WHERE a.order_id=o.id ORDER BY a.created_at DESC LIMIT 1),'none') payment_state,
        COALESCE((SELECT r.state FROM dispatch.refunds r JOIN dispatch.settlements s ON s.id=r.settlement_id WHERE s.order_id=o.id ORDER BY r.created_at DESC LIMIT 1),'none') refund_state,
        (SELECT s.id FROM dispatch.settlements s WHERE s.order_id=o.id AND s.disposition='credited') settlement_id,
        (SELECT a.authorizer FROM dispatch.payment_attempts a JOIN dispatch.settlements s ON s.attempt_id=a.id WHERE s.order_id=o.id AND s.disposition='credited') original_payer,
        (SELECT s.amount::text FROM dispatch.settlements s WHERE s.order_id=o.id AND s.disposition='credited') amount_atomic
        FROM dispatch.orders o JOIN dispatch.products p ON (p.product_id,p.version)=(o.product_id,o.product_version)
        JOIN dispatch.merchant_config_versions cv ON cv.id=o.config_id WHERE ($1::uuid IS NULL OR o.id=$1)
        ORDER BY CASE WHEN o.state IN ('payment_pending','review_required') THEN 0 ELSE 1 END,o.created_at,o.id LIMIT 100`,[id??null])).rows;
      const statuses = [];
      for (const row of rows) statuses.push({id:row.id,order_state:row.order_state,payment_state:row.payment_state,
        delivery:await deliveryProjection(c,row.id,ctl as {fulfillment_paused:boolean;quarantined:boolean}),merchant_handoff:await handoffProjection(c,row.id),
        refund_state:row.refund_state,shipment_state:row.shipment_state,policy_version:row.policy_version,policy_urls:row.policy_urls,version:Number(row.version),
        credential_confirmed:false,next_action:'poll_status',status_path:'/v1/operator/orders/'+row.id,request_id:randomUUID()});
      if (!id) return { orders:statuses,summaries:rows };
      if (!rows[0]) throw new Error('not_found');
      const timeline = (await c.query(`SELECT recorded_at time,'payment_observed' kind,'Independently verified settlement; history retained' safe_message FROM dispatch.settlements WHERE order_id=$1
        UNION ALL SELECT created_at,'delivery',state FROM dispatch.entitlements WHERE order_id=$1
        UNION ALL SELECT recorded_at,'merchant_handoff','Durable receiver receipt' FROM dispatch.merchant_receipts mr JOIN dispatch.merchant_events me ON me.event_id=mr.event_id WHERE me.order_id=$1
        UNION ALL SELECT max(ro.recorded_at),'refund_'||ro.kind,'Refund evidence recorded separately from payment ('||count(*)::text||' observations; latest shown)' FROM dispatch.refund_observations ro JOIN dispatch.refunds r ON r.id=ro.refund_id JOIN dispatch.settlements s ON s.id=r.settlement_id WHERE s.order_id=$1 GROUP BY r.id,ro.kind
        ORDER BY time`,[id])).rows;
      const refunds = (await c.query('SELECT r.id,r.state,r.version FROM dispatch.refunds r JOIN dispatch.settlements s ON s.id=r.settlement_id WHERE s.order_id=$1 ORDER BY r.created_at',[id])).rows;
      const row=rows[0];
      return { status:statuses[0],product:{id:row.product_id,version:row.product_version,title:row.title,description:row.description,merchant_name:row.merchant_name,
        kind:'digital',indicative_amount_atomic:row.unit_atomic,network:'eip155:8453',asset:getAddress(TOKEN),purchase_path:'/buy/'+row.product_id,policy_urls:row.policy_urls,available:false},order:row,timeline,refunds,retry_jobs:(await c.query("SELECT id,fence::text FROM dispatch.outbox_jobs WHERE order_id=$1 AND effect_type IN ('entitlement','merchant_paid') AND state IN ('retry','dead_letter') ORDER BY id",[id])).rows };
    });
  }
}
