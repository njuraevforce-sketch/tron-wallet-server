const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const TronWeb = require('tronweb');

const app = express();
const PORT = process.env.PORT || 3000;

// Конфигурация
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://bpsmizhrzgfbjqfpqkcz.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
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

// ✅ Генерация кошелька
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

    // Генерируем новый кошелёк
    const account = TronWeb.utils.accounts.generateAccount();
    
    if (!account) {
      throw new Error('Failed to generate wallet');
    }

    // Сохраняем в базу данных
    const { data, error } = await supabase
      .from('user_wallets')
      .insert({
        user_id: user_id,
        address: account.address.base58,
        private_key: account.privateKey
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

    console.log(`✅ New wallet: ${account.address.base58}`);

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

// ✅ Проверка депозитов (POST для фронтенда)
app.post('/check-deposits', async (req, res) => {
  await handleCheckDeposits(req, res);
});

// ✅ Проверка депозитов (GET для cron jobs)
app.get('/check-deposits', async (req, res) => {
  await handleCheckDeposits(req, res);
});

// ✅ Общая функция проверки депозитов
async function handleCheckDeposits(req, res) {
  try {
    console.log('🔄 Starting deposit check...');
    
    const { data: wallets, error } = await supabase
      .from('user_wallets')
      .select('*')
      .lt('last_checked', new Date(Date.now() - 2 * 60 * 1000).toISOString())
      .limit(50);

    if (error) {
      throw new Error(`Wallets fetch error: ${error.message}`);
    }

    console.log(`🔍 Checking ${wallets?.length || 0} wallets`);
    let processedCount = 0;

    for (const wallet of wallets || []) {
      try {
        const transactions = await getUSDTTransactions(wallet.address);
        const usdtTransactions = transactions.filter(tx => 
          tx.token_info?.symbol === 'USDT' && 
          tx.to === wallet.address.toLowerCase() && 
          tx.type === 'Transfer' &&
          tx.confirmed === true
        );

        for (const tx of usdtTransactions) {
          const amount = tx.value / 1000000;

          if (amount < 30) {
            console.log(`❌ Deposit too small: ${amount} USDT`);
            continue;
          }

          // Проверяем, не обрабатывали ли мы уже эту транзакцию
          const { data: existingDeposit } = await supabase
            .from('deposits')
            .select('id')
            .eq('txid', tx.transaction_id)
            .maybeSingle();

          if (!existingDeposit) {
            console.log(`✅ New deposit: ${amount} USDT to ${wallet.address}`);
            await processDeposit(wallet, amount, tx.transaction_id);
            processedCount++;
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

    res.json({
      success: true,
      message: `✅ Processed ${processedCount} deposits from ${wallets?.length || 0} wallets`
    });

  } catch (error) {
    console.error('❌ Deposit check error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

// ✅ Сбор средств
app.post('/collect-funds', async (req, res) => {
  try {
    console.log('💰 Starting funds collection...');
    
    const { data: wallets, error } = await supabase
      .from('user_wallets')
      .select('*');

    if (error) {
      throw new Error(`Wallets fetch error: ${error.message}`);
    }

    let collectedCount = 0;
    let totalCollected = 0;

    for (const wallet of wallets || []) {
      try {
        const success = await autoCollectToMainWallet(wallet);
        if (success) {
          collectedCount++;
          totalCollected += success.amount;
        }
      } catch (error) {
        console.error(`❌ Error collecting from ${wallet.address}:`, error);
      }
    }

    res.json({
      success: true,
      message: `✅ Collected ${totalCollected.toFixed(2)} USDT from ${collectedCount} wallets`
    });

  } catch (error) {
    console.error('❌ Funds collection error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✅ Умный сбор средств
async function autoCollectToMainWallet(wallet) {
  try {
    const usdtBalance = await getUSDTBalance(wallet.address);
    
    // Оставляем 1 USDT на кошельке
    const amountToTransfer = usdtBalance - 1;
    
    if (amountToTransfer <= 0) {
      return false;
    }

    console.log(`💸 Collecting ${amountToTransfer} USDT from ${wallet.address}`);

    const trxBalance = await getTRXBalance(wallet.address);
    
    // Если мало TRX для комиссии - отправляем с MASTER
    if (trxBalance < 3) {
      console.log(`⛽ Sending 5 TRX to ${wallet.address} for gas`);
      const trxSent = await sendTRX(COMPANY.MASTER.privateKey, wallet.address, 5);
      if (trxSent) {
        await sleep(5000); // Ждем подтверждения TRX
      }
    }

    // Переводим USDT на MAIN кошелек
    const transferResult = await transferUSDT(wallet.private_key, COMPANY.MAIN.address, amountToTransfer);
    
    if (transferResult) {
      console.log(`✅ Successfully collected ${amountToTransfer} USDT`);
      return { success: true, amount: amountToTransfer };
    }

    return false;

  } catch (error) {
    console.error(`❌ Collection error:`, error);
    return false;
  }
}

// ✅ Обработка депозита
async function processDeposit(wallet, amount, txid) {
  try {
    console.log(`💰 Processing deposit: ${amount} USDT for user ${wallet.user_id}`);

    // Создаем пользователя если не существует
    await ensureUserExists(wallet.user_id);

    // Получаем текущий баланс пользователя
    const { data: user } = await supabase
      .from('users')
      .select('balance, total_profit, vip_level')
      .eq('id', wallet.user_id)
      .single();

    if (user) {
      const newBalance = (user.balance || 0) + amount;
      const newTotalProfit = (user.total_profit || 0) + amount;

      // Обновляем баланс пользователя
      await supabase
        .from('users')
        .update({
          balance: newBalance,
          total_profit: newTotalProfit
        })
        .eq('id', wallet.user_id);

      // Создаем запись о депозите
      await supabase
        .from('deposits')
        .insert({
          user_id: wallet.user_id,
          amount: amount,
          txid: txid,
          status: 'confirmed',
          created_at: new Date().toISOString()
        });

      // Создаем запись о транзакции
      await supabase
        .from('transactions')
        .insert({
          user_id: wallet.user_id,
          type: 'deposit',
          amount: amount,
          description: 'Автоматическое зачисление',
          status: 'completed',
          created_at: new Date().toISOString()
        });

      // Обновляем VIP уровень если нужно
      if (newBalance >= 30 && user.vip_level === 0) {
        await supabase
          .from('users')
          .update({ vip_level: 1 })
          .eq('id', wallet.user_id);
      }

      console.log(`✅ Deposit processed: ${amount} USDT for user ${wallet.user_id}`);

      // ЗАПУСКАЕМ АВТОМАТИЧЕСКИЙ СБОР СРЕДСТВ
      console.log(`🔄 Starting auto-collection...`);
      await autoCollectToMainWallet(wallet);
    }
  } catch (error) {
    console.error('❌ Error processing deposit:', error);
    throw error;
  }
}

// ========== TRON API ФУНКЦИИ ==========

async function getUSDTBalance(address) {
  try {
    const contract = await tronWeb.contract().at('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
    const balance = await contract.balanceOf(address).call();
    return balance / 1000000;
  } catch (error) {
    console.error(`❌ USDT balance error:`, error);
    return 0;
  }
}

async function getTRXBalance(address) {
  try {
    const balance = await tronWeb.trx.getBalance(address);
    return balance / 1000000;
  } catch (error) {
    console.error(`❌ TRX balance error:`, error);
    return 0;
  }
}

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
      throw new Error(`TronGrid API error: ${response.status}`);
    }

    const data = await response.json();
    return data.data || [];
  } catch (error) {
    console.error('❌ Transactions error:', error);
    return [];
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

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========

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
      }
    }
  } catch (error) {
    console.error('❌ ensureUserExists error:', error);
  }
}

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

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Supabase: ${SUPABASE_URL ? '✅ CONNECTED' : '❌ MISSING'}`);
  console.log(`🔑 TronGrid: ${TRONGRID_API_KEY ? '✅ SET' : '❌ MISSING'}`);
  console.log(`💰 MASTER Wallet: ${COMPANY.MASTER.address}`);
  console.log(`💰 MAIN Wallet: ${COMPANY.MAIN.address}`);
});
