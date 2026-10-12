import test from 'node:test';
import assert from 'node:assert/strict';
import { digitalTotal,object,key,uuid } from '../../dist/packages/domain/src/payment.js';
import { LocalRpc } from '../../dist/packages/payments/src/rpc.js';
import { randomUUID } from 'node:crypto';
test('digital arithmetic remains exact through uint256 and requires explicit configured tax evidence',()=>{
 for(const status of ['tax_included','merchant_attested_zero'])assert.equal(digitalTotal('115792089237316195423570985008687907853269984665640564039457584007913129639935',status,'merchant','v1'),'115792089237316195423570985008687907853269984665640564039457584007913129639935');
 for(const x of ['0','1.5','01','-1','1e5',1])assert.throws(()=>digitalTotal(x,'tax_included','merchant','v1'));
 for(const status of ['unknown','calculated',null])assert.throws(()=>digitalTotal('1',status,'merchant','v1'));
 assert.throws(()=>digitalTotal('1','tax_included','','v1'));
});
test('runtime object/key/identifier boundaries reject extra authority and non-canonical identity',()=>{
 assert.equal(uuid(randomUUID()).length,36);assert.throws(()=>uuid('../order'));
 for(const x of [null,[],{payee:'attacker'}])assert.throws(()=>object(x,['quote_id']));
 for(const x of ['', 'x'.repeat(129),'space key'])assert.throws(()=>key(x));
});
test('local independent RPC rejects external, credentialed and query endpoints',()=>{
 for(const url of ['https://mainnet.base.org','http://localhost:8545','http://127.0.0.1:8545?key=x','http://secret@127.0.0.1:8545','http://127.0.0.1:8545#x'])assert.throws(()=>new LocalRpc(url));
 assert.ok(new LocalRpc('http://127.0.0.1:8545'));
});
