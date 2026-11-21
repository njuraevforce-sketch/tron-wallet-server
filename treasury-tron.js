'use strict';
const crypto = require('node:crypto');
const TronWeb = require('tronweb');
const { matchingTransfer } = require('./treasury-evm');
const { Interface } = require('ethers');
const abi=new Interface(['function transfer(address,uint256) returns(bool)']);
const hex20=a=>'0x'+TronWeb.address.toHex(a).slice(2).toLowerCase();
const padded=a=>hex20(a).slice(2).padStart(64,'0');
const digest=hex=>crypto.createHash('sha256').update(Buffer.from(hex,'hex')).digest('hex');
const integer=n=>{const v=Number(n);if(!Number.isSafeInteger(v)||v<0)throw Error('TRON_INTEGER_RANGE');return v;};
const same=(a,b)=>TronWeb.address.toHex(a).toLowerCase()===TronWeb.address.toHex(b).toLowerCase();
const base='https://api.trongrid.io';

function checkTronIntent(tx,p) {
  const raw=tx?.raw_data;
  if (!raw || !tx.raw_data_hex || digest(tx.raw_data_hex)!==tx.txID || !TronWeb.utils.transaction.txCheck(tx)
    || raw.contract?.length!==1 || raw.data || raw.auths?.length) throw Error('TRON_INVALID_UNSIGNED_TRANSACTION');
  const c=raw.contract[0],v=c.parameter?.value;
  if (!v || c.Permission_id || c.permission_id || !same(v.owner_address,p.from)) throw Error('TRON_UNEXPECTED_OWNER');
  if (p.kind==='collect' && p.token) {
    const data=abi.encodeFunctionData('transfer',[hex20(p.to),p.amount]).slice(2);
    if(c.type!=='TriggerSmartContract' || !same(v.contract_address,p.token) || v.data.toLowerCase()!==data
      || Number(v.call_value||0)!==0 || Number(v.call_token_value||0)!==0 || BigInt(raw.fee_limit||0)>BigInt(p.fee))
      throw Error('TRON_TOKEN_INTENT_MISMATCH');
  } else if(c.type!=='TransferContract'||!same(v.to_address,p.to)||BigInt(v.amount)!==BigInt(p.amount)) {
    throw Error('TRON_NATIVE_INTENT_MISMATCH');
  }
  if(raw.expiration<=raw.timestamp || raw.expiration-raw.timestamp>24*3600000) throw Error('TRON_INVALID_EXPIRY');
}

function tronAdapter(cfg) {
  const headers={'TRON-PRO-API-KEY':cfg.apiKey||''};
  const tron=new TronWeb({fullHost:base,headers});
  const receiver=cfg.receiver;
  const sponsorKey=cfg.gasKey?.replace(/^0x/,'');
  const sponsor=sponsorKey?TronWeb.address.fromPrivateKey(sponsorKey):null;
  async function post(path,body={}) {
    const r=await fetch(base+path,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
      headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(!r.ok)throw Error('TRON_HTTP_'+r.status);
    const j=await r.json();if(j.Error||j.error)throw Error('TRON_NODE_ERROR');return j;
  }
  const account=a=>post('/walletsolidity/getaccount',{address:a,visible:true});
  async function call(token,from,selector,parameter) {
    const v=await post('/wallet/triggerconstantcontract',{owner_address:from,contract_address:token,
      function_selector:selector,parameter,visible:true});
    if(!v.result?.result||!Array.isArray(v.constant_result))throw Error('TRON_SIMULATION_FAILED');
    return v;
  }
  async function balance(token,from) {
    const r=await call(token,from,'balanceOf(address)',padded(from));
    if(!/^[0-9a-fA-F]{64}$/.test(r.constant_result[0]||''))throw Error('TRON_BALANCE_INVALID');
    return BigInt('0x'+r.constant_result[0]);
  }
  async function prices() {
    const j=await post('/wallet/getchainparameters');
    const values=Object.fromEntries((j.chainParameter||[]).map(v=>[v.key,v.value]));
    const get=k=>{if(!Number.isSafeInteger(values[k])||values[k]<0)throw Error('TRON_FEE_UNAVAILABLE');return BigInt(values[k]);};
    const bandwidth=get('getTransactionFee'),energy=get('getEnergyFee');
    if(!energy || !bandwidth)throw Error('TRON_ZERO_RESOURCE_PRICE');
    return {energy,bandwidth,creation:get('getCreateNewAccountFeeInSystemContract'),creationBandwidth:get('getCreateAccountFee')};
  }
  const verifyNetwork=async()=>{if(!TronWeb.isAddress(receiver))throw Error('TRON_RECIPIENT_REQUIRED');};
  return {
    receiver,same,verifyNetwork,
    async plan(job,funded) {
      await verifyNetwork();
      const from=job.address;
      if(same(from,receiver)||(sponsor&&same(from,sponsor)))return {skip:'treasury_or_sponsor'};
      const a=await account(from);
      const coins=BigInt(integer(a.balance||0));
      if(!job.token && coins<=cfg.minNative)return {skip:'below_minimum'};
      const amount=job.token?await balance(job.token,from):coins;
      if(job.token && amount<job.minimum)return {skip:'below_minimum'};
      const [rates, dest]=await Promise.all([prices(),account(receiver)]);
      if (!job.token) {
        for(const t of cfg.tokens)if(await balance(t.address,from)>=t.minimum)return {skip:'reserved_for_tokens'};
        const fee=400n*rates.bandwidth+(dest.address?0n:rates.creation+rates.creationBandwidth);
        const net=coins-fee;
        if(net<cfg.minNative||net<=0n)return {skip:'net_below_minimum'};
        return {kind:'collect',from,to:receiver,amount:net,fee};
      }
      // The account endpoint omits inactive accounts even when USDT balanceOf is positive.
      let energyLimit=cfg.maxFee-500n*rates.bandwidth;
      if(energyLimit<=0n)return {skip:'fee_cap'};
      let simulation;
      try {
        simulation=await call(job.token,from,'transfer(address,uint256)',padded(receiver)+amount.toString(16).padStart(64,'0'));
      } catch(e) {
        if(a.address || e.message!=='TRON_SIMULATION_FAILED')throw e;
        if(!cfg.activationEnergy)return {skip:'inactive_needs_energy_estimate'};
      }
      if(simulation){
        const ret=simulation.constant_result[0];
        if(!(ret===''||(/^0{63}1$/.test(ret||'')))||!Number.isSafeInteger(simulation.energy_used)||simulation.energy_used<=0)
          return {skip:'simulation_rejected'};
        energyLimit=(BigInt(simulation.energy_used)*rates.energy*120n+99n)/100n;
      } else energyLimit=cfg.activationEnergy*rates.energy;
      const fee=energyLimit+500n*rates.bandwidth;
      if(fee>cfg.maxFee)return {skip:'fee_cap'};
      if(a.address&&coins>=fee)return {kind:'collect',from,to:receiver,amount,fee,energyLimit};
      if(funded)return {hold:'funded_wallet_still_short'};
      if(!sponsor)return {skip:'needs_trx_sponsor'};
      const shortfall=fee>coins?fee-coins:1n;
      const fundingFee=400n*rates.bandwidth+(a.address?0n:rates.creation+rates.creationBandwidth);
      if(fundingFee+fee>cfg.maxFee)return {skip:'funding_plus_collection_exceeds_cap'};
      if(BigInt(integer((await account(sponsor)).balance||0))<shortfall+fundingFee)return {skip:'gas_sponsor_balance'};
      return {kind:'fund',from:sponsor,to:from,amount:shortfall,fee:fundingFee,projectedFee:fee};
    },
    async sign(p,key,job) {
      const privateKey=p.kind==='fund'?sponsorKey:key.replace(/^0x/,'');
      if(!same(TronWeb.address.fromPrivateKey(privateKey),p.from))throw Error('SIGNER_ADDRESS_MISMATCH');
      let tx;
      if(p.kind==='collect'&&job.token) {
        const result=await tron.transactionBuilder.triggerSmartContract(job.token,'transfer(address,uint256)',
          {feeLimit:integer(p.energyLimit),callValue:0},[{type:'address',value:p.to},{type:'uint256',value:p.amount.toString()}],p.from);
        if(!result.result?.result)throw Error('TRON_CONSTRUCTION_FAILED');tx=result.transaction;
      } else tx=await tron.transactionBuilder.sendTrx(p.to,integer(p.amount),p.from);
      checkTronIntent(tx,{...p,token:job.token});
      const maxSize=p.kind==='collect'&&job.token?500:400;
      if(tx.raw_data_hex.length/2+100>maxSize || tx.raw_data.expiration<=Date.now()+10000)throw Error('TRON_REQUOTE');
      const signed=await tron.trx.sign(tx,privateKey);
      return {hash:signed.txID,raw:signed};
    },
    async inspect(p) {
      const [receipt,body]=await Promise.all(['/walletsolidity/gettransactioninfobyid','/walletsolidity/gettransactionbyid']
        .map(path=>post(path,{value:p.hash})));
      if(receipt.id===p.hash && body.txID===p.hash) {
        if(body.ret?.[0]?.contractRet!=='SUCCESS'||receipt.result==='FAILED')return 'failed';
        if(p.kind==='collect'&&p.token){
          if(receipt.receipt?.result!=='SUCCESS')return 'failed';
          const logs=(receipt.log||[]).map(l=>({address:'0x'+l.address,topics:l.topics.map(t=>'0x'+t),data:'0x'+l.data}));
          if(!matchingTransfer(logs,hex20(p.token),hex20(p.from),hex20(p.to),p.amount))return 'review';
        }
        return 'confirmed';
      }
      const observed=await post('/wallet/gettransactionbyid',{value:p.hash});
      if(observed.txID===p.hash)return Date.now()-p.created>30*60*1000?'review':'pending';
      return p.raw.raw_data.expiration<=Date.now()?'review':'broadcast';
    },
    async broadcast(p) {
      checkTronIntent(p.raw,p);
      if(p.raw.txID!==p.hash)throw Error('JOURNAL_HASH_MISMATCH');
      const r=await tron.trx.sendRawTransaction(p.raw);
      if(!r.result&&r.code!=='DUP_TRANSACTION_ERROR')throw Error('TRON_BROADCAST_UNCONFIRMED');
    }
  };
}
module.exports={tronAdapter,checkTronIntent};
