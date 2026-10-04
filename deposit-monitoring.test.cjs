const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(__dirname + '/server.js', 'utf8');
const ADDRESS = '0x' + 'a'.repeat(40);
const USER = '00000000-0000-4000-8000-000000000001';
const NETWORK = 'usdt_bep20';
const BASE = Date.parse('2026-10-04T17:00:00Z');
const flush = () => new Promise(resolve => setImmediate(resolve));

async function fixture() {
  let now = BASE;
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const routes = new Map(), rpcCalls = [], timers = [];
  const wallet = { user_id: USER, usdt_bep20_address: ADDRESS, usdc_bep20_address: ADDRESS, usdt_erc20_address: ADDRESS, usdc_erc20_address: ADDRESS, usdt_trc20_address: 'test-only' };
  const client = {
    rpc: async (name, args) => { rpcCalls.push({ name, args }); return { data: [], error: null }; },
    from: () => { const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: wallet, error: null }), insert: async () => ({ error: null }) }; return q; }
  };
  const app = { set() {}, use() {}, get(path,...fns) { routes.set('GET ' + path, fns); }, post(path,...fns) { routes.set('POST ' + path, fns); }, listen() { return { close() {} }; } };
  const express = () => app; express.json = () => (req,res,next) => next();
  const context = vm.createContext({ URL, Date: Clock, Map, Set, Buffer, Promise, AbortController, Intl,
    process: { env: { SUPABASE_URL: 'https://fctwivbwjoslkejtjxhe.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-only', ENCRYPTION_KEY: 'x'.repeat(32), API_SECRET_KEY: 'y'.repeat(32) }, on() {}, hrtime: process.hrtime, uptime: () => 1, exit() { throw Error('Unexpected exit'); } },
    console: { log() {}, warn() {}, error() {} }, setInterval() {}, setTimeout(fn,ms) { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {},
    require(name) { if (name === 'express') return express; if (name === '@supabase/supabase-js') return { createClient: () => client }; if (name === 'ethers') return { formatUnits: (value, decimals) => String(Number(value) / 10 ** decimals) }; if (name === 'ws') return function() {}; return require(name); }
  });
  vm.runInContext(source + '\nthis.hooks={registerActiveDepositWatch,pollDepositWatches,nextScheduledWatchCheck,startOrReuseDepositCheckJob,checkUserEVMLiveDeposits,drainDepositHistoryRecovery,publicDepositCheckJob,recordDepositWatchDetection,publicDepositWatchState,activeDepositWatches,depositCheckJobs,evmLiveScanCursors,depositHistoryRecoveries};', context);
  await flush();
  return { context, hooks: context.hooks, routes, rpcCalls, timers, at(seconds) { now = BASE + seconds * 1000; }, deadline: new Date(BASE + 600000).toISOString() };
}

test('ten-minute watch starts exactly six jobs at 60,150,240,330,420,510 seconds', async () => {
  const f = await fixture(), starts = [];
  f.context.fakeCheck = async () => { starts.push(f.context.Date.now() - BASE); return { success: true, deposits: 0 }; };
  vm.runInContext('checkUserRequestedNetworks=fakeCheck', f.context);
  f.hooks.registerActiveDepositWatch(USER, NETWORK, f.deadline, true);
  for (let seconds = 0; seconds <= 700; seconds += 5) { f.at(seconds); await f.hooks.pollDepositWatches(); await flush(); }
  assert.deepEqual(starts, [60000,150000,240000,330000,420000,510000]);
  assert.equal(f.hooks.activeDepositWatches.size, 0);
});

test('repeated authenticated check requests before the first minute do not start a scan', async () => {
  const f = await fixture(); let starts = 0;
  f.context.fakeCheck = async () => { starts++; return { success: true, deposits: 0 }; };
  vm.runInContext('checkUserRequestedNetworks=fakeCheck', f.context);
  f.hooks.registerActiveDepositWatch(USER, NETWORK, f.deadline, true);
  const handler = f.routes.get('POST /public/deposit/check').at(-1);
  for (const seconds of [0,10,20,59]) {
    f.at(seconds); let body;
    const res = { status() { return this; }, json(value) { body=value; return this; } };
    await handler({ body:{ network:NETWORK, async:true }, pixelUser:{id:USER}, pixelState:{config:{deposits_enabled:true}}, ip:'test' }, res);
    assert.equal(body.job_status,'waiting'); assert.equal(Date.parse(body.next_check_at),BASE+60000);
  }
  assert.equal(starts,0);
});

test('a credited deposit stops further scheduled jobs and clears history work', async () => {
  const f = await fixture(); let starts=0;
  f.context.fakeCheck = async () => ({ success:true, deposits:++starts === 2 ? 1 : 0 });
  vm.runInContext('checkUserRequestedNetworks=fakeCheck', f.context);
  f.hooks.registerActiveDepositWatch(USER,NETWORK,f.deadline,true);
  for(let seconds=0;seconds<=700;seconds+=5){ f.at(seconds); await f.hooks.pollDepositWatches(); await flush(); }
  assert.equal(starts,2); assert.equal(f.hooks.activeDepositWatches.size,0);
  assert.equal(f.rpcCalls.filter(x=>x.name==='nftalt_stop_deposit_watch').length,1);
});

test('head checks use a short confirmed range and overlap without crediting duplicates', async () => {
  const f=await fixture(), scans=[], credits=[], seen=new Set(); let latest=10003;
  const transfer={amount:30,transaction_id:'0x'+'1'.repeat(64),network:NETWORK,to:ADDRESS,confirmed:true,event_index:2,token:'USDT'};
  f.context.fakeRPC=async()=>latest;
  f.context.fakeScan=async(chain,addresses,mode,options)=>{scans.push({...options});return {transactions:[transfer]};};
  f.context.fakeCredit=async(...args)=>{credits.push(args);const duplicate=seen.has(args[2]);seen.add(args[2]);return {success:true,already_processed:duplicate};};
  vm.runInContext('alchemyRpc=fakeRPC;scanAlchemyLogTransfers=fakeScan;processDeposit=fakeCredit;sweepDepositBEP20=async()=>{}',f.context);
  f.hooks.registerActiveDepositWatch(USER,NETWORK,f.deadline,true);
  const first=await f.hooks.checkUserEVMLiveDeposits(USER,'bsc',{network:NETWORK});
  latest+=60;
  const second=await f.hooks.checkUserEVMLiveDeposits(USER,'bsc',{network:NETWORK});
  assert.equal(scans[0].fromBlock,9881);assert.equal(scans[0].toBlock,10000);
  assert.equal(scans[1].fromBlock,9981);assert.equal(scans[1].toBlock,10060);
  assert.equal(first.deposits,1);assert.equal(second.deposits,0);assert.equal(second.duplicates,1);
  assert.equal(credits[0][5],1);assert.equal(credits[0][6],2);
});

test('processing failure keeps the same head cursor for a safe retry', async () => {
  const f=await fixture(),scans=[];
  f.context.fakeRPC=async()=>10003;
  f.context.fakeScan=async(c,a,m,o)=>{scans.push(o);return {transactions:[{amount:30,transaction_id:'test',network:NETWORK,to:ADDRESS,confirmed:true,event_index:0,token:'USDT'}]};};
  f.context.fakeCredit=async()=>({success:false,error:'DB unavailable'});
  vm.runInContext('alchemyRpc=fakeRPC;scanAlchemyLogTransfers=fakeScan;processDeposit=fakeCredit',f.context);
  const result=await f.hooks.checkUserEVMLiveDeposits(USER,'bsc',{network:NETWORK});
  assert.equal(result.success,false);assert.equal(f.hooks.evmLiveScanCursors.size,0);
  f.context.fakeCredit=async()=>({success:true});vm.runInContext('processDeposit=fakeCredit;sweepDepositBEP20=async()=>{}',f.context);
  await f.hooks.checkUserEVMLiveDeposits(USER,'bsc',{network:NETWORK});
  assert.equal(scans[1].fromBlock,scans[0].fromBlock);
});

test('a slow history slice does not prevent a newer transfer being credited', async () => {
  const f=await fixture();let latest=10003,release,oldStarted=false;
  f.context.fakeRPC=async()=>latest;
  f.context.fakeScan=async(c,a,m,o)=>{
    if(o.concurrency===1){oldStarted=true;return new Promise(resolve=>{release=()=>resolve({transactions:[]});});}
    return {transactions:latest>10003?[{amount:30,transaction_id:'new-transfer',network:NETWORK,to:ADDRESS,confirmed:true,event_index:0,token:'USDT'}]:[]};
  };
  f.context.fakeCredit=async()=>({success:true});
  vm.runInContext('alchemyRpc=fakeRPC;scanAlchemyLogTransfers=fakeScan;processDeposit=fakeCredit;sweepDepositBEP20=async()=>{}',f.context);
  f.hooks.registerActiveDepositWatch(USER,NETWORK,f.deadline,true);
  await f.hooks.checkUserEVMLiveDeposits(USER,'bsc',{network:NETWORK});
  const history=f.hooks.drainDepositHistoryRecovery();await flush();assert.equal(oldStarted,true);
  latest+=100;f.at(150);
  const {job}=f.hooks.startOrReuseDepositCheckJob(USER,NETWORK);await flush();
  assert.equal(job.status,'completed');assert.equal(job.found,true);
  assert.equal(f.hooks.activeDepositWatches.size,0);
  release();await history;
});

test('same-network jobs are reused; switching networks never returns another network job', async () => {
  const f=await fixture();let release;
  f.context.fakeCheck=()=>new Promise(resolve=>{release=()=>resolve({success:true,deposits:0});});
  vm.runInContext('checkUserRequestedNetworks=fakeCheck',f.context);
  const first=f.hooks.startOrReuseDepositCheckJob(USER,NETWORK);
  assert.equal(f.hooks.startOrReuseDepositCheckJob(USER,NETWORK).job.id,first.job.id);
  const second=f.hooks.startOrReuseDepositCheckJob(USER,'usdt_trc20');
  assert.notEqual(first.job.id,second.job.id);assert.equal(second.job.network,'usdt_trc20');
  release();await flush();
});

test('provider adapter still uses at most ten blocks per RPC and excludes unconfirmed blocks', async () => {
  const f=await fixture(),ranges=[];
  f.context.fakeRPC=async(c,method,params)=>{if(method==='eth_blockNumber')return '0x2713';if(method==='eth_getLogs'){ranges.push(params[0]);return [];}throw Error('Unexpected RPC');};
  vm.runInContext('alchemyRpc=fakeRPC;sleep=async()=>{}',f.context);
  await f.hooks.checkUserEVMLiveDeposits(USER,'bsc',{network:NETWORK});
  assert.equal(ranges.length,12);
  for(const r of ranges){assert.ok(Number(BigInt(r.toBlock))-Number(BigInt(r.fromBlock))+1<=10);assert.ok(Number(BigInt(r.toBlock))<=10000);}
});

test('watch status is read-only before the first minute and detects credit from another scanner',async()=>{
  const f=await fixture();f.hooks.registerActiveDepositWatch(USER,NETWORK,f.deadline,true);
  const status=f.routes.get('POST /public/deposit/check/status').at(-1);
  let body;const res={status(){return this;},set(){return this;},json(value){body=value;return this;}};
  for(let i=0;i<5;i++)await status({body:{network:NETWORK},pixelUser:{id:USER}},res);
  assert.equal(body.job_status,'waiting');assert.equal(f.hooks.depositCheckJobs.size,0);
  await f.hooks.recordDepositWatchDetection(USER,NETWORK);
  await status({body:{network:NETWORK},pixelUser:{id:USER}},res);
  assert.equal(body.found,true);assert.equal(body.job_status,'completed');
  // A stale durable lease must not reopen a successfully stopped watch.
  f.hooks.registerActiveDepositWatch(USER,NETWORK,f.deadline);
  assert.equal(f.hooks.activeDepositWatches.size,0);
});
