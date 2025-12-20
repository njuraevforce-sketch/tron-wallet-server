// server.js — OPTIMIZED FOR TRC20 & BEP20 WITH DUPLICATE PROTECTION
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const TronWeb = require('tronweb');

const app = express();
const PORT = process.env.PORT || 8080;

// ========== CONFIGURATION ==========
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jxyazsguwkbklavamzyj.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp4eWF6c2d1d2tia2xhdmFtenlqIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NDU1MjgzMywiZXhwIjoyMDgwMTI4ODMzfQ.nvjoMzRgLRmR3ekIYgIzLTO_Hdxh37is1m3BApY9xk4';
const TRONGRID_API_KEY = process.env.TRONGRID_API_KEY || '8fa63ef4-f010-4ad2-a556-a7124563bafd';
const MORALIS_API_KEY = process.env.MORALIS_API_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6IjA2NTU1NTc1LWM1OGItNDVkYi1hM2NjLTMzYzgwNzhlMDIxMyIsIm9yZ0lkIjoiNDg1NTk3IiwidXNlcklkIjoiNDk5NTkwIiwidHlwZUlkIjoiOGJkYmI4MTctY2FjYy00MTNiLWE1NzAtOTIxNDRmNTYxYmZjIiwidHlwZSI6IlBST0pFQ1QiLCJpYXQiOjE3NjU0NTY4MzYsImV4cCI6NDkyMTIxNjgzNn0.FoutXU8bmSPbs2dDC2_5Qb8MuXNvEiLJfxSqOYjKNp0';

// ========== MIDDLEWARE ==========
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Allow-Methods', '*');
  next();
});

// ========== HTTP ROUTES ==========
app.get('/', (req, res) => {
  res.json({
    status: '✅ SERVER IS RUNNING',
    message: 'GLY Deposit Processing System',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development'
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: '✅ HEALTHY',
    service: 'GLY Deposit Processor',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: '✅ API HEALTHY',
    timestamp: new Date().toISOString()
  });
});

// ========== INITIALIZE SERVICES ==========
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const tronWeb = new TronWeb({
  fullHost: 'https://api.trongrid.io',
  headers: { 'TRON-PRO-API-KEY': TRONGRID_API_KEY }
});

// ========== CONSTANTS ==========
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const USDT_BSC_CONTRACT = '0x55d398326f99059fF775485246999027B3197955';
const MIN_DEPOSIT = 17;

// ========== OPTIMIZED SETTINGS ==========
const TRC20_CHECK_INTERVAL = 45000; // 45 секунд
const BEP20_CHECK_INTERVAL = 180000; // 3 минуты
const BEP20_DELAY_MS = 500; // 2 запроса/секунду для Moralis
const TRC20_DELAY_MS = 100; // 10 запросов/секунду для TronGrid

// ========== HELPERS ==========
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

// ========== WALLET GENERATION ==========
async function generateTRC20Wallet() {
  try {
    const account = await tronWeb.createAccount();
    return {
      address: account.address.base58,
      privateKey: account.privateKey
    };
  } catch (error) {
    console.error('❌ TRC20 wallet generation error:', error);
    throw error;
  }
}

async function generateBEP20Wallet() {
  try {
    const { ethers } = require('ethers');
    const wallet = ethers.Wallet.createRandom();
    return {
      address: wallet.address,
      privateKey: wallet.privateKey
    };
  } catch (error) {
    console.error('❌ BEP20 wallet generation error:', error);
    throw error;
  }
}

// ========== DEPOSIT PROCESSING ==========
async function processDeposit(wallet, amount, txid, network) {
  try {
    console.log(`💰 PROCESSING DEPOSIT: ${amount} USDT for user ${wallet.user_id}, txid: ${txid}, network: ${network}`);

    // Улучшенная проверка дубликатов (по хэшу И сети)
    const { data: existingDeposit, error: checkError } = await supabase
      .from('deposit_transactions')
      .select('id, status, amount, network')
      .eq('tx_hash', txid)
      .eq('network', network)
      .maybeSingle();

    if (checkError) {
      console.error('Error checking existing deposit:', checkError);
      throw checkError;
    }

    if (existingDeposit) {
      console.log(`✅ Deposit already processed: ${txid}, status: ${existingDeposit.status}, amount: ${existingDeposit.amount}`);
      
      // Если депозит уже обработан, но статус не 'processed', обновим его
      if (existingDeposit.status !== 'processed') {
        await supabase
          .from('deposit_transactions')
          .update({ status: 'processed' })
          .eq('id', existingDeposit.id);
      }
      
      return { success: false, reason: 'already_processed', existing: existingDeposit };
    }

    // Начинаем обработку депозита
    const depositResult = await processDepositTransaction(wallet, amount, txid, network);
    
    return depositResult;
  } catch (error) {
    console.error('❌ Error in processDeposit:', error.message);
    throw error;
  }
}

// Новая функция для обработки депозита через PostgreSQL RPC
async function processDepositTransaction(wallet, amount, txid, network) {
  try {
    // Используем атомарную RPC функцию для обработки депозита
    const { data: result, error: rpcError } = await supabase
      .rpc('process_user_deposit', {
        p_user_id: wallet.user_id,
        p_amount: amount,
        p_tx_hash: txid,
        p_network: network
      });

    if (rpcError) {
      console.error('❌ RPC Error:', rpcError.message);
      throw new Error(`Database transaction failed: ${rpcError.message}`);
    }

    if (!result.success) {
      if (result.reason === 'duplicate_transaction') {
        console.log(`⏭️ Duplicate transaction detected: ${txid}`);
        return { success: false, reason: 'already_processed', deposit_id: result.deposit_id };
      }
      throw new Error(`Deposit processing failed: ${result.error || result.reason}`);
    }

    console.log(`✅ DEPOSIT PROCESSED ATOMICALLY: ${amount} USDT for user ${wallet.user_id}`);
    console.log(`💰 New balance: ${result.new_balance} USDT`);
    console.log(`📝 Deposit ID: ${result.deposit_id}`);

    return { 
      success: true, 
      amount, 
      deposit_id: result.deposit_id,
      new_balance: result.new_balance
    };
    
  } catch (error) {
    console.error('❌ Error in atomic deposit processing:', error.message);
    throw error;
  }
}

// ========== API Endpoints ==========
app.post('/api/deposit/generate', async (req, res) => {
  try {
    const { user_id, network = 'trc20' } = req.query;
    if (!user_id) return res.status(400).json({ success: false, error: 'User ID is required' });

    console.log(`🔐 Generating ${network} wallet for user: ${user_id}`);

    // Проверяем существующий кошелек
    const { data: existingWallet } = await supabase
      .from('deposit_addresses')
      .select('address, private_key')
      .eq('user_id', user_id)
      .eq('network', network)
      .single();

    if (existingWallet) {
      console.log(`✅ Wallet already exists: ${existingWallet.address} (${network})`);
      return res.json({ 
        success: true, 
        address: existingWallet.address, 
        private_key: existingWallet.private_key,
        exists: true, 
        network 
      });
    }

    let address, private_key;

    // Генерируем новый кошелек
    if (network === 'trc20') {
      const wallet = await generateTRC20Wallet();
      address = wallet.address;
      private_key = wallet.privateKey;
    } else if (network === 'bep20') {
      const wallet = await generateBEP20Wallet();
      address = wallet.address;
      private_key = wallet.privateKey;
    } else {
      return res.status(400).json({ success: false, error: 'Unsupported network' });
    }

    // Сохраняем в базу данных
    const { data, error } = await supabase.from('deposit_addresses').insert({
      user_id,
      address,
      private_key,
      network,
      created_at: new Date().toISOString()
    }).select().single();

    if (error) {
      // Обработка ошибки дубликата при вставке
      if (error.code === '23505') {
        // Кошелек был создан в другом потоке
        const { data: wallet } = await supabase
          .from('deposit_addresses')
          .select('address, private_key')
          .eq('user_id', user_id)
          .eq('network', network)
          .single();
        
        if (wallet) {
          return res.json({ 
            success: true, 
            address: wallet.address, 
            private_key: wallet.private_key,
            exists: true, 
            network 
          });
        }
      }
      
      console.error('❌ Database error:', error);
      return res.status(500).json({ success: false, error: 'Failed to save wallet' });
    }

    console.log(`✅ New ${network} wallet created: ${address}`);
    
    // Проверяем существующие депозиты
    setTimeout(() => {
      if (network === 'trc20') {
        checkUserTRC20Deposits(user_id);
      } else {
        checkUserBEP20Deposits(user_id);
      }
    }, 5000);

    res.json({ 
      success: true, 
      address, 
      private_key,
      exists: false, 
      network 
    });
  } catch (error) {
    console.error('❌ Generate wallet error:', error.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.get('/api/deposit/history', async (req, res) => {
  try {
    const { user_id, network = 'trc20' } = req.query;
    if (!user_id) return res.status(400).json({ success: false, error: 'User ID is required' });

    const { data: deposits, error } = await supabase
      .from('deposit_transactions')
      .select('*')
      .eq('user_id', user_id)
      .eq('network', network)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) {
      console.error('❌ Database error:', error);
      return res.status(500).json({ success: false, error: 'Failed to fetch deposit history' });
    }

    res.json({ success: true, deposits: deposits || [] });
  } catch (error) {
    console.error('❌ Deposit history error:', error.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ========== DEPOSIT CHECKING ==========
app.get('/api/check-deposits', async (req, res) => { 
  try {
    console.log('🔄 Manual deposit check triggered via API');
    const trc20Result = await handleCheckTRC20Deposits();
    const bep20Result = await handleCheckBEP20Deposits();
    
    res.json({
      success: true,
      trc20: trc20Result,
      bep20: bep20Result
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== TRC20 TRANSACTIONS ==========
async function getTRC20Transactions(address) {
  try {
    if (!address) return [];
    
    const response = await fetch(`https://api.trongrid.io/v1/accounts/${address}/transactions/trc20?limit=10&only_confirmed=true`, {
      headers: {
        'TRON-PRO-API-KEY': TRONGRID_API_KEY
      }
    });
    
    const json = await response.json();
    const raw = json.data || [];
    const transactions = [];

    for (const tx of raw) {
      try {
        const tokenAddr = tx.token_info?.address;
        if (!tokenAddr || tokenAddr !== USDT_CONTRACT) continue;

        const to = toBase58IfHex(tx.to);
        const from = toBase58IfHex(tx.from);
        const rawValue = tx.value || 0;
        const amount = Number(rawValue) / 1_000_000;

        if (amount >= MIN_DEPOSIT) {
          transactions.push({
            transaction_id: tx.transaction_id,
            to,
            from,
            amount,
            token: 'USDT',
            confirmed: true,
            network: 'trc20',
            timestamp: tx.block_timestamp
          });
        }
      } catch (innerErr) {
        continue;
      }
    }

    transactions.sort((a, b) => b.timestamp - a.timestamp);
    return transactions;
  } catch (error) {
    console.error('❌ TRC20 transactions error:', error.message);
    return [];
  }
}

// ========== BEP20 TRANSACTIONS ==========
async function getBEP20Transactions(address) {
  try {
    console.log(`🔍 Checking BEP20 via Moralis: ${address}`);
    
    const response = await fetch(
      `https://deep-index.moralis.io/api/v2/${address}/erc20/transfers?chain=bsc&token_addresses=${USDT_BSC_CONTRACT}&limit=5`,
      {
        headers: {
          'X-API-Key': MORALIS_API_KEY,
          'Accept': 'application/json'
        }
      }
    );

    if (!response.ok) {
      throw new Error(`Moralis API error: ${response.status}`);
    }

    const data = await response.json();
    const transactions = [];

    for (const tx of data.result || []) {
      try {
        if (tx.to_address.toLowerCase() === address.toLowerCase() && tx.token_symbol === 'USDT') {
          const amount = Number(tx.value) / Math.pow(10, tx.decimals || 18);
          
          if (amount >= MIN_DEPOSIT) {
            transactions.push({
              transaction_id: tx.transaction_hash,
              to: tx.to_address.toLowerCase(),
              from: tx.from_address.toLowerCase(),
              amount: amount,
              token: 'USDT',
              confirmed: true,
              network: 'bep20',
              timestamp: new Date(tx.block_timestamp).getTime(),
              blockNumber: parseInt(tx.block_number)
            });
          }
        }
      } catch (e) {
        continue;
      }
    }

    console.log(`✅ Found ${transactions.length} BEP20 transactions for ${address}`);
    return transactions;

  } catch (error) {
    console.error('❌ Moralis API error:', error.message);
    return [];
  }
}

// ========== OPTIMIZED TRC20 CHECKING ==========
async function handleCheckTRC20Deposits() {
  try {
    console.log('🔄 Checking TRC20 deposits...');
    
    const { data: wallets, error } = await supabase
      .from('deposit_addresses')
      .select('*')
      .eq('network', 'trc20')
      .limit(100);

    if (error) throw error;

    let processedCount = 0;
    let depositsFound = 0;
    let duplicatesSkipped = 0;

    for (const wallet of wallets || []) {
      try {
        await sleep(TRC20_DELAY_MS);
        
        const transactions = await getTRC20Transactions(wallet.address);
        
        for (const tx of transactions) {
          if (tx.to === wallet.address && tx.token === 'USDT' && tx.amount >= MIN_DEPOSIT) {
            try {
              // Проверяем, не обрабатывалась ли уже эта транзакция
              const { data: existing } = await supabase
                .from('deposit_transactions')
                .select('id')
                .eq('tx_hash', tx.transaction_id)
                .eq('network', 'trc20')
                .maybeSingle();
              
              if (existing) {
                duplicatesSkipped++;
                console.log(`⏭️ Skipping duplicate TRC20 transaction: ${tx.transaction_id}`);
                continue;
              }
              
              const result = await processDeposit(wallet, tx.amount, tx.transaction_id, 'trc20');
              if (result.success) {
                depositsFound++;
                console.log(`💰 NEW TRC20 DEPOSIT: ${tx.amount} USDT for user ${wallet.user_id}`);
              }
            } catch (err) {
              if (err.message.includes('Duplicate deposit') || 
                  err.message.includes('already_processed') || 
                  (err.reason && err.reason === 'concurrent_processing')) {
                duplicatesSkipped++;
                console.log(`⏭️ Duplicate TRC20 deposit skipped: ${tx.transaction_id}`);
              } else {
                console.error(`❌ Error processing TRC20 deposit ${tx.transaction_id}:`, err.message);
              }
            }
          }
        }
        processedCount++;
      } catch (err) {
        console.error(`❌ Error processing TRC20 wallet ${wallet.address}:`, err.message);
      }
    }

    console.log(`✅ TRC20: Processed ${processedCount} wallets, found ${depositsFound} new deposits, skipped ${duplicatesSkipped} duplicates`);
    return { success: true, processed: processedCount, deposits: depositsFound, duplicates: duplicatesSkipped };
    
  } catch (error) {
    console.error('❌ TRC20 check error:', error.message);
    return { success: false, error: error.message };
  }
}

// ========== OPTIMIZED BEP20 CHECKING ==========
async function handleCheckBEP20Deposits() {
  try {
    console.log('🔄 Checking BEP20 deposits...');
    
    const { data: wallets, error } = await supabase
      .from('deposit_addresses')
      .select('*')
      .eq('network', 'bep20')
      .limit(100);

    if (error) throw error;

    let processedCount = 0;
    let depositsFound = 0;
    let duplicatesSkipped = 0;

    for (const wallet of wallets || []) {
      try {
        await sleep(BEP20_DELAY_MS);
        
        const transactions = await getBEP20Transactions(wallet.address);
        
        for (const tx of transactions) {
          if (tx.to.toLowerCase() === wallet.address.toLowerCase() && tx.token === 'USDT' && tx.amount >= MIN_DEPOSIT) {
            try {
              // Проверяем, не обрабатывалась ли уже эта транзакция
              const { data: existing } = await supabase
                .from('deposit_transactions')
                .select('id')
                .eq('tx_hash', tx.transaction_id)
                .eq('network', 'bep20')
                .maybeSingle();
              
              if (existing) {
                duplicatesSkipped++;
                console.log(`⏭️ Skipping duplicate BEP20 transaction: ${tx.transaction_id}`);
                continue;
              }
              
              const result = await processDeposit(wallet, tx.amount, tx.transaction_id, 'bep20');
              if (result.success) {
                depositsFound++;
                console.log(`💰 NEW BEP20 DEPOSIT: ${tx.amount} USDT for user ${wallet.user_id}`);
              }
            } catch (err) {
              if (err.message.includes('Duplicate deposit') || 
                  err.message.includes('already_processed') || 
                  (err.reason && err.reason === 'concurrent_processing')) {
                duplicatesSkipped++;
                console.log(`⏭️ Duplicate BEP20 deposit skipped: ${tx.transaction_id}`);
              } else {
                console.error(`❌ Error processing BEP20 deposit ${tx.transaction_id}:`, err.message);
              }
            }
          }
        }
        processedCount++;
      } catch (err) {
        console.error(`❌ Error processing BEP20 wallet ${wallet.address}:`, err.message);
      }
    }

    console.log(`✅ BEP20: Processed ${processedCount} wallets, found ${depositsFound} new deposits, skipped ${duplicatesSkipped} duplicates`);
    return { success: true, processed: processedCount, deposits: depositsFound, duplicates: duplicatesSkipped };
    
  } catch (error) {
    console.error('❌ BEP20 check error:', error.message);
    return { success: false, error: error.message };
  }
}

// ========== HELPER FUNCTIONS ==========
async function checkUserTRC20Deposits(userId) {
  try {
    const { data: wallet } = await supabase
      .from('deposit_addresses')
      .select('*')
      .eq('user_id', userId)
      .eq('network', 'trc20')
      .single();
    
    if (!wallet) return;
    
    const transactions = await getTRC20Transactions(wallet.address);
    
    for (const tx of transactions) {
      if (tx.to === wallet.address && tx.token === 'USDT' && tx.amount >= MIN_DEPOSIT) {
        try {
          // Проверяем дубликаты
          const { data: existing } = await supabase
            .from('deposit_transactions')
            .select('id')
            .eq('tx_hash', tx.transaction_id)
            .eq('network', 'trc20')
            .maybeSingle();
          
          if (existing) {
            console.log(`⏭️ Skipping duplicate TRC20 transaction for user ${userId}: ${tx.transaction_id}`);
            continue;
          }
          
          const result = await processDeposit(wallet, tx.amount, tx.transaction_id, 'trc20');
          if (result.success) {
            console.log(`💰 FOUND NEW TRC20 DEPOSIT: ${tx.amount} USDT for user ${userId}`);
          }
        } catch (err) {
          if (err.message.includes('already_processed') || err.reason === 'concurrent_processing') {
            console.log(`⏭️ Duplicate TRC20 deposit for user ${userId}: ${tx.transaction_id}`);
          } else {
            console.error(`❌ Error processing transaction ${tx.transaction_id}:`, err);
          }
        }
      }
    }
  } catch (error) {
    console.error('❌ checkUserTRC20Deposits error:', error);
  }
}

async function checkUserBEP20Deposits(userId) {
  try {
    const { data: wallet } = await supabase
      .from('deposit_addresses')
      .select('*')
      .eq('user_id', userId)
      .eq('network', 'bep20')
      .single();
    
    if (!wallet) return;
    
    const transactions = await getBEP20Transactions(wallet.address);
    
    for (const tx of transactions) {
      if (tx.to.toLowerCase() === wallet.address.toLowerCase() && tx.token === 'USDT' && tx.amount >= MIN_DEPOSIT) {
        try {
          // Проверяем дубликаты
          const { data: existing } = await supabase
            .from('deposit_transactions')
            .select('id')
            .eq('tx_hash', tx.transaction_id)
            .eq('network', 'bep20')
            .maybeSingle();
          
          if (existing) {
            console.log(`⏭️ Skipping duplicate BEP20 transaction for user ${userId}: ${tx.transaction_id}`);
            continue;
          }
          
          const result = await processDeposit(wallet, tx.amount, tx.transaction_id, 'bep20');
          if (result.success) {
            console.log(`💰 FOUND NEW BEP20 DEPOSIT: ${tx.amount} USDT for user ${userId}`);
          }
        } catch (err) {
          if (err.message.includes('already_processed') || err.reason === 'concurrent_processing') {
            console.log(`⏭️ Duplicate BEP20 deposit for user ${userId}: ${tx.transaction_id}`);
          } else {
            console.error(`❌ Error processing transaction ${tx.transaction_id}:`, err);
          }
        }
      }
    }
  } catch (error) {
    console.error('❌ checkUserBEP20Deposits error:', error);
  }
}

// ========== START SERVER ==========
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 HTTP SERVER RUNNING on port ${PORT}`);
  console.log(`✅ Health check available at: http://0.0.0.0:${PORT}/health`);
  console.log(`✅ API Health check: http://0.0.0.0:${PORT}/api/health`);
  console.log(`✅ SUPABASE: CONNECTED`);
  console.log(`✅ TRONGRID: API KEY SET`);
  console.log(`✅ MORALIS: API KEY SET`);
  console.log(`✅ TRC20: Checking every 45 seconds`);
  console.log(`✅ BEP20: Checking every 3 minutes`);
  console.log(`✅ ATOMIC DEPOSITS: ENABLED via PostgreSQL RPC`);
  console.log('===================================');
});

// ========== BACKGROUND TASKS ==========
let isCheckingTRC20 = false;
let isCheckingBEP20 = false;

// TRC20 Background Check (Fast)
setInterval(async () => {
  if (isCheckingTRC20) return;
  
  try {
    isCheckingTRC20 = true;
    await handleCheckTRC20Deposits();
  } catch (err) {
    console.error('❌ TRC20 auto-check error:', err.message);
  } finally {
    isCheckingTRC20 = false;
  }
}, TRC20_CHECK_INTERVAL);

// BEP20 Background Check (Optimized for DCU)
setInterval(async () => {
  if (isCheckingBEP20) return;
  
  try {
    isCheckingBEP20 = true;
    await handleCheckBEP20Deposits();
  } catch (err) {
    console.error('❌ BEP20 auto-check error:', err.message);
  } finally {
    isCheckingBEP20 = false;
  }
}, BEP20_CHECK_INTERVAL);

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Received SIGTERM, shutting down gracefully');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});
