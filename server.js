// server.js — ФИНАЛЬНАЯ ВЕРСИЯ С АДРЕСАМИ В КОДЕ И КЛЮЧАМИ В ПЕРЕМЕННЫХ
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const TronWeb = require('tronweb');

const app = express();
const PORT = process.env.PORT || 3000;

// ========== ENVIRONMENT VARIABLES ==========
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://bpsmizhrzgfbjqfpqkcz.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOi...'; // replace in env
const TRONGRID_API_KEY = process.env.TRONGRID_API_KEY || '19e2411a-3c3e-479d-8c85-2abc716af397';

// COMPANY wallets - АДРЕСА В КОДЕ, КЛЮЧИ В ПЕРЕМЕННЫХ
const COMPANY = {
  MASTER: {
    address: 'TKn5J3ZnTxE9fmgMhVjXognH4VUjx4Tid2',
    privateKey: process.env.MASTER_PRIVATE_KEY
  },
  MAIN: {
    address: 'TNVpDk1JZSxmC9XniB1tSPaRdAvvKMMavC',
    privateKey: process.env.MAIN_PRIVATE_KEY
  }
};

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const tronWeb = new TronWeb({
  fullHost: 'https://api.trongrid.io',
  headers: { 'TRON-PRO-API-KEY': TRONGRID_API_KEY }
});

app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Allow-Methods', '*');
  next();
});

// ========== CONSTANTS ==========
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const MIN_DEPOSIT = 30;
const KEEP_AMOUNT = 1.0;
const MIN_TRX_FOR_FEE = 3;
const FUND_TRX_AMOUNT = 10;

// Throttling / concurrency
const BALANCE_CONCURRENCY = Number(process.env.BALANCE_CONCURRENCY || 2);
const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS || 3 * 60 * 1000); // default 3 minutes

// ========== HELPERS ==========
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function strip0x(s) {
  if (!s) return s;
  return s.startsWith('0x') ? s.slice(2) : s;
}

function padTo32Bytes(hexWithoutPrefix) {
  return hexWithoutPrefix.padStart(64, '0');
}

function normalizePrivateKeyForTron(pk) {
  if (!pk) return null;
  // TronWeb expects privateKey as hex string without '0x'
  return pk.startsWith('0x') ? pk.slice(2) : pk;
}

function toBase58IfHex(addr) {
  if (!addr) return addr;
  if (addr.startsWith('41') && addr.length === 42) {
    try {
      return tronWeb.address.fromHex(addr);
    } catch (e) {
      return addr;
    }
  }
  if (addr.startsWith('T') && addr.length === 34) return addr;
  return addr;
}

// Simple queue for throttling balance calls
let currentBalanceRequests = 0;
const pendingBalanceQueue = [];
function enqueueBalanceJob(fn) {
  return new Promise((resolve, reject) => {
    pendingBalanceQueue.push({ fn, resolve, reject });
    runBalanceQueue();
  });
}
function runBalanceQueue() {
  while (currentBalanceRequests < BALANCE_CONCURRENCY && pendingBalanceQueue.length) {
    const job = pendingBalanceQueue.shift();
    currentBalanceRequests++;
    job.fn()
      .then(res => {
        currentBalanceRequests--;
        job.resolve(res);
        setTimeout(runBalanceQueue, 150); // small delay to reduce hitting rate limits
      })
      .catch(err => {
        currentBalanceRequests--;
        job.reject(err);
        setTimeout(runBalanceQueue, 150);
      });
  }
}

// ========== TronGrid request with retry/backoff ==========
async function trongridRequestWithRetry(path, opts = {}, retries = 4, backoffMs = 800) {
  const base = 'https://api.trongrid.io/';
  
  // Ensure headers are properly set
  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'TRON-PRO-API-KEY': TRONGRID_API_KEY,
    ...opts.headers
  };
  
  const options = {
    ...opts,
    headers
  };
  
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(base + path, options);
      if (res.status === 429) {
        const wait = backoffMs * Math.pow(2, attempt);
        console.warn(`TronGrid 429 — wait ${wait}ms (attempt ${attempt + 1}/${retries + 1})`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        const txt = await res.text().catch(() => '<no body>');
        throw new Error(`TronGrid HTTP ${res.status}: ${txt}`);
      }
      return await res.json();
    } catch (e) {
      if (attempt === retries) throw e;
      const wait = backoffMs * Math.pow(2, attempt);
      console.warn(`TronGrid request error (attempt ${attempt + 1}), retrying in ${wait}ms: ${e.message}`);
      await sleep(wait);
    }
  }
  throw new Error('TronGrid retry exhausted');
}

// ========== Robust getUSDTBalance (low-level RPC) ==========
async function getUSDTBalance(address) {
  // Rate-limited via queue
  return enqueueBalanceJob(async () => {
    try {
      if (!address) {
        console.warn('getUSDTBalance: empty address');
        return 0;
      }

      // Ensure address is base58 or convert
      let ownerHex;
      try {
        ownerHex = tronWeb.address.toHex(address);
      } catch (e) {
        console.warn('getUSDTBalance: tronWeb.address.toHex failed for address', address, e && e.message);
        if (typeof address === 'string' && address.startsWith('41')) {
          ownerHex = address;
        } else {
          return 0;
        }
      }

      ownerHex = strip0x(ownerHex);

      // Contract address in hex
      let contractHex;
      try {
        contractHex = tronWeb.address.toHex(USDT_CONTRACT);
      } catch (e) {
        contractHex = USDT_CONTRACT;
      }
      contractHex = strip0x(contractHex);

      // parameter: 32-byte left-padded owner address
      const param = padTo32Bytes(ownerHex);

      const body = {
        contract_address: contractHex,
        owner_address: ownerHex,
        function_selector: 'balanceOf(address)',
        parameter: param,
        call_value: 0
      };

      const json = await trongridRequestWithRetry('wallet/triggerconstantcontract', {
        method: 'POST',
        body: JSON.stringify(body)
      }, 3, 800);

      if (!json) {
        console.warn('getUSDTBalance: empty json', { address });
        return 0;
      }

      if (json.Error || json.error) {
        console.warn('getUSDTBalance: tronGrid returned error', { address, err: json.Error || json.error });
        return 0;
      }

      const constRes = json.constant_result || json.constantResult || json.constantResults;
      if (!constRes || !Array.isArray(constRes) || constRes.length === 0) {
        console.warn('getUSDTBalance: no constant_result in response', { address, json });
        return 0;
      }

      const hexBalance = String(constRes[0] || '0').replace(/^0x/, '');
      const clean = hexBalance.replace(/^0+/, '') || '0';
      let bn;
      try {
        bn = BigInt('0x' + clean);
      } catch (parseErr) {
        console.error('getUSDTBalance: BigInt parse failed', { address, hexBalance, parseErr });
        return 0;
      }

      const amount = Number(bn) / 1_000_000;
      return amount;
    } catch (err) {
      console.error('❌ getUSDTBalance fatal error:', err && err.message ? err.message : err);
      return 0;
    }
  });
}

// ========== getUSDTTransactions ==========
async function getUSDTTransactions(address) {
  try {
    if (!address) return [];
    const path = `v1/accounts/${address}/transactions/trc20?limit=30&only_confirmed=true`;
    const json = await trongridRequestWithRetry(path, {}, 3, 800);

    const raw = json.data || [];
    const transactions = [];

    for (const tx of raw) {
      try {
        const tokenAddr = tx.token_info?.address || tx.contract || tx.tokenInfo?.address;
        if (!tokenAddr) continue;
        if (tokenAddr !== USDT_CONTRACT) continue;

        const to = toBase58IfHex(tx.to || tx.to_address);
        const from = toBase58IfHex(tx.from || tx.from_address);
        const rawValue = tx.value ?? tx.amount ?? tx.quantity ?? 0;
        const amount = Number(rawValue) / 1_000_000;

        transactions.push({
          transaction_id: tx.transaction_id || tx.txid || tx.hash,
          to,
          from,
          amount,
          token: 'USDT',
          confirmed: !!tx.confirmed,
          raw: tx
        });
      } catch (innerErr) {
        console.warn('Skipping malformed tx item', innerErr && innerErr.message ? innerErr.message : innerErr);
        continue;
      }
    }

    return transactions;
  } catch (error) {
    console.error('❌ getUSDTTransactions error:', error && error.message ? error.message : error);
    return [];
  }
}

// ========== DIRECT API METHODS FOR TRX (FIXED) ==========
async function getTRXBalance(address) {
  try {
    const json = await trongridRequestWithRetry(`v1/accounts/${address}`, {}, 3, 800);
    
    if (json && json.data && json.data.length > 0) {
      const balance = json.data[0].balance || 0;
      return balance / 1_000_000;
    }
    return 0;
  } catch (error) {
    console.error('❌ TRX balance error:', error && error.message ? error.message : error);
    return 0;
  }
}

async function sendTRX(fromPrivateKey, toAddress, amount) {
  try {
    const pk = normalizePrivateKeyForTron(fromPrivateKey);
    if (!pk) {
      console.error('sendTRX: missing private key');
      return false;
    }

    // Create transaction using TronWeb but without headers in constructor
    const tronWebForSigning = new TronWeb({
      fullHost: 'https://api.trongrid.io',
      privateKey: pk
    });

    const fromAddress = tronWebForSigning.address.fromPrivateKey(pk);
    
    // Create transaction
    const transaction = await tronWebForSigning.transactionBuilder.sendTrx(
      toAddress,
      tronWebForSigning.toSun(amount),
      fromAddress
    );

    // Sign transaction
    const signedTransaction = await tronWebForSigning.trx.sign(transaction);
    
    // Broadcast using direct API call to avoid header issues
    const broadcastResult = await trongridRequestWithRetry('wallet/broadcasttransaction', {
      method: 'POST',
      body: JSON.stringify(signedTransaction)
    }, 3, 800);

    if (broadcastResult && broadcastResult.result === true) {
      console.log(`✅ TRX sent: ${amount} TRX to ${toAddress}, txid: ${broadcastResult.txid}`);
      return true;
    } else {
      console.error('❌ TRX send failed:', broadcastResult);
      return false;
    }
  } catch (error) {
    console.error('❌ TRX send error:', error && error.message ? error.message : error);
    return false;
  }
}

async function transferUSDT(fromPrivateKey, toAddress, amount) {
  try {
    const pk = normalizePrivateKeyForTron(fromPrivateKey);
    if (!pk) {
      console.error('transferUSDT: missing private key');
      return false;
    }

    // Create TronWeb instance for signing
    const tronWebForSigning = new TronWeb({
      fullHost: 'https://api.trongrid.io',
      privateKey: pk
    });

    const contract = await tronWebForSigning.contract().at(USDT_CONTRACT);
    const amountInSun = Math.floor(amount * 1_000_000);

    console.log(`🔄 Sending ${amount} USDT to ${toAddress}...`);
    const result = await contract.transfer(toAddress, amountInSun).send();
    
    if (result && (result.result === true || result.transaction || result.txid)) {
      console.log(`✅ USDT transfer submitted: ${amount} USDT to ${toAddress}`);
      return true;
    } else {
      console.error('❌ USDT transfer returned unexpected result:', result);
      return false;
    }
  } catch (error) {
    console.error('❌ USDT transfer error:', error && error.message ? error.message : error);
    return false;
  }
}

// ========== autoCollectToMainWallet ==========
async function autoCollectToMainWallet(wallet) {
  try {
    console.log(`💰 AUTO-COLLECT started for: ${wallet.address}`);
    const usdtBalance = await getUSDTBalance(wallet.address);
    console.log(`📊 USDT Balance: ${usdtBalance} USDT`);
    const amountToTransfer = Math.max(0, usdtBalance - KEEP_AMOUNT);

    if (amountToTransfer <= 0) {
      console.log(`❌ Nothing to collect: ${usdtBalance} USDT`);
      return { success: false, reason: 'low_balance' };
    }

    const trxBalance = await getTRXBalance(wallet.address);
    console.log(`⛽ TRX Balance: ${trxBalance} TRX`);

    if (trxBalance < MIN_TRX_FOR_FEE) {
      console.log(`🔄 Funding ${FUND_TRX_AMOUNT} TRX from MASTER to ${wallet.address} for gas`);
      const trxSent = await sendTRX(COMPANY.MASTER.privateKey, wallet.address, FUND_TRX_AMOUNT);
      if (!trxSent) {
        console.log('❌ Failed to fund TRX from MASTER');
        return { success: false, reason: 'funding_failed' };
      }
      // wait a bit for TRX to settle
      await sleep(15000); // Increased wait time
      const newTrx = await getTRXBalance(wallet.address);
      console.log(`🔄 New TRX balance after funding: ${newTrx} TRX`);
      if (newTrx < MIN_TRX_FOR_FEE) {
        console.log('❌ TRX still insufficient after funding');
        return { success: false, reason: 'trx_still_insufficient' };
      }
    }

    console.log(`🔄 Transferring ${amountToTransfer} USDT to MAIN wallet...`);
    const transferResult = await transferUSDT(wallet.private_key, COMPANY.MAIN.address, amountToTransfer);

    if (transferResult) {
      console.log(`✅ SUCCESS: Collected ${amountToTransfer} USDT from ${wallet.address}`);

      // log in DB
      try {
        await supabase.from('transactions').insert({
          user_id: wallet.user_id,
          type: 'collect',
          amount: amountToTransfer,
          description: `Auto-collected to ${COMPANY.MAIN.address}`,
          status: 'completed',
          created_at: new Date().toISOString()
        });
      } catch (e) {
        console.warn('Warning: failed to insert collect transaction record', e && e.message ? e.message : e);
      }

      return { success: true, amount: amountToTransfer };
    } else {
      console.log(`❌ FAILED: USDT transfer from ${wallet.address}`);
      return { success: false, reason: 'usdt_transfer_failed' };
    }
  } catch (error) {
    console.error('❌ Auto-collection fatal error:', error && error.message ? error.message : error);
    return { success: false, reason: 'error', error: error && error.stack ? error.stack : String(error) };
  }
}

// ========== ATOMIC DEPOSIT PROCESSING ==========
async function processDeposit(wallet, amount, txid) {
  try {
    console.log(`💰 PROCESSING DEPOSIT: ${amount} USDT for user ${wallet.user_id}, txid: ${txid}`);

    // АТОМАРНАЯ ПРОВЕРКА: проверяем существующий депозит с этим txid
    const { data: existingDeposit, error: checkError } = await supabase
      .from('deposits')
      .select('id, status, amount')
      .eq('txid', txid)
      .maybeSingle();

    if (checkError) {
      console.error('Error checking existing deposit:', checkError);
      throw checkError;
    }

    if (existingDeposit) {
      console.log(`✅ Deposit already processed: ${txid}, status: ${existingDeposit.status}, amount: ${existingDeposit.amount}`);
      return { success: false, reason: 'already_processed', existing: existingDeposit };
    }

    await ensureUserExists(wallet.user_id);

    // Создаем запись о депозите СРАЗУ со статусом 'processing'
    const { data: newDeposit, error: depositError } = await supabase
      .from('deposits')
      .insert({
        user_id: wallet.user_id,
        amount,
        txid,
        status: 'processing',
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (depositError) {
      // Если ошибка уникальности - значит депозит уже обрабатывается параллельно
      if (depositError.code === '23505') {
        console.log(`🔄 Deposit already being processed by another thread: ${txid}`);
        return { success: false, reason: 'concurrent_processing' };
      }
      throw new Error(`Deposit insert failed: ${depositError.message}`);
    }

    // Получаем текущие данные пользователя
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('balance, total_profit, vip_level')
      .eq('id', wallet.user_id)
      .single();

    if (userError) {
      // Удаляем временную запись депозита в случае ошибки
      await supabase.from('deposits').delete().eq('id', newDeposit.id);
      throw new Error(`user fetch error: ${userError.message}`);
    }

    const currentBalance = Number(user.balance) || 0;
    const newBalance = currentBalance + amount;
    const newTotalProfit = (Number(user.total_profit) || 0) + amount;

    // Обновляем баланс пользователя
    const { error: updateError } = await supabase
      .from('users')
      .update({
        balance: newBalance,
        total_profit: newTotalProfit,
        updated_at: new Date().toISOString()
      })
      .eq('id', wallet.user_id);

    if (updateError) {
      // Удаляем временную запись депозита в случае ошибки
      await supabase.from('deposits').delete().eq('id', newDeposit.id);
      throw new Error(`Balance update failed: ${updateError.message}`);
    }

    // Обновляем статус депозита на 'confirmed'
    await supabase
      .from('deposits')
      .update({ status: 'confirmed' })
      .eq('id', newDeposit.id);

    // Создаем запись в транзакциях
    await supabase.from('transactions').insert({
      user_id: wallet.user_id,
      type: 'deposit',
      amount,
      description: `Депозит USDT (TRC20) - ${txid.substring(0, 10)}...`,
      status: 'completed',
      created_at: new Date().toISOString()
    });

    // Обновляем VIP уровень если нужно
    if (newBalance >= 30 && user.vip_level === 0) {
      await supabase
        .from('users')
        .update({ vip_level: 1 })
        .eq('id', wallet.user_id);
      console.log(`⭐ VIP Level upgraded to 1 for user ${wallet.user_id}`);
    }

    console.log(`✅ DEPOSIT PROCESSED: ${amount} USDT for user ${wallet.user_id}`);
    console.log(`💰 New balance: ${newBalance} USDT`);

    // Запускаем авто-сбор (неблокирующе) с задержкой
    setTimeout(() => {
      autoCollectToMainWallet(wallet).catch(err => {
        console.error('Auto-collect post-deposit failed:', err && err.message ? err.message : err);
      });
    }, 10000); // Увеличиваем задержку до 10 секунд

    return { success: true, amount, deposit_id: newDeposit.id };

  } catch (error) {
    console.error('❌ Error processing deposit:', error && error.message ? error.message : error);
    
    // Пытаемся очистить временные записи в случае ошибки
    try {
      await supabase
        .from('deposits')
        .delete()
        .eq('txid', txid)
        .eq('status', 'processing');
    } catch (cleanupError) {
      console.error('Cleanup error:', cleanupError);
    }
    
    throw error;
  }
}

// ========== API Endpoints ==========
app.post('/generate-wallet', async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ success: false, error: 'User ID is required' });

    console.log(`🔐 Generating wallet for user: ${user_id}`);
    await ensureUserExists(user_id);

    const { data: existingWallet } = await supabase.from('user_wallets').select('address').eq('user_id', user_id).single();
    if (existingWallet) {
      console.log(`✅ Wallet already exists: ${existingWallet.address}`);
      return res.json({ success: true, address: existingWallet.address, exists: true });
    }

    const account = TronWeb.utils.accounts.generateAccount();
    const { data, error } = await supabase.from('user_wallets').insert({
      user_id,
      address: account.address.base58,
      private_key: account.privateKey,
      created_at: new Date().toISOString()
    }).select().single();

    if (error) {
      console.error('❌ Database error:', error);
      return res.status(500).json({ success: false, error: 'Failed to save wallet' });
    }

    console.log(`✅ New wallet created: ${account.address.base58}`);
    setTimeout(() => checkUserDeposits(user_id), 5000);

    res.json({ success: true, address: account.address.base58, exists: false });
  } catch (error) {
    console.error('❌ Generate wallet error:', error && error.message ? error.message : error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.post('/check-deposits', async (req, res) => { await handleCheckDeposits(req, res); });
app.get('/check-deposits', async (req, res) => { await handleCheckDeposits(req, res); });

async function handleCheckDeposits(req = {}, res = {}) {
  try {
    console.log('🔄 Checking deposits for all users (THROTTLED)...');
    const { data: wallets, error } = await supabase.from('user_wallets').select('*').limit(200);
    if (error) throw error;

    console.log(`🔍 Checking ${wallets?.length || 0} wallets with throttling`);
    let processedCount = 0;
    let depositsFound = 0;
    let duplicatesSkipped = 0;

    for (const wallet of wallets || []) {
      try {
        // throttle between wallets to reduce chance of 429s
        await sleep(200);
        const transactions = await getUSDTTransactions(wallet.address);
        
        for (const tx of transactions) {
          if (tx.to === wallet.address && tx.token === 'USDT' && tx.amount >= MIN_DEPOSIT) {
            try {
              const result = await processDeposit(wallet, tx.amount, tx.transaction_id);
              if (result.success) {
                depositsFound++;
              } else if (result.reason === 'already_processed' || result.reason === 'concurrent_processing') {
                duplicatesSkipped++;
              }
            } catch (err) {
              console.error(`❌ Error processing deposit ${tx.transaction_id}:`, err && err.message ? err.message : err);
            }
          }
        }

        await supabase.from('user_wallets').update({ last_checked: new Date().toISOString() }).eq('id', wallet.id);
        processedCount++;
      } catch (err) {
        console.error(`❌ Error processing wallet ${wallet.address}:`, err && err.message ? err.message : err);
      }
    }

    const message = `✅ Processed ${processedCount} wallets, found ${depositsFound} new deposits, skipped ${duplicatesSkipped} duplicates`;
    console.log(message);
    if (res && typeof res.json === 'function') res.json({ success: true, message });
    return { success: true, message };
  } catch (error) {
    console.error('❌ Deposit check error:', error && error.message ? error.message : error);
    if (res && typeof res.status === 'function') res.status(500).json({ success: false, error: error.message });
    return { success: false, error: error.message };
  }
}

// collect funds endpoints
app.post('/collect-funds', async (req, res) => { await handleCollectFunds(req, res); });
app.get('/collect-funds', async (req, res) => { await handleCollectFunds(req, res); });

async function handleCollectFunds(req = {}, res = {}) {
  try {
    console.log('💰 Manual funds collection started (THROTTLED)...');
    const { data: wallets, error } = await supabase.from('user_wallets').select('*').limit(200);
    if (error) throw error;

    let collectedCount = 0;
    let totalCollected = 0;
    for (const wallet of wallets || []) {
      try {
        await sleep(200);
        const result = await autoCollectToMainWallet(wallet);
        if (result && result.success) {
          collectedCount++;
          totalCollected += result.amount;
          await sleep(500);
        }
      } catch (err) {
        console.error(`❌ Error collecting from ${wallet.address}:`, err && err.message ? err.message : err);
      }
    }

    const message = `✅ Collected ${totalCollected.toFixed(6)} USDT from ${collectedCount} wallets`;
    console.log(message);
    if (res && typeof res.json === 'function') res.json({ success: true, message });
    return { success: true, message };
  } catch (error) {
    console.error('❌ Funds collection error:', error && error.message ? error.message : error);
    if (res && typeof res.status === 'function') res.status(500).json({ success: false, error: error.message });
    return { success: false, error: error.message };
  }
}

// ========== helper DB functions ==========
async function ensureUserExists(userId) {
  try {
    const { data } = await supabase.from('users').select('id').eq('id', userId).single();
    if (!data) {
      await supabase.from('users').insert({
        id: userId,
        email: `user-${userId}@temp.com`,
        username: `user-${(userId || '').substring(0, 8)}`,
        referral_code: `REF-${(userId || '').substring(0, 8)}`,
        balance: 0.00,
        total_profit: 0.00,
        vip_level: 0,
        created_at: new Date().toISOString()
      });
      console.log(`✅ User created: ${userId}`);
    }
  } catch (error) {
    console.error('❌ ensureUserExists error:', error && error.message ? error.message : error);
  }
}

async function checkUserDeposits(userId) {
  try {
    const { data: wallet } = await supabase.from('user_wallets').select('*').eq('user_id', userId).single();
    if (!wallet) return;
    
    console.log(`🔍 Checking deposits for user ${userId}, wallet: ${wallet.address}`);
    const transactions = await getUSDTTransactions(wallet.address);
    
    for (const tx of transactions) {
      if (tx.to === wallet.address && tx.token === 'USDT' && tx.amount >= MIN_DEPOSIT) {
        try {
          const result = await processDeposit(wallet, tx.amount, tx.transaction_id);
          if (result.success) {
            console.log(`💰 FOUND NEW DEPOSIT: ${tx.amount} USDT for user ${userId}`);
          } else if (result.reason === 'already_processed') {
            console.log(`✅ Deposit already processed: ${tx.transaction_id}`);
          }
        } catch (err) {
          console.error(`❌ Error processing transaction ${tx.transaction_id}:`, err);
        }
      }
    }
  } catch (error) {
    console.error('❌ checkUserDeposits error:', error);
  }
}

// ========== HEALTH CHECK ==========
app.get('/', (req, res) => {
  res.json({
    status: '✅ WORKING',
    message: 'Tron Wallet System - DUPLICATE PROTECTION',
    timestamp: new Date().toISOString(),
    features: [
      'Wallet Generation',
      'Deposit Processing (Atomic)',
      'Balance Updates',
      'Auto Collection (throttled)',
      'TRX Gas Management',
      'USDT Transfers',
      'DUPLICATE PROTECTION'
    ]
  });
});

// ========== Scheduler (internal call) ==========
setInterval(async () => {
  try {
    console.log('🕒 AUTO-CHECK: Scanning for deposits (internal call)...');
    await handleCheckDeposits();
  } catch (err) {
    console.error('❌ Auto-check internal error:', err && err.message ? err.message : err);
  }
}, CHECK_INTERVAL_MS);

// ========== START SERVER ==========
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 SERVER RUNNING on port ${PORT}`);
  console.log(`✅ SUPABASE: ${SUPABASE_URL ? 'CONNECTED' : 'MISSING'}`);
  console.log(`✅ TRONGRID: API KEY ${TRONGRID_API_KEY ? 'SET' : 'MISSING'}`);
  console.log(`💰 MASTER: ${COMPANY.MASTER.address}`);
  console.log(`💰 MAIN: ${COMPANY.MAIN.address}`);
  console.log(`⏰ AUTO-CHECK: EVERY ${Math.round(CHECK_INTERVAL_MS / 1000)}s`);
  console.log(`🔧 THROTTLING: ${BALANCE_CONCURRENCY} concurrent requests`);
  console.log(`🛡️  DUPLICATE PROTECTION: ENABLED`);
  console.log('===================================');
});
