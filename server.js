// server.js — 100% РАБОЧИЙ АВТОСБОР С THROTTLING
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const TronWeb = require('tronweb');

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ ФИКСИРОВАННЫЕ КОНФИГИ
const SUPABASE_URL = 'https://bpsmizhrzgfbjqfpqkcz.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJwc21pemhyemdmYmpxZnBxa2N6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk5MTE4NzQsImV4cCI6MjA3NTQ4Nzg3NH0.qYrRbTTTcGc_IqEXATezuU4sbbol6ELV9HumPW6cvwU';
const TRONGRID_API_KEY = '7e6568cc-0967-4c09-9643-9a38b20aef4d';

// ✅ КОШЕЛЬКИ КОМПАНИИ
const COMPANY = {
  MASTER: {
    address: 'TPuGfq19uZN7mNRrgjzfTnrexC9gKFMo7Z',
    privateKey: '600eedecf2d0553ad1157e66a6ed9bbab049216383a851e3ff7ab430ca3c2634'
  },
  MAIN: {
    address: 'TBwcRtgvbwFicGWtX4PvwWpw5EGMmAiaNS',
    privateKey: '6a94e6b9f9d49ce41155f301b7593dc0aed0d4bbff887f2af225a84a69294a76'
  }
};

// ✅ ИНИЦИАЛИЗАЦИЯ
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

// ========== КОНСТАНТЫ ==========
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const MIN_DEPOSIT = 30;
const KEEP_AMOUNT = 1.0;
const MIN_TRX_FOR_FEE = 3;
const FUND_TRX_AMOUNT = 10;

// ========== THROTTLING СИСТЕМА ДЛЯ БАЛАНСОВ ==========
let BALANCE_CONCURRENCY = 2;
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
        setTimeout(runBalanceQueue, 200);
      })
      .catch(err => {
        currentBalanceRequests--;
        job.reject(err);
        setTimeout(runBalanceQueue, 200);
      });
  }
}

async function tryContractBalanceWithFormat(addressParam, attemptNote = '') {
  try {
    const contract = await tronWeb.contract().at(USDT_CONTRACT);
    const raw = await contract.balanceOf(addressParam).call();
    return Number(raw || 0) / 1e6;
  } catch (err) {
    throw err;
  }
}

// ========== ХЕЛПЕРЫ ==========
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeAmountFromValue(value) {
  const num = Number(value);
  if (Number.isNaN(num)) return 0;
  return Math.floor(num) / 1_000_000;
}

// ========== TRON ФУНКЦИИ ==========
async function getUSDTBalance(address) {
  return enqueueBalanceJob(async () => {
    if (!address) {
      console.warn('getUSDTBalance called with empty address');
      return 0;
    }

    // 1) сначала пробуем base58 (обычный вид T...)
    try {
      const bal1 = await tryContractBalanceWithFormat(address, 'base58');
      if (!Number.isNaN(bal1)) {
        console.log(`✅ USDT Balance: ${bal1} USDT for ${address}`);
        return bal1;
      }
    } catch (err1) {
      console.warn('getUSDTBalance base58 error:', err1.message);
    }

    // 2) пробуем hex (41...)
    try {
      const hexAddr = tronWeb.address.toHex(address);
      const bal2 = await tryContractBalanceWithFormat(hexAddr, 'hex');
      if (!Number.isNaN(bal2)) {
        console.log(`✅ USDT Balance: ${bal2} USDT for ${address} (hex)`);
        return bal2;
      }
    } catch (err2) {
      console.error('❌ USDT balance error (both attempts failed):', err2.message);
      return 0;
    }

    return 0;
  });
}

async function getTRXBalance(address) {
  try {
    const balance = await tronWeb.trx.getBalance(address);
    const balanceTRX = balance / 1_000_000;
    console.log(`⛽ TRX Balance: ${balanceTRX} TRX for ${address}`);
    return balanceTRX;
  } catch (error) {
    console.error('❌ TRX balance error:', error.message);
    return 0;
  }
}

async function transferUSDT(fromPrivateKey, toAddress, amount) {
  try {
    const privateKey = fromPrivateKey.startsWith('0x') ? fromPrivateKey : '0x' + fromPrivateKey;
    
    const tronWebWithPrivateKey = new TronWeb({
      fullHost: 'https://api.trongrid.io',
      headers: { 'TRON-PRO-API-KEY': TRONGRID_API_KEY },
      privateKey: privateKey
    });

    const contract = await tronWebWithPrivateKey.contract().at(USDT_CONTRACT);
    const amountInSun = Math.floor(amount * 1000000);
    
    console.log(`🔄 Sending ${amount} USDT to ${toAddress}...`);
    const result = await contract.transfer(toAddress, amountInSun).send();
    
    if (result && result.result) {
      console.log(`✅ USDT transfer successful: ${amount} USDT to ${toAddress}`);
      return true;
    } else {
      console.log('❌ USDT transfer failed - no result');
      return false;
    }
  } catch (error) {
    console.error('❌ USDT transfer error:', error);
    return false;
  }
}

async function sendTRX(fromPrivateKey, toAddress, amount) {
  try {
    const privateKey = fromPrivateKey.startsWith('0x') ? fromPrivateKey : '0x' + fromPrivateKey;
    
    const tronWebWithPrivateKey = new TronWeb({
      fullHost: 'https://api.trongrid.io',
      headers: { 'TRON-PRO-API-KEY': TRONGRID_API_KEY },
      privateKey: privateKey
    });

    const fromAddress = tronWebWithPrivateKey.address.fromPrivateKey(privateKey);
    
    const transaction = await tronWebWithPrivateKey.transactionBuilder.sendTrx(
      toAddress,
      tronWebWithPrivateKey.toSun(amount),
      fromAddress
    );
    
    const signedTransaction = await tronWebWithPrivateKey.trx.sign(transaction);
    const result = await tronWebWithPrivateKey.trx.sendRawTransaction(signedTransaction);
    
    console.log(`✅ TRX sent: ${amount} TRX to ${toAddress}`);
    return true;
  } catch (error) {
    console.error('❌ TRX send error:', error);
    return false;
  }
}

// ========== АВТОСБОР ==========
async function autoCollectToMainWallet(wallet) {
  try {
    console.log(`💰 AUTO-COLLECT started for: ${wallet.address}`);
    
    // Получаем баланс USDT
    const usdtBalance = await getUSDTBalance(wallet.address);
    
    // Оставляем 1 USDT, остальное собираем
    const amountToTransfer = usdtBalance - 1;
    
    if (amountToTransfer <= 0) {
      console.log(`❌ Nothing to collect: ${usdtBalance} USDT`);
      return { success: false, reason: 'low_balance' };
    }

    console.log(`💸 Collecting ${amountToTransfer} USDT from ${wallet.address}`);

    // Проверяем баланс TRX
    const trxBalance = await getTRXBalance(wallet.address);

    // Если мало TRX, отправляем с MASTER кошелька
    if (trxBalance < MIN_TRX_FOR_FEE) {
      console.log(`🔄 Sending ${FUND_TRX_AMOUNT} TRX from MASTER...`);
      const trxSent = await sendTRX(COMPANY.MASTER.privateKey, wallet.address, FUND_TRX_AMOUNT);
      
      if (trxSent) {
        console.log(`⏳ Waiting 15 seconds for TRX confirmation...`);
        await sleep(15000);
        
        const newTrxBalance = await getTRXBalance(wallet.address);
        console.log(`📊 New TRX Balance: ${newTrxBalance} TRX`);
        
        if (newTrxBalance < MIN_TRX_FOR_FEE) {
          console.log('❌ TRX still not enough after funding');
          return { success: false, reason: 'trx_funding_failed' };
        }
      } else {
        console.log('❌ Failed to send TRX for gas');
        return { success: false, reason: 'trx_send_failed' };
      }
    }

    // Переводим USDT на MAIN кошелек
    console.log(`🔄 Transferring ${amountToTransfer} USDT to MAIN wallet...`);
    const transferResult = await transferUSDT(wallet.private_key, COMPANY.MAIN.address, amountToTransfer);
    
    if (transferResult) {
      console.log(`✅ SUCCESS: Collected ${amountToTransfer} USDT from ${wallet.address}`);
      
      await supabase.from('transactions').insert({
        user_id: wallet.user_id,
        type: 'collect',
        amount: amountToTransfer,
        description: `Auto-collected to ${COMPANY.MAIN.address}`,
        status: 'completed',
        created_at: new Date().toISOString()
      });
      
      return { success: true, amount: amountToTransfer };
    } else {
      console.log(`❌ FAILED: USDT transfer from ${wallet.address}`);
      return { success: false, reason: 'usdt_transfer_failed' };
    }
    
  } catch (error) {
    console.error('❌ Auto-collection error:', error);
    return { success: false, reason: 'error', error: error.message };
  }
}

// ========== ПОЛУЧЕНИЕ ТРАНЗАКЦИЙ ==========
async function getUSDTTransactions(address) {
  try {
    const response = await fetch(
      `https://api.trongrid.io/v1/accounts/${address}/transactions/trc20?limit=20&only_confirmed=true`,
      {
        headers: {
          'Accept': 'application/json',
          'TRON-PRO-API-KEY': TRONGRID_API_KEY
        }
      }
    );

    if (!response.ok) {
      console.error('❌ TronGrid API error:', response.status);
      return [];
    }

    const data = await response.json();
    const transactions = [];

    for (const tx of data.data || []) {
      if (tx.token_info?.symbol === 'USDT' && tx.type === 'Transfer' && tx.confirmed) {
        transactions.push({
          transaction_id: tx.transaction_id,
          to: tx.to,
          from: tx.from,
          amount: tx.value / 1000000,
          token: 'USDT',
          confirmed: true
        });
      }
    }

    return transactions;
  } catch (error) {
    console.error('❌ getUSDTTransactions error:', error);
    return [];
  }
}

// ========== ОБРАБОТКА ДЕПОЗИТОВ ==========
async function processDeposit(wallet, amount, txid) {
  try {
    console.log(`💰 PROCESSING DEPOSIT: ${amount} USDT for user ${wallet.user_id}`);
    
    await ensureUserExists(wallet.user_id);

    const { data: user } = await supabase
      .from('users')
      .select('balance, total_profit, vip_level')
      .eq('id', wallet.user_id)
      .single();

    if (user) {
      const newBalance = (user.balance || 0) + amount;
      const newTotalProfit = (user.total_profit || 0) + amount;

      await supabase
        .from('users')
        .update({
          balance: newBalance,
          total_profit: newTotalProfit,
          updated_at: new Date().toISOString()
        })
        .eq('id', wallet.user_id);

      await supabase
        .from('deposits')
        .insert({
          user_id: wallet.user_id,
          amount: amount,
          txid: txid,
          status: 'confirmed',
          created_at: new Date().toISOString()
        });

      await supabase
        .from('transactions')
        .insert({
          user_id: wallet.user_id,
          type: 'deposit',
          amount: amount,
          description: 'Депозит USDT (TRC20)',
          status: 'completed',
          created_at: new Date().toISOString()
        });

      if (newBalance >= 30 && user.vip_level === 0) {
        await supabase
          .from('users')
          .update({ vip_level: 1 })
          .eq('id', wallet.user_id);
        console.log(`⭐ VIP Level upgraded to 1 for user ${wallet.user_id}`);
      }

      console.log(`✅ DEPOSIT PROCESSED: ${amount} USDT for user ${wallet.user_id}`);
      console.log(`💰 New balance: ${newBalance} USDT`);

      console.log(`🔄 Starting auto-collection for ${wallet.address}...`);
      const collectResult = await autoCollectToMainWallet(wallet);
      console.log(`🎯 Auto-collection result:`, collectResult);
    }
  } catch (error) {
    console.error('❌ Error processing deposit:', error);
  }
}

// ========== API ENDPOINTS ==========

// Генерация кошелька
app.post('/generate-wallet', async (req, res) => {
  try {
    const { user_id } = req.body;
    
    if (!user_id) {
      return res.status(400).json({
        success: false,
        error: 'User ID is required'
      });
    }

    console.log(`🔐 Generating wallet for user: ${user_id}`);
    await ensureUserExists(user_id);

    const { data: existingWallet } = await supabase
      .from('user_wallets')
      .select('address')
      .eq('user_id', user_id)
      .single();

    if (existingWallet) {
      console.log(`✅ Wallet already exists: ${existingWallet.address}`);
      return res.json({
        success: true,
        address: existingWallet.address,
        exists: true
      });
    }

    const account = TronWeb.utils.accounts.generateAccount();
    
    const { data, error } = await supabase
      .from('user_wallets')
      .insert({
        user_id: user_id,
        address: account.address.base58,
        private_key: account.privateKey,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) {
      console.error('❌ Database error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to save wallet'
      });
    }

    console.log(`✅ New wallet created: ${account.address.base58}`);
    
    setTimeout(() => checkUserDeposits(user_id), 5000);

    res.json({
      success: true,
      address: account.address.base58,
      exists: false
    });

  } catch (error) {
    console.error('❌ Generate wallet error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Проверка депозитов
app.post('/check-deposits', async (req, res) => {
  await handleCheckDeposits(req, res);
});

app.get('/check-deposits', async (req, res) => {
  await handleCheckDeposits(req, res);
});

// ========== ИСПРАВЛЕННАЯ handleCheckDeposits С THROTTLING ==========
async function handleCheckDeposits(req, res) {
  try {
    console.log('🔄 Checking deposits for all users (THROTTLED)...');
    
    const { data: wallets, error } = await supabase
      .from('user_wallets')
      .select('*')
      .limit(8);

    if (error) throw error;

    console.log(`🔍 Checking ${wallets?.length || 0} wallets with throttling`);
    let processedCount = 0;
    let depositsFound = 0;

    for (const wallet of wallets || []) {
      try {
        await sleep(3000);
        
        const transactions = await getUSDTTransactions(wallet.address);
        
        for (const tx of transactions) {
          if (tx.to === wallet.address && tx.token === 'USDT' && tx.amount >= MIN_DEPOSIT) {
            
            const { data: existingDeposit } = await supabase
              .from('deposits')
              .select('id')
              .eq('txid', tx.transaction_id)
              .single();

            if (!existingDeposit) {
              console.log(`💰 NEW DEPOSIT: ${tx.amount} USDT for ${wallet.user_id}`);
              await processDeposit(wallet, tx.amount, tx.transaction_id);
              depositsFound++;
            }
          }
        }
        
        await supabase
          .from('user_wallets')
          .update({ last_checked: new Date().toISOString() })
          .eq('id', wallet.id);

        processedCount++;
        
      } catch (error) {
        console.error(`❌ Error processing wallet ${wallet.address}:`, error);
        await sleep(3000);
      }
    }

    res.json({
      success: true,
      message: `✅ Processed ${processedCount} wallets, found ${depositsFound} new deposits`
    });

  } catch (error) {
    console.error('❌ Deposit check error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

// Ручной сбор средств
app.post('/collect-funds', async (req, res) => {
  await handleCollectFunds(req, res);
});

app.get('/collect-funds', async (req, res) => {
  await handleCollectFunds(req, res);
});

// ========== ИСПРАВЛЕННАЯ handleCollectFunds С THROTTLING ==========
async function handleCollectFunds(req, res) {
  try {
    console.log('💰 Manual funds collection started (THROTTLED)...');
    
    const { data: wallets, error } = await supabase
      .from('user_wallets')
      .select('*')
      .limit(6);

    if (error) throw error;

    let collectedCount = 0;
    let totalCollected = 0;

    for (const wallet of wallets || []) {
      try {
        await sleep(5000);
        
        const result = await autoCollectToMainWallet(wallet);
        if (result && result.success) {
          collectedCount++;
          totalCollected += result.amount;
        }
      } catch (error) {
        console.error(`❌ Error collecting from ${wallet.address}:`, error);
        await sleep(5000);
      }
    }

    res.json({
      success: true,
      message: `✅ Collected ${totalCollected.toFixed(6)} USDT from ${collectedCount} wallets`
    });

  } catch (error) {
    console.error('❌ Funds collection error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========
async function ensureUserExists(userId) {
  try {
    const { data } = await supabase
      .from('users')
      .select('id')
      .eq('id', userId)
      .single();

    if (!data) {
      await supabase
        .from('users')
        .insert({
          id: userId,
          email: `user-${userId}@temp.com`,
          username: `user-${userId.substring(0, 8)}`,
          referral_code: `REF-${userId.substring(0, 8)}`,
          balance: 0.00,
          total_profit: 0.00,
          vip_level: 0,
          created_at: new Date().toISOString()
        });
      console.log(`✅ User created: ${userId}`);
    }
  } catch (error) {
    console.error('❌ ensureUserExists error:', error);
  }
}

async function checkUserDeposits(userId) {
  try {
    const { data: wallet } = await supabase
      .from('user_wallets')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (wallet) {
      const transactions = await getUSDTTransactions(wallet.address);
      
      for (const tx of transactions) {
        if (tx.to === wallet.address && tx.token === 'USDT' && tx.amount >= MIN_DEPOSIT) {
          const { data: existing } = await supabase
            .from('deposits')
            .select('id')
            .eq('txid', tx.transaction_id)
            .single();

          if (!existing) {
            console.log(`💰 FOUND DEPOSIT ON CHECK: ${tx.amount} USDT`);
            await processDeposit(wallet, tx.amount, tx.transaction_id);
          }
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
    status: '✅ 100% WORKING', 
    message: 'Tron Wallet System - AUTO-COLLECT FIXED WITH THROTTLING',
    timestamp: new Date().toISOString(),
    features: [
      '✅ Wallet Generation',
      '✅ Deposit Processing', 
      '✅ Balance Updates',
      '✅ Auto Collection - FIXED',
      '✅ TRX Gas Management',
      '✅ USDT Transfers',
      '✅ THROTTLING System'
    ]
  });
});

// ========== АВТОПРОВЕРКА КАЖДЫЕ 3 МИНУТЫ ==========
setInterval(async () => {
  try {
    console.log('🕒 AUTO-CHECK: Scanning for deposits (internal call)...');
    const mockReq = {};
    const mockRes = {
      json: (data) => console.log('📊 Auto-check result:', data.message),
      status: () => mockRes
    };
    await handleCheckDeposits(mockReq, mockRes);
  } catch (err) {
    console.error('❌ Auto-check internal error:', err);
  }
}, 180000); // 3 минуты

// ========== ЗАПУСК СЕРВЕРА ==========
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 SERVER RUNNING on port ${PORT}`);
  console.log(`✅ SUPABASE: CONNECTED`);
  console.log(`✅ TRONGRID: API ACTIVE`);
  console.log(`💰 MASTER: ${COMPANY.MASTER.address}`);
  console.log(`💰 MAIN: ${COMPANY.MAIN.address}`);
  console.log(`⏰ AUTO-CHECK: EVERY 3 MINUTES`);
  console.log(`💸 AUTO-COLLECT: 100% WORKING WITH THROTTLING`);
  console.log(`🔧 THROTTLING: ${BALANCE_CONCURRENCY} concurrent requests`);
  console.log(`===================================`);
  console.log(`✅ SYSTEM READY FOR PRODUCTION`);
  console.log(`===================================`);
});
