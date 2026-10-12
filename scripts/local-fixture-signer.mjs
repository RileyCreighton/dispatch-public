// Demo-only adapter. No configurable public RPC and no exported key material.
import assert from 'node:assert/strict';
const token='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export async function localFixtureSigner(account,request){
  async function metadata(){
    const m=await request('anvil_metadata');
    assert.match(m.clientVersion,/^anvil\//,'generated signer requires Anvil');
    assert.equal(m.chainId,8453,'unexpected fixture chain');
    assert.equal(m.forkedNetwork,null,'forked chains are forbidden');
    assert.match(m.instanceId,/^0x[0-9a-f]{64}$/);
    return m.instanceId;
  }
  const instance=await metadata();let used=false;
  return {address:account.address,async signTypedData(data){
    assert.equal(used,false,'generated signer refuses a second authorization');
    assert.equal(await metadata(),instance,'fixture chain changed');
    assert.equal(data.primaryType,'TransferWithAuthorization');
    assert.equal(Number(data.domain.chainId),8453);
    assert.equal(data.domain.verifyingContract.toLowerCase(),token);
    assert.equal(data.domain.name,'USD Coin');assert.equal(data.domain.version,'2');
    assert.equal(data.message.from.toLowerCase(),account.address.toLowerCase());
    // Metadata is asynchronous: recheck after it, immediately before invocation.
    assert.equal(used,false,'generated signer refuses a second authorization');
    used=true;return account.signTypedData(data);
  }};
}
