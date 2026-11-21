'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Wallet,Interface,keccak256,Transaction,sha256}=require('ethers');
const TronWeb=require('tronweb');
const {configs,jobsFor,nextCursor,step}=require('./treasury');
const {evmAdapter,matchingTransfer,isPositiveTransfer}=require('./treasury-evm');
const {checkTronIntent}=require('./treasury-tron');

const owner=Wallet.createRandom(),recipient=Wallet.createRandom(),uid='b6359009-6e6f-40f9-80bb-cb8f10d91cb4';
const base={TREASURY_MODE:'live',ADMIN_SWEEP_ADDRESS:recipient.address,TREASURY_POLICY:
  JSON.stringify({ethereum:{maxFee:'0.001',dailyFee:'0.01',minNative:'0.0005'}})};
const urls={eth:'https://eth-mainnet.g.alchemy.com',bsc:'https://bnb-mainnet.g.alchemy.com'};
const cfg=configs(base,urls)[0];
test('live collection needs exact recipients and unit-denominated caps',()=>{
  assert.deepEqual(configs({},{}),[]);
  assert.throws(()=>configs({...base,ADMIN_SWEEP_ADDRESS:''},urls));
  assert.throws(()=>configs({...base,TREASURY_POLICY:'{"tron":{"maxFee":"12","dailyFee":"50","minNative":"1"}}'},urls),/TRON|tron/);
  assert.throws(()=>configs({...base,TREASURY_POLICY:'{"bsc":{"maxFee":"1","dailyFee":"2","minNative":"1"}}'},urls),/HANDOVER/);
  assert.throws(()=>configs({...base,TREASURY_POLICY:'{"ethereum":{"maxFee":"2","dailyFee":"1","minNative":"1"}}'},urls),/INVERTED/);
});
test('legacy per-network addresses are distinct and each address keeps the correct signing network',()=>{
  const row={user_id:uid,usdt_erc20_address:owner.address,usdc_erc20_address:recipient.address,usdt_bep20_address:owner.address};
  const jobs=jobsFor(row,cfg);
  assert.equal(jobs.length,6);assert.deepEqual(jobs.map(x=>x.symbol),['USDT','USDC','ETH','USDT','USDC','ETH']);
  assert.deepEqual(jobs.map(x=>x.network),[...Array(3).fill('usdt_bep20'),...Array(3).fill('usdc_erc20')]);
});
test('priority credit retains the inventory scan position',()=>{
  assert.deepEqual(nextCursor({request:87,after:uid,position:2},true),{after:uid,ack:87,priority:1});
});
test('legacy no-return token, false-return token and receipt verification',()=>{
  assert.equal(isPositiveTransfer('0x'),true);assert.equal(isPositiveTransfer('0x'+'0'.repeat(64)),false);
  const decoder=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  const event=decoder.encodeEventLog(decoder.getEvent('Transfer'),[owner.address,recipient.address,30n]);
  const token=cfg.tokens[0].address;
  assert.equal(matchingTransfer([{...event,address:token}],token,owner.address,recipient.address,'30'),true);
  assert.equal(matchingTransfer([{...event,address:token}],token,owner.address,recipient.address,'31'),false);
});
function harness(mode='live') {
  const cfg2={...cfg,mode};let pending=null,cursor={user:uid,position:0};let updates=0,broadcasts=0,reads=0;
  let fenced=false;let confirmed=false;let kind='collect';let wrong=false;
  const row={user_id:uid,usdt_erc20_address:owner.address};
  const db={from(name){assert.equal(name,'deposit_wallets');return {select(){return this;},eq(){return this;},async maybeSingle(){return {data:row};}};},
    async rpc(name,args){
      if(name==='treasury_claim')return {data:[{revision:updates,cursor_state:cursor,pending}]};
      if(name==='deposit_key_envelope'){reads++;return {data:{address:wrong?recipient.address:owner.address,server_cipher:'test-only'}};}
      assert.equal(name,'treasury_advance');if(fenced)return {data:false};
      updates++;pending=args.p_pending;cursor=args.p_cursor;return {data:true};
    }};
  const adapter={same:(a,b)=>a.toLowerCase()===b.toLowerCase(),async plan(){return {kind,from:owner.address,to:recipient.address,amount:9n,fee:2n};},
    async sign(){return {hash:'test-hash',raw:'only-one-signed-transaction'};},async inspect(){return confirmed?'confirmed':'broadcast';},
    async broadcast(p){assert.equal(p,pending,'must persist before broadcast');broadcasts++;}};
  return {run:()=>step(db,cfg2,adapter,()=>owner.privateKey,()=>{},uid),fence(){fenced=true;},confirm(){confirmed=true;},
    wrong(){wrong=true;},fund(){kind='fund';},get state(){return {pending,cursor,updates,broadcasts,reads};}};
}
test('a stale lease cannot send, and observation never requests a private key',async()=>{
  const h=harness();h.fence();await h.run();assert.equal(h.state.broadcasts,0);
  const o=harness('observe');await o.run();assert.equal(o.state.reads,0);assert.equal(o.state.broadcasts,0);
});
test('restart replays exactly the journalled transaction then advances the cursor after receipt',async()=>{
  const h=harness();await h.run();const first=h.state.pending;assert.ok(first);
  await h.run();assert.deepEqual(h.state.pending,first);assert.equal(h.state.reads,1);
  h.confirm();await h.run();assert.equal(h.state.pending,null);assert.equal(h.state.cursor.position,1);
});
test('gas is only advanced to a proven custody address and a confirmed advance stays on the token job',async()=>{
  const h=harness();h.wrong();h.fund();await h.run();assert.equal(h.state.broadcasts,0);
  const ok=harness();ok.fund();await ok.run();ok.confirm();await ok.run();assert.equal(ok.state.cursor.position,0);
  assert.ok(ok.state.cursor.funded);
});
test('local EVM signature commits to chain, recipient, fee and token amount',async()=>{
  const adapter=evmAdapter(cfg);
  const tx={to:recipient.address,value:3n,chainId:1,gasLimit:21000n,gasPrice:100n,nonce:4,type:0};
  const signed=await adapter.sign({kind:'collect',from:owner.address,tx},owner.privateKey);
  const t=Transaction.from(signed.raw);assert.equal(t.from,owner.address);assert.equal(t.to,recipient.address);assert.equal(t.chainId,1n);
  assert.equal(signed.hash,keccak256(signed.raw));
  await assert.rejects(adapter.sign({kind:'collect',from:recipient.address,tx},owner.privateKey),/MISMATCH/);
});
test('TRON transaction field and byte validation works with genuinely serialized local transactions',()=>{
  const from='41'+owner.address.slice(2).toLowerCase(),to='41'+recipient.address.slice(2).toLowerCase();
  const now=Date.now();
  const raw_data={contract:[{parameter:{value:{amount:11,owner_address:from,to_address:to},
    type_url:'type.googleapis.com/protocol.TransferContract'},type:'TransferContract'}],ref_block_bytes:'1337',
    ref_block_hash:'1234567812345678',expiration:now+60000,timestamp:now};
  const tx={raw_data};const u=TronWeb.utils.transaction;
  const proto=u.txJsonToPb(tx);tx.raw_data_hex=u.txPbToRawDataHex(proto).toLowerCase();tx.txID=sha256('0x'+tx.raw_data_hex).slice(2);
  const intent={from,to,kind:'fund',amount:'11',fee:'1000'};checkTronIntent(tx,intent);
  assert.throws(()=>checkTronIntent(tx,{...intent,amount:12}),/MISMATCH/);
  assert.throws(()=>checkTronIntent({...tx,raw_data_hex:'abcd'},intent),/INVALID/);
});
