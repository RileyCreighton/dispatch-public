import { getAddress } from 'viem';
import { randomUUID } from 'node:crypto';
import type { Pool,PoolClient } from 'pg';
import { OperatorStore,recipient,version } from './operator.js';
import type { OperatorAuthority } from './operator-auth.js';
import { control,transaction } from './commerce.js';
import { object,uuid,TOKEN } from '../../domain/src/payment.js';
import { RefundRpc,refundCalldata,type RefundBinding } from '../../payments/src/refund.js';
export async function refundView(c:Pool|PoolClient,id:string,sign=false) {
  const r=(await c.query(`SELECT r.*,s.order_id FROM dispatch.refunds r JOIN dispatch.settlements s ON s.id=r.settlement_id WHERE r.id=$1`,[uuid(id)])).rows[0];
  if(!r)throw new Error('not_found');
  return {id:r.id,order_id:r.order_id,settlement_id:r.settlement_id,amount_atomic:r.amount,destination:r.destination,token:getAddress(r.token),
    expected_signer:r.expected_signer,state:r.state,version:Number(r.version),next_action:sign?'sign_once':'poll_status',
    ...(r.wallet_started_at?{binding:{chain_id:r.chain_id,wallet_account_nonce:r.wallet_account_nonce,prepare_block:r.prepare_block,
      prepare_block_hash:r.prepare_block_hash,prepare_observed_at:r.prepare_observed_at.toISOString(),wallet_started_at:r.wallet_started_at.toISOString(),
      transaction_to:getAddress(r.transaction_to),transaction_value:r.transaction_value,transaction_calldata:r.transaction_calldata}}:{}),
    ...(r.tx_hash?{transaction_hint:r.tx_hash}:{})};
}
export class RefundStore {
  constructor(readonly operator:OperatorStore,readonly chain:RefundRpc,readonly noSendAdapters:ReadonlySet<string>=new Set()) {}
  get(auth:OperatorAuthority,id:string) { return this.operator.read(auth,c=>refundView(c,id)); }
  async prepare(auth:OperatorAuthority,order:string,k:string,input:unknown) {
    uuid(order);const v=object(input,['settlement_id','confirmed_original_payer','expected_signer']);
    const settlement=uuid(v.settlement_id),payer=recipient(v.confirmed_original_payer),signer=recipient(v.expected_signer);
    const old=await this.operator.replay(auth,'prepareRefund',k,{order_id:order,settlement_id:settlement,confirmed_original_payer:payer,expected_signer:signer});if(old)return old;
    await this.operator.auth.session(auth);
    const prior=(await this.operator.pool.query('SELECT block_number,block_hash FROM dispatch.settlements WHERE id=$1',[settlement])).rows[0];
    if(!prior || !await this.chain.original(prior.block_number,prior.block_hash))throw new Error('refund_review_required');
    const checked=Date.now();
    return this.operator.command(auth,'prepareRefund',k,{order_id:order,settlement_id:settlement,confirmed_original_payer:payer,expected_signer:signer},async(c,ctl)=>{
      await c.query('SELECT id FROM dispatch.orders WHERE id=$1 FOR UPDATE',[order]);
      const s=(await c.query(`SELECT s.*,a.authorizer,a.state payment_state,a.token FROM dispatch.settlements s
        JOIN dispatch.payment_attempts a ON a.id=s.attempt_id WHERE s.id=$1 AND s.order_id=$2`,[settlement,order])).rows[0];
      if(ctl.quarantined || !s || s.disposition!=='credited' || s.payment_state!=='settled' || s.authorizer!==payer || s.token!==TOKEN || s.observation_policy!=='safe'
        || Date.now()-checked>5000 || (await c.query('SELECT id FROM dispatch.payment_incidents WHERE order_id=$1 AND resolved_at IS NULL',[order])).rowCount)throw new Error('refund_review_required');
      const id=randomUUID();
      await c.query(`INSERT INTO dispatch.refunds(id,settlement_id,destination,amount,token,expected_signer,operation_id,state,approved_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,'prepared',clock_timestamp())`,[id,settlement,payer,s.amount,s.token,signer,randomUUID()]);
      return refundView(c,id);
    },201);
  }
  async start(auth:OperatorAuthority,id:string,k:string,input:unknown) {
    const v=object(input,['expected_version','signer','observed_account_nonce']);version(v.expected_version);const signer=recipient(v.signer);
    if(typeof v.observed_account_nonce!=='string'||!/^(0|[1-9][0-9]*)$/.test(v.observed_account_nonce))throw new Error('invalid_input');
    const replay=await this.operator.replay(auth,'refundWalletStart',k,{refund_id:id,...v,signer});if(replay)return replay;
    const saved=await this.get(auth,id);
    if(saved.binding && !await this.chain.original(saved.binding.prepare_block,saved.binding.prepare_block_hash))throw new Error('refund_review_required');
    const observation=await this.chain.prepare(signer);
    const identified=(await this.operator.pool.query(`SELECT s.order_id,s.block_number,s.block_hash FROM dispatch.refunds r JOIN dispatch.settlements s ON s.id=r.settlement_id WHERE r.id=$1`,[id])).rows[0];
    if(!identified || !await this.chain.original(identified.block_number,identified.block_hash))throw new Error('refund_review_required');
    return this.operator.command(auth,'refundWalletStart',k,{refund_id:id,...v,signer},async(c,ctl)=>{
      await c.query('SELECT id FROM dispatch.orders WHERE id=$1 FOR UPDATE',[identified.order_id]);
      const r=(await c.query('SELECT * FROM dispatch.refunds WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(ctl.quarantined || (await c.query('SELECT id FROM dispatch.payment_incidents WHERE order_id=$1 AND resolved_at IS NULL',[identified.order_id])).rowCount)throw new Error('refund_review_required');
      if(Number(r.version)!==v.expected_version || !((r.state==='prepared'&&!r.wallet_started_at)||(r.state==='rejected'&&r.wallet_started_at&&r.no_send_evidence)) || r.expected_signer!==signer)throw new Error('refund_conflict');
      if(Date.now()-observation.observedAt>5000 || observation.nonce!==v.observed_account_nonce)throw new Error('refund_review_required');
      if(r.wallet_started_at) {
        if(r.wallet_account_nonce!==observation.nonce)throw new Error('refund_review_required');
        await c.query("INSERT INTO dispatch.refund_observations(id,refund_id,kind,evidence) VALUES($1,$2,'explicit_rejection_retry',$3)",[randomUUID(),id,JSON.stringify({prior_no_send:r.no_send_evidence,readiness:observation})]);
        await c.query("UPDATE dispatch.refunds SET state='wallet_pending',no_send_evidence=NULL,wallet_start_version=version+1,version=version+1 WHERE id=$1",[id]);
      } else {
        await c.query(`UPDATE dispatch.refunds SET state='wallet_pending',chain_id=8453,wallet_account_nonce=$2,prepare_block=$3,prepare_block_hash=$4,
          prepare_observed_at=$5,wallet_started_at=clock_timestamp(),transaction_to=token,transaction_value=0,transaction_calldata=$6,wallet_start_version=version+1,version=version+1 WHERE id=$1`,
        [id,observation.nonce,observation.block,observation.hash,new Date(observation.observedAt),refundCalldata(r.destination,r.amount)]);
      }
      await c.query(`INSERT INTO dispatch.refund_observations(id,refund_id,kind,evidence) VALUES($1,$2,'wallet_authorized',$3)`,[randomUUID(),id,JSON.stringify({nonce:observation.nonce,anchor:observation.block,anchor_hash:observation.hash})]);
      // Binding review only. Ownership claim and final one-use authorization are separate.
      return refundView(c,id);
    });
  }
  async invoke(auth:OperatorAuthority,id:string,input:unknown) {
    const v=object(input,['expected_version']);version(v.expected_version);
    const identified=await this.get(auth,id);
    if(!identified.binding)throw new Error('refund_conflict');
    const observed=await this.chain.prepare(identified.expected_signer);
    const original=(await this.operator.pool.query('SELECT block_number,block_hash FROM dispatch.settlements WHERE id=$1',[identified.settlement_id])).rows[0];
    if(observed.nonce!==identified.binding.wallet_account_nonce || !original
      || !await this.chain.original(original.block_number,original.block_hash)
      || !await this.chain.original(identified.binding.prepare_block,identified.binding.prepare_block_hash))throw new Error('refund_review_required');
    return transaction(this.operator.pool,async c=>{
      const ctl=await control(c);await c.query('SELECT id FROM dispatch.orders WHERE id=$1 FOR UPDATE',[identified.order_id]);
      const r=(await c.query('SELECT * FROM dispatch.refunds WHERE id=$1 FOR UPDATE',[id])).rows[0];
      const session=await this.operator.auth.require(c,auth,true,true);
      if(ctl.quarantined||r.state!=='wallet_pending'||Number(r.version)!==v.expected_version||r.tx_hash)throw new Error('refund_conflict');
      if(Date.now()-observed.observedAt>5000||r.wallet_account_nonce!==observed.nonce)throw new Error('refund_review_required');
      if((await c.query('SELECT id FROM dispatch.payment_incidents WHERE order_id=$1 AND resolved_at IS NULL',[identified.order_id])).rowCount)throw new Error('refund_review_required');
      await c.query(`INSERT INTO dispatch.audit_events(id,actor_kind,actor_reference,order_id,action,safe_fields) VALUES($1,'operator',$2,$3,'refundInvocation',$4)`,[randomUUID(),session.id,identified.order_id,JSON.stringify({refund_id:id,wallet_start_version:r.wallet_start_version})]);
      await c.query('INSERT INTO dispatch.refund_invocations(refund_id,wallet_start_version,operator_session) VALUES($1,$2,$3)',[id,r.wallet_start_version,session.id]);
      return refundView(c,id);
    });
  }
  // Final server authority boundary, after browser wallet reads. Never replay or recycle it.
  async authorize(auth:OperatorAuthority,id:string,input:unknown) {
    const v=object(input,['expected_version']);version(v.expected_version);
    const identified=await this.get(auth,id);
    if(!identified.binding)throw new Error('refund_conflict');
    const observed=await this.chain.prepare(identified.expected_signer);
    const original=(await this.operator.pool.query('SELECT block_number,block_hash FROM dispatch.settlements WHERE id=$1',[identified.settlement_id])).rows[0];
    if(!original || !await this.chain.original(original.block_number,original.block_hash)
      || !await this.chain.original(identified.binding.prepare_block,identified.binding.prepare_block_hash))throw new Error('refund_review_required');
    return transaction(this.operator.pool,async c=>{
      const ctl=await control(c);await c.query('SELECT id FROM dispatch.orders WHERE id=$1 FOR UPDATE',[identified.order_id]);
      const r=(await c.query('SELECT * FROM dispatch.refunds WHERE id=$1 FOR UPDATE',[id])).rows[0];
      const session=await this.operator.auth.require(c,auth,true,true);
      const claim=(await c.query('SELECT * FROM dispatch.refund_invocations WHERE refund_id=$1 AND wallet_start_version=$2',[id,r.wallet_start_version])).rows[0];
      if(!claim || claim.operator_session!==session.id || ctl.quarantined || r.state!=='wallet_pending'
        || Number(r.version)!==v.expected_version || r.tx_hash)throw new Error('refund_conflict');
      if(Date.now()-observed.observedAt>5000 || r.wallet_account_nonce!==observed.nonce)throw new Error('refund_review_required');
      if((await c.query('SELECT id FROM dispatch.payment_incidents WHERE order_id=$1 AND resolved_at IS NULL',[identified.order_id])).rowCount)throw new Error('refund_review_required');
      await c.query(`INSERT INTO dispatch.refund_authorizations(refund_id,wallet_start_version,operator_session,anchor_block,anchor_hash,observed_at)
        VALUES($1,$2,$3,$4,$5,$6)`,[id,r.wallet_start_version,session.id,observed.block,observed.hash,new Date(observed.observedAt)]);
      const window=(await c.query(`SELECT greatest(0,least(5000,extract(epoch FROM ($1::timestamptz-clock_timestamp()))*1000,extract(epoch FROM ($2::timestamptz+interval '5 minutes'-clock_timestamp()))*1000))::integer ms`,[session.expires_at,session.fresh_auth_at])).rows[0];
      return {...await refundView(c,id,true),authorization_window_ms:window.ms};
    });
  }
  async observation(auth:OperatorAuthority,id:string,k:string,input:unknown) {
    const v=object(input,['expected_version','outcome','transaction_hash','no_send_evidence','invocation_version']);version(v.expected_version);
    if(!['transaction_hash','unknown','user_rejected_before_send'].includes(String(v.outcome)))throw new Error('invalid_input');
    if(v.outcome==='transaction_hash' && (typeof v.transaction_hash!=='string'||!/^0x[0-9a-f]{64}$/.test(v.transaction_hash)))throw new Error('invalid_input');
    if(v.invocation_version!==undefined)version(v.invocation_version);
    // No named real-wallet adapter is verified. A client 4001 alone is not affirmative no-send evidence.
    if(v.no_send_evidence!==undefined) { const n=object(v.no_send_evidence,['wallet_start_version','adapter_id','stage','wallet_error_code']);
      if(n.wallet_start_version!==v.expected_version || n.stage!=='before_signing'||n.wallet_error_code!==4001||typeof n.adapter_id!=='string'||n.adapter_id.length>128)throw new Error('invalid_input'); }
    const replay=await this.operator.replay(auth,'refundObservation',k,{refund_id:id,...v});if(replay)return replay;
    const identified=await this.get(auth,id);
    let corroborated=false,observedAt=0;
    if(v.outcome==='user_rejected_before_send' && v.no_send_evidence && identified.binding) {
      const report=v.no_send_evidence as Record<string,unknown>;
      if(this.noSendAdapters.has(String(report.adapter_id))) {
        const observed=await this.chain.prepare(identified.expected_signer);observedAt=observed.observedAt;
        corroborated=observed.nonce===identified.binding.wallet_account_nonce && await this.chain.original(identified.binding.prepare_block,identified.binding.prepare_block_hash);
      }
    }
    return this.operator.command(auth,'refundObservation',k,{refund_id:id,...v},async c=>{
      await c.query('SELECT id FROM dispatch.orders WHERE id=$1 FOR UPDATE',[identified.order_id]);
      const r=(await c.query('SELECT * FROM dispatch.refunds WHERE id=$1 FOR UPDATE',[id])).rows[0];
      const hashHint=v.outcome==='transaction_hash'||v.invocation_version!==undefined;
      if(!r.wallet_started_at || (hashHint ? Number(v.expected_version)<Number(r.wallet_start_version)||Number(v.expected_version)>Number(r.version) : Number(r.version)!==v.expected_version)
        || !['wallet_pending','broadcast_unknown','submitted','review_required','confirmed'].includes(r.state))throw new Error('refund_conflict');
      if(v.invocation_version!==undefined) {
        const permission=(await c.query('SELECT * FROM dispatch.refund_authorizations WHERE refund_id=$1 AND wallet_start_version=$2',[id,v.invocation_version])).rows[0];
        if(!permission || Number(r.wallet_start_version)!==v.invocation_version)throw new Error('refund_conflict');
        // Operator reports an already-started call. This is evidence, never fresh sending authority.
        await c.query("INSERT INTO dispatch.refund_observations(id,refund_id,kind,evidence) VALUES($1,$2,'wallet_invoked',$3)",[randomUUID(),id,JSON.stringify({invocation_version:v.invocation_version,outcome:v.outcome,transaction_hash:v.transaction_hash??null})]);
      }
      const hash=v.outcome==='transaction_hash'?v.transaction_hash:null;
      if(hash)await c.query('INSERT INTO dispatch.refund_transaction_hints(refund_id,transaction_hash) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,hash]);
      const conflictingHash=!!(r.tx_hash&&hash&&r.tx_hash!==hash);
      const noSend=corroborated && Date.now()-observedAt<=5000 && !r.tx_hash && r.state==='wallet_pending';
      const state=conflictingHash?'review_required':r.state==='confirmed'?'confirmed':hash?'submitted':v.outcome==='user_rejected_before_send'?(noSend?'rejected':'review_required'):r.tx_hash?'submitted':'broadcast_unknown';
      await c.query('UPDATE dispatch.refunds SET state=$2,tx_hash=COALESCE(tx_hash,$3),no_send_evidence=$4,version=version+1 WHERE id=$1',[id,state,hash,noSend?JSON.stringify(v.no_send_evidence):null]);
      await c.query('INSERT INTO dispatch.refund_observations(id,refund_id,kind,evidence) VALUES($1,$2,$3,$4)',[randomUUID(),id,String(v.outcome),JSON.stringify(v)]);
      return refundView(c,id);
    },202);
  }
}
export async function reconcileRefund(pool:Pool,id:string,chain:RefundRpc) {
  const row=(await pool.query(`SELECT r.*,s.order_id,s.block_number original_block,s.block_hash original_hash
    FROM dispatch.refunds r JOIN dispatch.settlements s ON s.id=r.settlement_id WHERE r.id=$1`,[uuid(id)])).rows[0];
  if(!row?.wallet_started_at)return;
  const authorization=(await pool.query(`SELECT a.* FROM dispatch.refund_authorizations a
    WHERE a.refund_id=$1 AND a.wallet_start_version=$2 AND EXISTS(SELECT 1 FROM dispatch.refund_observations o
      WHERE o.refund_id=a.refund_id AND o.kind='wallet_invoked' AND o.evidence->>'invocation_version'=a.wallet_start_version::text)`,[id,row.wallet_start_version])).rows[0];
  if(authorization){row.invocation_version=authorization.wallet_start_version;row.invocation_block=authorization.anchor_block;row.invocation_hash=authorization.anchor_hash;}
  const scan=(await pool.query("SELECT evidence FROM dispatch.refund_observations WHERE refund_id=$1 AND evidence ? 'scan_hash' ORDER BY recorded_at DESC,id DESC LIMIT 1",[id])).rows[0];
  if(scan){row.scan_cursor=scan.evidence.scan_end;row.scan_hash=scan.evidence.scan_hash;}
  const evidence=await chain.observe(row as RefundBinding,async hash=>{await pool.query('INSERT INTO dispatch.refund_transaction_hints(refund_id,transaction_hash) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,hash]);});
  if(evidence.tx)await pool.query('INSERT INTO dispatch.refund_transaction_hints(refund_id,transaction_hash) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,evidence.tx]);
  return transaction(pool,async c=>{
    const ctl=await control(c);await c.query('SELECT id FROM dispatch.orders WHERE id=$1 FOR UPDATE',[row.order_id]);
    const current=(await c.query('SELECT * FROM dispatch.refunds WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(current.version!==row.version)return;
    const incident=(await c.query('SELECT id FROM dispatch.payment_incidents WHERE order_id=$1 AND resolved_at IS NULL',[row.order_id])).rowCount;
    const state=ctl.quarantined||incident?'review_required':evidence.state==='pending'?(current.state==='confirmed'?'review_required':current.state==='wallet_pending'||current.state==='rejected'?current.state:current.tx_hash?'submitted':'broadcast_unknown'):evidence.state;
    await c.query('INSERT INTO dispatch.refund_observations(id,refund_id,kind,evidence) VALUES($1,$2,$3,$4)',[randomUUID(),id,state,JSON.stringify(evidence.evidence)]);
    if(evidence.state==='pending' && state===current.state)return state;
    // Never erase an earlier confirmed observation on reorg; append uncertainty and retain its identity.
    await c.query(`UPDATE dispatch.refunds SET state=$2,tx_hash=COALESCE(tx_hash,$3),transfer_log_index=COALESCE(transfer_log_index,$4),
      block_number=COALESCE(block_number,$5),block_hash=COALESCE(block_hash,$6),verification_evidence=$7,
      scan_cursor=COALESCE($8,scan_cursor),scan_hash=COALESCE($9,scan_hash),version=version+1 WHERE id=$1`,
    [id,state,evidence.tx??null,evidence.log??null,evidence.block??null,evidence.hash??null,JSON.stringify(evidence.evidence),evidence.cursor??null,evidence.cursorHash??null]);
    // Existing purchased policy has no revocation clause. Preserve future access; never rewrite payment/budget history.
    return state;
  });
}
