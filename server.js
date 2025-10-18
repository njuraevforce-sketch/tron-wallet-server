'use strict';
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const TronWeb = require('tronweb');
let fetchFn = global.fetch;
if (!fetchFn) {
  try { fetchFn = require('node-fetch'); } catch(e) { /* node >=18 ok */ }
}

const app = express();
const PORT = process.env.PORT || 3000;

/* --------------------------
   CONFIG (via environment)
   -------------------------- */
const SUPABASE_URL = process.env.SUPABASE_URL || null;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || null;
const TRONGRID_API_KEY = process.env.TRONGRID_API_KEY || null;

const MASTER_ADDRESS = process.env.MASTER_ADDRESS || null;          // optional
const MASTER_PRIVATE_KEY = process.env.MASTER_PRIVATE_KEY || null;  // optional
const MAIN_ADDRESS = process.env.MAIN_ADDRESS || null;              // required for collect

// Short config check — server will NOT crash if envs missing, but endpoints will explain.
const CONFIG = {
  hasSupabase: !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY),
  hasTronGrid: !!TRONGRID_API_KEY,
  hasMain: !!MAIN_ADDRESS,
  hasMaster: !!MASTER_PRIVATE_KEY
};

/* --------------------------
   Clients
   -------------------------- */
const supabase = CONFIG.hasSupabase ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) : null;

const tronWeb = new TronWeb({
  fullHost: 'https://api.trongrid.io',
  headers: { 'TRON-PRO-API-KEY': TRONGRID_API_KEY || '' }
});

/* --------------------------
   Constants
   -------------------------- */
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const MIN_DEPOSIT = 30;
const KEEP_AMOUNT = 1.0;
const MIN_TRX_FOR_FEE = 3;
const FUND_TRX_AMOUNT = 6;
const TRX_POLL_MS = 3000;
const TRX_POLL_RETRIES = Number(process.env.TRX_POLL_RETRIES) || 4; // short by default

/* --------------------------
   Helpers
   -------------------------- */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normalizePkNo0x(pk) {
  if (!pk) return null;
  let s = String(pk).trim();
  if (s.startsWith('0x')) s = s.slice(2);
  if (s.length !== 64) return null;
  return s;
}

function sunToAmount(sun) {
  const n = Number(sun);
  if (!Number.isFinite(n)) return 0;
  return n / 1_000_000;
}
function amountToSun(amount) {
  return Math.floor(Number(amount) * 1_000_000);
}

function toBase58IfHex(addr) {
  if (!addr) return addr;
  if (/^0x41[0-9a-fA-F]{40}$/.test(addr)) {
    try { return tronWeb.address.fromHex(addr.replace(/^0x/, '')); } catch(e) { return addr; }
  }
  if (/^41[0-9a-fA-F]{40}$/.test(addr)) {
    try { return tronWeb.address.fromHex(addr); } catch(e) { return addr; }
  }
  return addr;
}

/* Try to build a TronWeb instance from a private key.
   Accepts pk with or without 0x — tries both if necessary.
   Returns { tronInstance, usedPrivateKey } or throws.
*/
async function getTronFromPrivateKeyFlexible(pkRaw) {
  if (!pkRaw) throw new Error('No private key');
  const candidates = [];
  const pkNo0x = pkRaw.startsWith('0x') ? pkRaw.slice(2) : pkRaw;
  candidates.push(pkNo0x);
  candidates.push('0x' + pkNo0x);

  for (const cand of candidates) {
    try {
      const t = new TronWeb({
        fullHost: 'https://api.trongrid.io',
        headers: { 'TRON-PRO-API-KEY': TRONGRID_API_KEY || '' },
        privateKey: cand
      });
      // quick sanity: try to compute address
      const addr = t.address.fromPrivateKey(cand);
      if (addr) return { tron: t, pk: cand };
    } catch (e) {
      // try next
    }
  }
  throw new Error('Private key not accepted by TronWeb (tried with/without 0x)');
}

/* Wait for trx balance to reach threshold (short polling) */
async function waitForTrxBalance(address, threshold = MIN_TRX_FOR_FEE, retries = TRX_POLL_RETRIES) {
  for (let i=0;i<retries;i++) {
    try {
      const b = await tronWeb.trx.getBalance(address);
      const trx = (Number(b) || 0) / 1e6;
      if (trx >= threshold) return true;
    } catch(e) { /* ignore */ }
    await sleep(TRX_POLL_MS);
  }
  return false;
}

/* --------------------------
   Tron actions (robust)
   -------------------------- */
async function getUSDTBalance(address) {
  try {
    const contract = await tronWeb.contract().at(USDT_CONTRACT);
    const bal = await contract.balanceOf(address).call();
    return sunToAmount(bal);
  } catch (e) {
    console.warn('getUSDTBalance err', e?.message || e);
    return 0;
  }
}

async function getTRXBalance(address) {
  try {
    const b = await tronWeb.trx.getBalance(address);
    return (Number(b) || 0) / 1e6;
  } catch (e) {
    console.warn('getTRXBalance err', e?.message || e);
    return 0;
  }
}

async function sendTRXFlexible(fromPrivateKeyRaw, toAddress, amount) {
  try {
    const { tron, pk } = await getTronFromPrivateKeyFlexible(fromPrivateKeyRaw);
    const fromAddr = tron.address.fromPrivateKey(pk);
    const tx = await tron.transactionBuilder.sendTrx(toAddress, tron.toSun(amount), fromAddr);
    const signed = await tron.trx.sign(tx);
    const res = await tron.trx.sendRawTransaction(signed);
    // attempt get txid
    const txid = res?.txid || tx?.txID || tx?.txid || null;
    if (txid) {
      // short confirmation loop (best-effort)
      for (let i=0;i<6;i++) {
        try {
          const info = await tron.trx.getTransactionInfo(txid);
          if (info && (info.receipt && (info.receipt.result === 'SUCCESS' || info.receipt.result === true))) return txid;
        } catch(e){}
        await sleep(2000);
      }
      return txid; // maybe still fine
    }
    // fallback to res.result
    return (res && (res.result === true || res.result === 'SUCCESS')) ? (res.txid || true) : false;
  } catch (e) {
    console.warn('sendTRXFlexible error', e?.message || e);
    return false;
  }
}

async function transferUSDTFlexible(fromPrivateKeyRaw, toAddress, amount) {
  try {
    const { tron, pk } = await getTronFromPrivateKeyFlexible(fromPrivateKeyRaw);
    const contract = await tron.contract().at(USDT_CONTRACT);
    const amountSun = amountToSun(amount);
    const res = await contract.transfer(toAddress, amountSun).send();
    // try to extract txid
    if (typeof res === 'string' && res.length>0) return res;
    if (res && res.txid) return res.txid;
    if (res && (res.result === true || res.result === 'SUCCESS')) return true;
    return false;
  } catch (e) {
    console.warn('transferUSDTFlexible error', e?.message || e);
    return false;
  }
}

/* --------------------------
   Transactions parser
   -------------------------- */
async function getUSDTTransactions(address) {
  try {
    if (!address) return [];
    const url = `https://api.trongrid.io/v1/accounts/${address}/transactions/trc20?limit=30&only_confirmed=true`;
    const resp = await (fetchFn ? fetchFn(url, { headers: { 'TRON-PRO-API-KEY': TRONGRID_API_KEY || '', Accept: 'application/json' } }) : Promise.reject(new Error('fetch unavailable')));
    if (!resp.ok) {
      const text = await resp.text().catch(()=>'');
      console.warn('trongrid status', resp.status, text);
      return [];
    }
    const json = await resp.json();
    const raw = json.data || [];
    const out = [];
    for (const item of raw) {
      try {
        const tokenAddr = item.token_info?.address || item.contract || item.tokenInfo?.address;
        if (!tokenAddr || tokenAddr !== USDT_CONTRACT) continue;
        const to = toBase58IfHex(item.to || item.to_address);
        const from = toBase58IfHex(item.from || item.from_address);
        const rawValue = item.value ?? item.amount ?? item.amount_str ?? 0;
        const value = sunToAmount(rawValue);
        out.push({ transaction_id: item.transaction_id || item.txid || item.hash, to, from, value, raw: item });
      } catch(e) { continue; }
    }
    return out;
  } catch (e) {
    console.warn('getUSDTTransactions error', e?.message || e);
    return [];
  }
}

/* --------------------------
   DB / business logic
   -------------------------- */
async function ensureUserExists(userId) {
  if (!CONFIG.hasSupabase) return;
  if (!userId) return;
  try {
    const { data } = await supabase.from('users').select('id').eq('id', userId).maybeSingle();
    if (!data) {
      await supabase.from('users').insert({
        id: userId,
        email: `user-${userId}@temp.com`,
        username: `user-${String(userId).slice(0,8)}`,
        referral_code: `REF-${String(userId).slice(0,8)}`,
        balance: 0.0,
        total_profit: 0.0,
        vip_level: 0,
        created_at: new Date().toISOString()
      });
      console.log('Created placeholder user', userId);
    }
  } catch (e) {
    console.warn('ensureUserExists error', e?.message || e);
  }
}

async function processDeposit(wallet, amount, txid) {
  try {
    console.log('processDeposit', wallet.address, amount, txid);
    if (!CONFIG.hasSupabase) {
      console.warn('Supabase not configured — skipping DB writes (but will attempt auto-collect).');
    }

    // duplicate check (if supabase present)
    if (CONFIG.hasSupabase) {
      const { data: existing } = await supabase.from('deposits').select('id').eq('txid', txid).maybeSingle();
      if (existing && existing.id) { console.log('Deposit already exists', txid); return; }
    }

    await ensureUserExists(wallet.user_id);

    if (CONFIG.hasSupabase) {
      const { data: user } = await supabase.from('users').select('balance, total_profit, vip_level').eq('id', wallet.user_id).maybeSingle();
      const current = Number(user?.balance || 0);
      const newBal = current + Number(amount);
      const newTotal = Number(user?.total_profit || 0) + Number(amount);

      const { error: upd } = await supabase.from('users').update({ balance: newBal, total_profit: newTotal, updated_at: new Date().toISOString() }).eq('id', wallet.user_id);
      if (upd) console.warn('User update warning', upd);
      const { error: di } = await supabase.from('deposits').insert({ user_id: wallet.user_id, amount, txid, status:'confirmed', created_at: new Date().toISOString() });
      if (di) console.warn('Deposit insert warning', di);
      await supabase.from('transactions').insert({ user_id: wallet.user_id, type:'deposit', amount, description:'deposit TRC20', status:'completed', created_at: new Date().toISOString() });
      if (newBal >= 30 && Number(user?.vip_level || 0) === 0) {
        await supabase.from('users').update({ vip_level: 1 }).eq('id', wallet.user_id);
      }
    }

    // run auto-collect (tolerant)
    const collectRes = await autoCollectToMainWallet(wallet);
    console.log('collectRes', collectRes);
  } catch (e) {
    console.warn('processDeposit error', e?.message || e);
  }
}

async function autoCollectToMainWallet(wallet) {
  try {
    if (!MAIN_ADDRESS) return { success: false, reason: 'no_main_address' };
    if (!wallet || !wallet.address) return { success: false, reason: 'no_wallet' };

    const usdt = await getUSDTBalance(wallet.address);
    if (!usdt || usdt <= KEEP_AMOUNT) return { success: false, reason: 'low_usdt', usdt };

    const amountToTransfer = Math.floor((usdt - KEEP_AMOUNT) * 1e6) / 1e6;
    if (amountToTransfer <= 0) return { success: false, reason: 'nothing' };

    let trx = await getTRXBalance(wallet.address);

    if (trx < MIN_TRX_FOR_FEE) {
      if (MASTER_PRIVATE_KEY) {
        console.log('Low TRX — funding from MASTER to', wallet.address);
        const fundRes = await sendTRXFlexible(MASTER_PRIVATE_KEY, wallet.address, FUND_TRX_AMOUNT);
        if (!fundRes) return { success: false, reason: 'fund_failed' };
        const ok = await waitForTrxBalance(wallet.address, MIN_TRX_FOR_FEE);
        if (!ok) return { success: false, reason: 'no_trx_after_fund' };
        trx = await getTRXBalance(wallet.address);
      } else {
        console.warn('No MASTER key — cannot fund TRX; if wallet has insufficient TRX, skip collect');
        if (trx < MIN_TRX_FOR_FEE) return { success: false, reason: 'low_trx_no_master', trx };
      }
    }

    if (!wallet.private_key) return { success: false, reason: 'no_user_pk' };

    const tx = await transferUSDTFlexible(wallet.private_key, MAIN_ADDRESS, amountToTransfer);
    if (!tx) return { success: false, reason: 'usdt_transfer_failed' };

    if (CONFIG.hasSupabase) {
      await supabase.from('transactions').insert({ user_id: wallet.user_id, type: 'collect', amount: amountToTransfer, description:`auto-collected to ${MAIN_ADDRESS}`, status:'completed', created_at: new Date().toISOString() });
    }
    return { success: true, amount: amountToTransfer, tx };
  } catch (e) {
    console.warn('autoCollect error', e?.message || e);
    return { success: false, reason: 'error', error: e?.message || String(e) };
  }
}

/* --------------------------
   Endpoints
   -------------------------- */

app.use(express.json());

app.get('/', (req,res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    config: { hasSupabase: CONFIG.hasSupabase, hasMain: CONFIG.hasMain, hasMaster: CONFIG.hasMaster }
  });
});

// Generate wallet endpoint — stores in DB if Supabase configured
app.post('/generate-wallet', async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ success:false, error:'user_id required' });

    // generate new account locally
    const account = TronWeb.utils.accounts.generateAccount();
    const pkNo0x = normalizePkNo0x(account.privateKey) || account.privateKey;
    const record = { user_id, address: account.address.base58, private_key: pkNo0x, created_at: new Date().toISOString() };

    if (CONFIG.hasSupabase) {
      const { data, error } = await supabase.from('user_wallets').insert(record).select().maybeSingle();
      if (error) {
        // if failed, return wallet details but warn
        console.warn('DB wallet insert failed', error);
        return res.json({ success:true, address: account.address.base58, warning: 'db_insert_failed' });
      }
      return res.json({ success:true, address: data.address });
    } else {
      // no DB configured — return wallet to caller (they must store it)
      return res.json({ success:true, address: account.address.base58, private_key: pkNo0x, warning:'no_db_configured_store_key_securely' });
    }
  } catch (e) {
    console.warn('generate-wallet error', e?.message || e);
    return res.status(500).json({ success:false, error: String(e) });
  }
});

// Check deposits (scans wallets)
app.get('/check-deposits', async (req,res) => {
  try {
    if (!CONFIG.hasSupabase) return res.status(400).json({ success:false, error:'Supabase not configured' });

    const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const { data: wallets, error } = await supabase.from('user_wallets').select('*').or(`last_checked.is.null,last_checked.lt.${twoMinAgo}`).limit(500);
    if (error) throw error;

    let processed = 0, found = 0;
    for (const w of wallets || []) {
      try {
        const txs = await getUSDTTransactions(w.address);
        const inbound = txs.filter(t => t.to === w.address && t.value >= MIN_DEPOSIT);
        for (const tx of inbound) {
          const { data: existing } = await supabase.from('deposits').select('id').eq('txid', tx.transaction_id).maybeSingle();
          if (existing && existing.id) continue;
          found++;
          await processDeposit(w, tx.value, tx.transaction_id);
        }
        await supabase.from('user_wallets').update({ last_checked: new Date().toISOString() }).eq('id', w.id);
        processed++;
      } catch(e) { console.warn('wallet check error', w?.address, e?.message || e); }
    }
    return res.json({ success:true, message: `checked ${processed}, new ${found}` });
  } catch (e) {
    console.error('check-deposits fatal', e?.message || e);
    return res.status(500).json({ success:false, error: String(e) });
  }
});

// Manual collect
app.get('/collect-funds', async (req,res) => {
  try {
    if (!CONFIG.hasSupabase) return res.status(400).json({ success:false, error:'Supabase not configured' });
    const { data: wallets, error } = await supabase.from('user_wallets').select('*').limit(200);
    if (error) throw error;
    let c=0,total=0;
    for (const w of wallets || []) {
      const r = await autoCollectToMainWallet(w);
      if (r && r.success) { c++; total += Number(r.amount || 0); await sleep(1000); }
    }
    return res.json({ success:true, message:`collected ${total} from ${c}` });
  } catch (e) {
    console.warn('collect-funds error', e?.message || e);
    return res.status(500).json({ success:false, error: String(e) });
  }
});

/* --------------------------
   Auto-check interval (call internal function)
   -------------------------- */
const AUTO_CHECK_MS = Number(process.env.AUTO_CHECK_MS) || 60_000; // default 60s
setInterval(async () => {
  try {
    if (!CONFIG.hasSupabase) return;
    console.log('AUTO-CHECK triggered');
    await (async () => {
      // call internal function rather than fetch
      await (await fetchFn(`http://localhost:${PORT}/check-deposits`)).json().catch(()=>{});
    })();
  } catch (e) {
    console.warn('auto-check err', e?.message || e);
  }
}, AUTO_CHECK_MS);

/* --------------------------
   Start
   -------------------------- */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on ${PORT}`);
  console.log('CONFIG', CONFIG);
  console.log('MAIN_ADDRESS set?', !!MAIN_ADDRESS);
  console.log('MASTER set?', !!MASTER_PRIVATE_KEY);
  console.log('Auto-check every', AUTO_CHECK_MS, 'ms');
});
