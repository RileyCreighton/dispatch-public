import test from 'node:test';
import assert from 'node:assert/strict';
import {localFixtureSigner} from '../../scripts/local-fixture-signer.mjs';
const metadata={clientVersion:'anvil/v1.7.1',chainId:8453,forkedNetwork:null,instanceId:'0x'+'12'.repeat(32)};
const address='0x'+'33'.repeat(20),data={primaryType:'TransferWithAuthorization',domain:{chainId:8453,name:'USD Coin',version:'2',verifyingContract:'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'},message:{from:address}};
test('live RPC without Anvil metadata cannot obtain a fixture signature',async()=>{
  let calls=0;await assert.rejects(localFixtureSigner({address,signTypedData(){calls++;}},async()=>{throw Error('method not found');}));assert.equal(calls,0);
});
test('a fork or replaced instance cannot obtain a fixture signature',async()=>{
  let calls=0,m={...metadata};const a={address,signTypedData(){calls++;}};
  await assert.rejects(localFixtureSigner(a,async()=>({...m,forkedNetwork:{chainId:8453}})));
  const signer=await localFixtureSigner(a,async()=>m);m={...m,instanceId:'0x'+'34'.repeat(32)};
  await assert.rejects(signer.signTypedData(data));assert.equal(calls,0);
});
test('the fixture signer checks every request and allows only one authorization',async()=>{
  let calls=0,reads=0;const signer=await localFixtureSigner({address,signTypedData(){calls++;return 'fixture-signature';}},async()=>{reads++;return metadata;});
  await assert.rejects(signer.signTypedData({...data,primaryType:'Permit'}));assert.equal(calls,0);
  assert.equal(await signer.signTypedData(data),'fixture-signature');await assert.rejects(signer.signTypedData(data));assert.equal(calls,1);assert.equal(reads,3);
});
test('failed signing never opens a second invocation',async()=>{
  let calls=0;const signer=await localFixtureSigner({address,signTypedData(){calls++;throw Error('ambiguous signing result');}},async()=>metadata);
  await assert.rejects(signer.signTypedData(data));await assert.rejects(signer.signTypedData(data));assert.equal(calls,1);
});
test('concurrent requests cannot both invoke the fixture wallet',async()=>{
  let calls=0,reads=0,release;const barrier=new Promise(resolve=>{release=resolve;});
  const signer=await localFixtureSigner({address,signTypedData(){calls++;return 'fixture-signature';}},async()=>{
    reads++;if(reads>1){if(reads===3)release();await barrier;}return metadata;
  });
  const outcomes=await Promise.allSettled([signer.signTypedData(data),signer.signTypedData(data)]);
  assert.equal(calls,1);assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(outcomes.filter(x=>x.status==='rejected').length,1);
});
