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

// ========== ОТЛАДОЧНЫЕ ЭНДПОИНТЫ ДЛЯ ТРАССИРОВКИ ДЕНЕГ ==========

// 🔍 ДЕТАЛЬНАЯ ОТЛАДКА БАЛАНСОВ
app.get('/debug-money', async (req, res) => {
  try {
    console.log('💰 === ДЕТАЛЬНАЯ ОТЛАДКА ДЕНЕЖНЫХ ПОТОКОВ ===');
    
    const { data: wallets } = await supabase.from('user_wallets').select('*');
    const { data: deposits } = await supabase.from('deposits').select('*');
    const { data: collections } = await supabase.from('collections').select('*');

    const balanceInfo = [];
    let totalUserUSDT = 0;
    let totalUserTRX = 0;

    // Балансы пользовательских кошельков
    for (const wallet of wallets || []) {
      const usdtBalance = await getUSDTBalance(wallet.address);
      const trxBalance = await getTRXBalance(wallet.address);
      
      totalUserUSDT += usdtBalance;
      totalUserTRX += trxBalance;

      balanceInfo.push({
        user_id: wallet.user_id,
        address: wallet.address,
        usdt_balance: usdtBalance,
        trx_balance: trxBalance,
        last_checked: wallet.last_checked
      });
    }

    // Балансы основных кошельков
    const masterUSDT = await getUSDTBalance(COMPANY.MASTER.address);
    const masterTRX = await getTRXBalance(COMPANY.MASTER.address);
    const mainUSDT = await getUSDTBalance(COMPANY.MAIN.address);
    const mainTRX = await getTRXBalance(COMPANY.MAIN.address);

    // Суммы в базе данных
    const { data: users } = await supabase.from('users').select('balance, total_profit');
    const totalBalanceInDB = users?.reduce((sum, user) => sum + (user.balance || 0), 0) || 0;
    const totalProfitInDB = users?.reduce((sum, user) => sum + (user.total_profit || 0), 0) || 0;

    const debugInfo = {
      timestamp: new Date().toISOString(),
      
      // РЕАЛЬНЫЕ БАЛАНСЫ В БЛОКЧЕЙНЕ
      blockchain_balances: {
        user_wallets_total: {
          usdt: totalUserUSDT,
          trx: totalUserTRX,
          wallet_count: wallets?.length || 0
        },
        company_wallets: {
          master: {
            address: COMPANY.MASTER.address,
            usdt: masterUSDT,
            trx: masterTRX
          },
          main: {
            address: COMPANY.MAIN.address,
            usdt: mainUSDT,
            trx: mainTRX
          }
        },
        total_company_usdt: masterUSDT + mainUSDT,
        total_system_usdt: totalUserUSDT + masterUSDT + mainUSDT
      },

      // БАЛАНСЫ В БАЗЕ ДАННЫХ
      database_totals: {
        total_user_balance: totalBalanceInDB,
        total_user_profit: totalProfitInDB,
        total_deposits: deposits?.length || 0,
        total_collections: collections?.length || 0
      },

      // ДЕТАЛЬНАЯ ИНФОРМАЦИЯ
      user_wallets: balanceInfo,
      recent_deposits: deposits?.slice(-10) || [],
      recent_collections: collections?.slice(-10) || []
    };

    console.log('💵 ОТЧЕТ О ДЕНЕЖНЫХ ПОТОКАХ:');
    console.log(`👥 Пользовательские кошельки: ${totalUserUSDT} USDT, ${totalUserTRX} TRX`);
    console.log(`🏢 Компания: ${debugInfo.blockchain_balances.total_company_usdt} USDT`);
    console.log(`📊 База данных: ${totalBalanceInDB} USDT на балансах пользователей`);
    console.log(`📈 Всего депозитов: ${deposits?.length || 0}`);
    console.log(`🔄 Всего сборов: ${collections?.length || 0}`);

    res.json(debugInfo);

  } catch (error) {
    console.error('❌ Debug error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 🔍 ПРОВЕРКА ТРАНЗАКЦИЙ КОНКРЕТНОГО КОШЕЛЬКА
app.get('/debug-wallet/:address', async (req, res) => {
  try {
    const { address } = req.params;
    
    console.log(`🔍 Детальная проверка кошелька: ${address}`);
    
    const usdtBalance = await getUSDTBalance(address);
    const trxBalance = await getTRXBalance(address);
    const transactions = await getUSDTTransactions(address);
    
    // Ищем депозиты в базе
    const { data: deposits } = await supabase
      .from('deposits')
      .select('*')
      .eq('txid', transactions.map(tx => tx.transaction_id));

    const walletInfo = {
      address: address,
      balances: {
        usdt: usdtBalance,
        trx: trxBalance
      },
      transactions: transactions.map(tx => ({
        txid: tx.transaction_id,
        from: tx.from,
        to: tx.to,
        amount: tx.value / 1000000,
        confirmed: tx.confirmed,
        timestamp: tx.block_timestamp,
        symbol: tx.token_info?.symbol,
        in_database: deposits?.some(d => d.txid === tx.transaction_id) || false
      })),
      transaction_count: transactions.length
    };

    console.log(`📊 Кошелек ${address}:`);
    console.log(`   USDT: ${usdtBalance}, TRX: ${trxBalance}`);
    console.log(`   Транзакций: ${transactions.length}`);
    
    res.json(walletInfo);

  } catch (error) {
    console.error('❌ Wallet debug error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 🔍 РУЧНАЯ ПРОВЕРКА ДЕПОЗИТОВ
app.post('/debug-check-deposit', async (req, res) => {
  try {
    const { user_id } = req.body;
    
    if (!user_id) {
      return res.status(400).json({ error: 'User ID required' });
    }

    console.log(`🔍 Ручная проверка депозитов для пользователя: ${user_id}`);

    // Находим кошелек пользователя
    const { data: wallet } = await supabase
      .from('user_wallets')
      .select('*')
      .eq('user_id', user_id)
      .single();

    if (!wallet) {
      return res.status(404).json({ error: 'Wallet not found' });
    }

    const transactions = await getUSDTTransactions(wallet.address);
    console.log(`📊 Найдено транзакций: ${transactions.length} для ${wallet.address}`);

    const results = [];
    
    for (const tx of transactions) {
      const isUSDT = tx.token_info?.symbol === 'USDT' || 
                     tx.token_info?.address === 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
      const isToWallet = tx.to === wallet.address.toLowerCase();
      const isTransfer = tx.type === 'Transfer';
      const isConfirmed = tx.confirmed === true;
      
      if (isUSDT && isToWallet && isTransfer && isConfirmed) {
        const amount = tx.value / 1000000;
        
        // Проверяем в базе
        const { data: existingDeposit } = await supabase
          .from('deposits')
          .select('id')
          .eq('txid', tx.transaction_id)
          .maybeSingle();

        results.push({
          txid: tx.transaction_id,
          amount: amount,
          confirmed: isConfirmed,
          in_database: !!existingDeposit,
          status: existingDeposit ? '✅ Обработан' : '❌ Не обработан'
        });
      }
    }

    res.json({
      wallet: wallet.address,
      transactions_checked: transactions.length,
      valid_deposits: results,
      user_balance: await getUSDTBalance(wallet.address)
    });

  } catch (error) {
    console.error('❌ Manual check error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========== ОСНОВНЫЕ ФУНКЦИИ С ИСПРАВЛЕНИЯМИ ==========

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

    console.log(`✅ New wallet created: ${account.address.base58} for user ${user_id}`);

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

// ✅ Проверка депозитов (GET для cron jobs)
app.get('/check-deposits', async (req, res) => {
  await handleCheckDeposits(req, res);
});

// ✅ Общая функция проверки депозитов
async function handleCheckDeposits(req, res) {
  try {
    console.log('🔄 === STARTING DEPOSIT CHECK ===');
    
    const { data: wallets, error } = await supabase
      .from('user_wallets')
      .select('*');

    if (error) {
      throw new Error(`Wallets fetch error: ${error.message}`);
    }

    console.log(`🔍 Checking ${wallets?.length || 0} wallets`);
    let processedCount = 0;
    let totalDeposits = 0;

    for (const wallet of wallets || []) {
      try {
        console.log(`\n🔎 Checking wallet: ${wallet.address} (User: ${wallet.user_id})`);
        const transactions = await getUSDTTransactions(wallet.address);
        
        // ДЕТАЛЬНАЯ ФИЛЬТРАЦИЯ ТРАНЗАКЦИЙ
        const usdtTransactions = transactions.filter(tx => {
          const isUSDT = tx.token_info?.symbol === 'USDT' || 
                         tx.token_info?.address === 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
          const isToWallet = tx.to === wallet.address.toLowerCase();
          const isTransfer = tx.type === 'Transfer';
          const isConfirmed = tx.confirmed === true;
          
          const isValid = isUSDT && isToWallet && isTransfer && isConfirmed;
          
          if (isValid) {
            console.log(`✅ Valid USDT transaction found:`, {
              txid: tx.transaction_id,
              amount: tx.value / 1000000,
              from: tx.from,
              to: tx.to
            });
          }
          
          return isValid;
        });

        console.log(`💰 Found ${usdtTransactions.length} valid USDT transactions`);

        for (const tx of usdtTransactions) {
          const amount = tx.value / 1000000;
          console.log(`📊 Processing: ${tx.transaction_id}, Amount: ${amount} USDT`);

          if (amount < 30) {
            console.log(`❌ Deposit too small: ${amount} USDT (min: 30 USDT)`);
            continue;
          }

          // Проверяем, не обрабатывали ли мы уже эту транзакцию
          const { data: existingDeposit } = await supabase
            .from('deposits')
            .select('id, user_id, amount')
            .eq('txid', tx.transaction_id)
            .maybeSingle();

          if (!existingDeposit) {
            console.log(`🎯 NEW DEPOSIT DETECTED: ${amount} USDT to ${wallet.address}`);
            await processDeposit(wallet, amount, tx.transaction_id);
            processedCount++;
            totalDeposits += amount;
          } else {
            console.log(`⏭️ Deposit already processed: ${tx.transaction_id}`);
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

    console.log(`✅ DEPOSIT CHECK COMPLETE: Processed ${processedCount} deposits, Total: ${totalDeposits} USDT`);

    res.json({
      success: true,
      message: `✅ Processed ${processedCount} deposits (${totalDeposits} USDT) from ${wallets?.length || 0} wallets`
    });

  } catch (error) {
    console.error('❌ Deposit check error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

// ✅ Сбор средств (GET для cron jobs)
app.get('/collect-funds', async (req, res) => {
  await handleCollectFunds(req, res);
});

// ✅ Общая функция сбора средств
async function handleCollectFunds(req, res) {
  try {
    console.log('💰 === STARTING FUNDS COLLECTION ===');
    
    const { data: wallets, error } = await supabase
      .from('user_wallets')
      .select('*');

    if (error) {
      throw new Error(`Wallets fetch error: ${error.message}`);
    }

    let collectedCount = 0;
    let totalCollected = 0;
    let failedCount = 0;

    for (const wallet of wallets || []) {
      try {
        console.log(`\n🔍 Checking collection for: ${wallet.address}`);
        const success = await autoCollectToMainWallet(wallet);
        if (success) {
          collectedCount++;
          totalCollected += success.amount;
          console.log(`✅ Collected ${success.amount} USDT from ${wallet.address}`);
        } else {
          failedCount++;
        }
      } catch (error) {
        console.error(`❌ Error collecting from ${wallet.address}:`, error);
        failedCount++;
      }
    }

    console.log(`💰 COLLECTION COMPLETE: Collected ${totalCollected} USDT from ${collectedCount} wallets, Failed: ${failedCount}`);

    res.json({
      success: true,
      message: `✅ Collected ${totalCollected.toFixed(2)} USDT from ${collectedCount} wallets, Failed: ${failedCount}`
    });

  } catch (error) {
    console.error('❌ Funds collection error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

// ✅ Умный сбор средств
async function autoCollectToMainWallet(wallet) {
  try {
    const usdtBalance = await getUSDTBalance(wallet.address);
    console.log(`📊 ${wallet.address} USDT Balance: ${usdtBalance}`);
    
    // Оставляем 1 USDT на кошельке
    const amountToTransfer = usdtBalance - 1;
    
    if (amountToTransfer <= 0) {
      console.log(`⏭️ No funds to collect (balance: ${usdtBalance} USDT)`);
      return false;
    }

    console.log(`💸 Collecting ${amountToTransfer} USDT from ${wallet.address}`);

    const trxBalance = await getTRXBalance(wallet.address);
    console.log(`⛽ ${wallet.address} TRX Balance: ${trxBalance}`);
    
    // Если мало TRX для комиссии - отправляем с MASTER
    if (trxBalance < 10) {
      console.log(`⛽ Sending 15 TRX to ${wallet.address} for gas`);
      const trxSent = await sendTRX(COMPANY.MASTER.privateKey, wallet.address, 15);
      if (trxSent) {
        console.log(`✅ TRX sent successfully, waiting 10 seconds...`);
        await sleep(10000);
      } else {
        console.log(`❌ Failed to send TRX for gas`);
        return false;
      }
    }

    // Переводим USDT на MAIN кошелек
    console.log(`🔄 Transferring ${amountToTransfer} USDT to main wallet...`);
    const transferResult = await transferUSDT(wallet.private_key, COMPANY.MAIN.address, amountToTransfer);
    
    if (transferResult) {
      console.log(`✅ Successfully collected ${amountToTransfer} USDT from ${wallet.address}`);
      
      // Записываем сбор в базу
      await supabase
        .from('collections')
        .insert({
          wallet_address: wallet.address,
          user_id: wallet.user_id,
          amount: amountToTransfer,
          collected_to: COMPANY.MAIN.address,
          trx_used: await getTRXBalance(wallet.address),
          created_at: new Date().toISOString()
        });
      
      return { success: true, amount: amountToTransfer };
    } else {
      console.log(`❌ Failed to transfer USDT from ${wallet.address}`);
      return false;
    }

  } catch (error) {
    console.error(`❌ Collection error for ${wallet.address}:`, error);
    return false;
  }
}

// ✅ Обработка депозита
async function processDeposit(wallet, amount, txid) {
  try {
    console.log(`\n💰 PROCESSING DEPOSIT: ${amount} USDT for user ${wallet.user_id}`);

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
      const { error: updateError } = await supabase
        .from('users')
        .update({
          balance: newBalance,
          total_profit: newTotalProfit,
          updated_at: new Date().toISOString()
        })
        .eq('id', wallet.user_id);

      if (updateError) {
        throw new Error(`Failed to update user balance: ${updateError.message}`);
      }

      // Создаем запись о депозите
      const { error: depositError } = await supabase
        .from('deposits')
        .insert({
          user_id: wallet.user_id,
          wallet_address: wallet.address,
          amount: amount,
          txid: txid,
          status: 'confirmed',
          created_at: new Date().toISOString()
        });

      if (depositError) {
        throw new Error(`Failed to create deposit record: ${depositError.message}`);
      }

      // Создаем запись о транзакции
      await supabase
        .from('transactions')
        .insert({
          user_id: wallet.user_id,
          type: 'deposit',
          amount: amount,
          description: 'Автоматическое зачисление депозита',
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

      console.log(`✅ DEPOSIT PROCESSED: ${amount} USDT for user ${wallet.user_id}`);
      console.log(`   New balance: ${newBalance} USDT, New total profit: ${newTotalProfit} USDT`);

      // ЗАПУСКАЕМ АВТОМАТИЧЕСКИЙ СБОР СРЕДСТВ
      console.log(`🔄 Starting auto-collection after deposit...`);
      setTimeout(() => {
        autoCollectToMainWallet(wallet);
      }, 5000);

    } else {
      throw new Error('User not found after creation');
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
    console.error(`❌ USDT balance error for ${address}:`, error);
    return 0;
  }
}

async function getTRXBalance(address) {
  try {
    const balance = await tronWeb.trx.getBalance(address);
    return balance / 1000000;
  } catch (error) {
    console.error(`❌ TRX balance error for ${address}:`, error);
    return 0;
  }
}

async function getUSDTTransactions(address) {
  try {
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
    
    console.log(`🔄 Sending ${amount} USDT (${amountInSun} sun) from ${tronWebWithPrivateKey.address.fromPrivateKey(privateKey)} to ${toAddress}`);
    
    const result = await contract.transfer(toAddress, amountInSun).send();
    
    console.log(`✅ USDT transfer successful: ${amount} USDT, TX: ${result}`);
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
    
    console.log(`✅ TRX sent: ${amount} TRX from ${fromAddress} to ${toAddress}, TX: ${result}`);
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

      if (insertError && !insertError.message.includes('duplicate key')) {
        console.error('❌ Error creating user:', insertError);
      } else {
        console.log(`✅ User created: ${userId}`);
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
    timestamp: new Date().toISOString(),
    endpoints: {
      debug: '/debug-money',
      check_deposits: '/check-deposits', 
      collect_funds: '/collect-funds',
      debug_wallet: '/debug-wallet/:address',
      manual_check: 'POST /debug-check-deposit'
    }
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Supabase: ${SUPABASE_URL ? '✅ CONNECTED' : '❌ MISSING'}`);
  console.log(`🔑 TronGrid: ${TRONGRID_API_KEY ? '✅ SET' : '❌ MISSING'}`);
  console.log(`💰 MASTER Wallet: ${COMPANY.MASTER.address}`);
  console.log(`💰 MAIN Wallet: ${COMPANY.MAIN.address}`);
  console.log(`🔍 Debug endpoints available at: http://localhost:${PORT}/debug-money`);
});
