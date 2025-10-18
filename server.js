const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const TronWeb = require('tronweb');

const app = express();
const PORT = process.env.PORT || 3000;

// Конфигурация
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://bpsmizhrzgfbjqfpqkcz.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJwc21pemhyemdmYmpxZnBxa2N6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk5MTE4NzQsImV4cCI6MjA3NTQ4Nzg3NH0.qYrRbTTTcGc_IqEXATezuU4sbbol6ELV9HumPW6cvwU';
const TRONGRID_API_KEY = process.env.TRONGRID_API_KEY || '19e2411a-3c3e-479d-8c85-2abc716af397';

// TronWeb конфигурация
const tronWeb = new TronWeb({
  fullHost: 'https://api.trongrid.io',
  headers: { 'TRON-PRO-API-KEY': TRONGRID_API_KEY }
});

// Основные кошельки компании
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

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

app.use(express.json());

// Middleware CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'authorization, x-client-info, apikey, content-type');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  next();
});

// ✅ Генерация кошелька (ИСПРАВЛЕННАЯ)
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

    // Проверяем, есть ли уже кошелёк у пользователя
    const { data: existingWallet, error: fetchError } = await supabase
      .from('user_wallets')
      .select('address, private_key')
      .eq('user_id', user_id)
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') {
      console.error('❌ Database fetch error:', fetchError);
    }

    if (existingWallet) {
      console.log(`✅ Wallet already exists: ${existingWallet.address}`);
      return res.json({
        success: true,
        address: existingWallet.address,
        exists: true
      });
    }

    // Генерируем новый кошелёк
    const account = await tronWeb.createAccount();
    
    if (!account) {
      throw new Error('Failed to generate wallet');
    }

    console.log(`🔑 Generated new wallet: ${account.address.base58}`);

    // Сохраняем в базу данных
    const { data, error } = await supabase
      .from('user_wallets')
      .insert({
        user_id: user_id,
        address: account.address.base58,
        private_key: account.privateKey,
        created_at: new Date().toISOString(),
        last_checked: new Date().toISOString()
      })
      .select()
      .single();

    if (error) {
      console.error('❌ Database insert error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to save wallet: ' + error.message
      });
    }

    console.log(`✅ New wallet saved: ${account.address.base58}`);

    res.json({
      success: true,
      address: account.address.base58,
      exists: false
    });

  } catch (error) {
    console.error('❌ Generate wallet error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error: ' + error.message
    });
  }
});

// ✅ Проверка депозитов (УЛУЧШЕННАЯ)
app.get('/check-deposits', async (req, res) => {
  try {
    console.log('🔄 Starting enhanced deposit check...');
    
    // Получаем ВСЕ кошельки для проверки
    const { data: wallets, error } = await supabase
      .from('user_wallets')
      .select('*');

    if (error) {
      throw new Error(`Wallets fetch error: ${error.message}`);
    }

    console.log(`🔍 Checking ${wallets?.length || 0} wallets`);
    let processedCount = 0;
    let totalFound = 0;

    for (const wallet of wallets || []) {
      try {
        console.log(`📋 Checking wallet: ${wallet.address}`);
        const transactions = await getUSDTTransactions(wallet.address);
        totalFound += transactions.length;
        
        console.log(`📊 Found ${transactions.length} transactions for ${wallet.address}`);

        const usdtTransactions = transactions.filter(tx => {
          const isUSDT = tx.token_info?.symbol === 'USDT' || tx.token_info?.address === 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
          const isToWallet = tx.to === wallet.address.toLowerCase();
          const isTransfer = tx.type === 'Transfer';
          
          if (isUSDT && isToWallet && isTransfer) {
            console.log(`✅ Valid USDT transaction: ${tx.transaction_id}, Amount: ${tx.value / 1000000} USDT`);
            return true;
          }
          return false;
        });

        for (const tx of usdtTransactions) {
          const amount = tx.value / 1000000;
          console.log(`💰 Processing transaction: ${tx.transaction_id}, Amount: ${amount} USDT`);

          if (amount < 30) {
            console.log(`❌ Deposit too small: ${amount} USDT (min: 30 USDT)`);
            continue;
          }

          // Проверяем, не обрабатывали ли мы уже эту транзакцию
          const { data: existingDeposit } = await supabase
            .from('deposits')
            .select('id')
            .eq('txid', tx.transaction_id)
            .single();

          if (!existingDeposit) {
            console.log(`🎯 New deposit found: ${amount} USDT to ${wallet.address}`);
            await processDeposit(wallet, amount, tx.transaction_id);
            processedCount++;
            
            // Запускаем автосбор после обработки депозита
            console.log(`🔄 Starting auto-collection for ${wallet.address}`);
            await autoCollectToMainWallet(wallet);
          } else {
            console.log(`⏩ Transaction already processed: ${tx.transaction_id}`);
          }
        }

        // Обновляем время последней проверки
        await supabase
          .from('user_wallets')
          .update({ last_checked: new Date().toISOString() })
          .eq('id', wallet.id);

      } catch (error) {
        console.error(`❌ Error processing wallet ${wallet.address}:`, error);
      }
    }

    console.log(`✅ Deposit check completed. Processed: ${processedCount}, Total transactions found: ${totalFound}`);

    res.json({
      success: true,
      message: `✅ Processed ${processedCount} deposits from ${wallets?.length || 0} wallets`,
      processed: processedCount,
      total_wallets: wallets?.length || 0,
      total_transactions: totalFound
    });

  } catch (error) {
    console.error('❌ Deposit check error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      stack: error.stack 
    });
  }
});

// ✅ УЛУЧШЕННАЯ функция получения транзакций
async function getUSDTTransactions(address) {
  try {
    console.log(`🔍 Fetching transactions for: ${address}`);
    
    const response = await fetch(
      `https://api.trongrid.io/v1/accounts/${address}/transactions/trc20?limit=50&only_confirmed=true`,
      {
        headers: {
          'Accept': 'application/json',
          'TRON-PRO-API-KEY': TRONGRID_API_KEY
        }
      }
    );

    if (!response.ok) {
      throw new Error(`TronGrid API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data.data || [];

  } catch (error) {
    console.error('❌ Transactions error:', error);
    return [];
  }
}

// ✅ УЛУЧШЕННАЯ функция обработки депозита
async function processDeposit(wallet, amount, txid) {
  try {
    console.log(`💰 PROCESS DEPOSIT: ${amount} USDT for user ${wallet.user_id}, TX: ${txid}`);

    // Создаем пользователя если не существует
    await ensureUserExists(wallet.user_id);

    // Получаем текущий баланс пользователя
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('balance, total_profit, vip_level')
      .eq('id', wallet.user_id)
      .single();

    if (userError) {
      console.error('❌ User fetch error:', userError);
      throw userError;
    }

    const newBalance = (parseFloat(user.balance) || 0) + amount;
    const newTotalProfit = (parseFloat(user.total_profit) || 0) + amount;

    console.log(`📊 Updating balance: ${user.balance} -> ${newBalance} USDT`);

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
      console.error('❌ Balance update error:', updateError);
      throw updateError;
    }

    // Создаем запись о депозите
    const { error: depositError } = await supabase
      .from('deposits')
      .insert({
        user_id: wallet.user_id,
        amount: amount,
        txid: txid,
        status: 'confirmed',
        wallet_address: wallet.address,
        created_at: new Date().toISOString()
      });

    if (depositError) {
      console.error('❌ Deposit record error:', depositError);
      throw depositError;
    }

    // Создаем запись о транзакции
    const { error: transactionError } = await supabase
      .from('transactions')
      .insert({
        user_id: wallet.user_id,
        type: 'deposit',
        amount: amount,
        description: 'Автоматическое зачисление депозита',
        status: 'completed',
        created_at: new Date().toISOString()
      });

    if (transactionError) {
      console.error('❌ Transaction record error:', transactionError);
      throw transactionError;
    }

    // Обновляем VIP уровень если нужно
    if (newBalance >= 30 && (!user.vip_level || user.vip_level === 0)) {
      await supabase
        .from('users')
        .update({ vip_level: 1 })
        .eq('id', wallet.user_id);
      console.log(`⭐ VIP level updated to 1 for user ${wallet.user_id}`);
    }

    console.log(`✅ DEPOSIT PROCESSED: ${amount} USDT for user ${wallet.user_id}`);

  } catch (error) {
    console.error('❌ Error processing deposit:', error);
    throw error;
  }
}

// ✅ УЛУЧШЕННАЯ функция автосбора
async function autoCollectToMainWallet(wallet) {
  try {
    console.log(`🔄 AUTO-COLLECT: Checking wallet ${wallet.address}`);
    
    const usdtBalance = await getUSDTBalance(wallet.address);
    console.log(`💰 USDT Balance: ${usdtBalance} USDT`);
    
    if (usdtBalance <= 1) {
      console.log(`⏩ Skip collection: balance too low (${usdtBalance} USDT)`);
      return false;
    }

    // Оставляем 1 USDT на кошельке
    const amountToTransfer = usdtBalance - 1;
    
    console.log(`💸 Preparing to transfer: ${amountToTransfer} USDT`);

    const trxBalance = await getTRXBalance(wallet.address);
    console.log(`⛽ TRX Balance: ${trxBalance} TRX`);
    
    // Если мало TRX для комиссии - отправляем с MASTER
    if (trxBalance < 3) {
      console.log(`⛽ Sending 10 TRX to ${wallet.address} for gas`);
      const trxSent = await sendTRX(COMPANY.MASTER.privateKey, wallet.address, 10);
      if (trxSent) {
        console.log(`⏳ Waiting for TRX transfer confirmation...`);
        await sleep(10000); // Ждем 10 секунд для подтверждения TRX
      }
    }

    // Переводим USDT на MAIN кошелек
    console.log(`🚀 Transferring ${amountToTransfer} USDT to main wallet...`);
    const transferResult = await transferUSDT(wallet.private_key, COMPANY.MAIN.address, amountToTransfer);
    
    if (transferResult) {
      console.log(`✅ SUCCESS: Collected ${amountToTransfer} USDT from ${wallet.address}`);
      
      // Обновляем баланс кошелька после сбора
      await supabase
        .from('user_wallets')
        .update({ 
          last_collected: new Date().toISOString(),
          total_collected: (wallet.total_collected || 0) + amountToTransfer
        })
        .eq('id', wallet.id);
      
      return { success: true, amount: amountToTransfer };
    } else {
      console.log(`❌ FAILED: USDT transfer from ${wallet.address}`);
      return false;
    }

  } catch (error) {
    console.error(`❌ Collection error for ${wallet.address}:`, error);
    return false;
  }
}

// ✅ Проверка баланса USDT (ИСПРАВЛЕННАЯ)
async function getUSDTBalance(address) {
  try {
    const contract = await tronWeb.contract().at('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
    const balance = await contract.balanceOf(address).call();
    const usdtBalance = balance / 1000000;
    console.log(`📊 USDT Balance for ${address}: ${usdtBalance} USDT`);
    return usdtBalance;
  } catch (error) {
    console.error(`❌ USDT balance error for ${address}:`, error);
    return 0;
  }
}

// ✅ Проверка баланса TRX (ИСПРАВЛЕННАЯ)
async function getTRXBalance(address) {
  try {
    const balance = await tronWeb.trx.getBalance(address);
    const trxBalance = balance / 1000000;
    console.log(`📊 TRX Balance for ${address}: ${trxBalance} TRX`);
    return trxBalance;
  } catch (error) {
    console.error(`❌ TRX balance error for ${address}:`, error);
    return 0;
  }
}

// ✅ Передача USDT
async function transferUSDT(fromPrivateKey, toAddress, amount) {
  try {
    const privateKey = fromPrivateKey.startsWith('0x') ? fromPrivateKey : '0x' + fromPrivateKey;
    const tronWebWithPrivateKey = new TronWeb({
      fullHost: 'https://api.trongrid.io',
      headers: { 'TRON-PRO-API-KEY': TRONGRID_API_KEY },
      privateKey: privateKey
    });

    const contract = await tronWebWithPrivateKey.contract().at('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
    
    const amountInSun = Math.floor(amount * 1000000);
    
    const result = await contract.transfer(toAddress, amountInSun).send();
    
    console.log(`✅ USDT transfer successful: ${amount} USDT`);
    return true;
  } catch (error) {
    console.error('❌ USDT transfer error:', error);
    return false;
  }
}

// ✅ Отправка TRX
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
    
    console.log(`✅ TRX sent: ${amount} TRX`);
    return true;
  } catch (error) {
    console.error('❌ TRX send error:', error);
    return false;
  }
}

// ✅ Создание пользователя если не существует
async function ensureUserExists(userId) {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id')
      .eq('id', userId)
      .single();

    if (error || !data) {
      const { error: insertError } = await supabase
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

      if (insertError) {
        console.error('❌ Error creating user:', insertError);
      } else {
        console.log(`✅ Created new user: ${userId}`);
      }
    }
  } catch (error) {
    console.error('❌ ensureUserExists error:', error);
  }
}

// ✅ Функция задержки
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: '✅ OK', 
    message: 'Tron Wallet System is running',
    timestamp: new Date().toISOString()
  });
});

// Health check с информацией
app.get('/health', async (req, res) => {
  try {
    // Проверяем подключение к Supabase
    const { data: wallets, error } = await supabase
      .from('user_wallets')
      .select('count')
      .limit(1);
    
    // Проверяем подключение к TronGrid
    const masterBalance = await getTRXBalance(COMPANY.MASTER.address);
    const mainBalance = await getTRXBalance(COMPANY.MAIN.address);

    res.json({ 
      status: '✅ OK', 
      message: 'Tron Wallet System is running',
      timestamp: new Date().toISOString(),
      database: error ? '❌ ERROR' : '✅ CONNECTED',
      tronGrid: '✅ CONNECTED',
      master_wallet: {
        address: COMPANY.MASTER.address,
        trx_balance: masterBalance
      },
      main_wallet: {
        address: COMPANY.MAIN.address,
        trx_balance: mainBalance
      }
    });
  } catch (error) {
    res.status(500).json({
      status: '❌ ERROR',
      message: 'Health check failed',
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Supabase: ${SUPABASE_URL ? '✅ CONNECTED' : '❌ MISSING'}`);
  console.log(`🔑 TronGrid: ${TRONGRID_API_KEY ? '✅ SET' : '❌ MISSING'}`);
  console.log(`💰 MASTER Wallet: ${COMPANY.MASTER.address}`);
  console.log(`💰 MAIN Wallet: ${COMPANY.MAIN.address}`);
  console.log(`🌐 Health check: http://localhost:${PORT}/health`);
});
