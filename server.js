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

// USDT контракт
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

app.use(express.json());

// Middleware CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'authorization, x-client-info, apikey, content-type');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  next();
});

// ========== ФУНКЦИИ ВОССТАНОВЛЕНИЯ ДЕНЕГ ==========

// 🔄 ВОССТАНОВЛЕНИЕ ВСЕХ ПРОПУЩЕННЫХ ДЕПОЗИТОВ
app.post('/recover-deposits', async (req, res) => {
  try {
    console.log('🔄 === ВОССТАНОВЛЕНИЕ ПРОПУЩЕННЫХ ДЕПОЗИТОВ ===');
    
    const { data: wallets, error } = await supabase
      .from('user_wallets')
      .select('*');

    if (error) throw error;

    let recoveredCount = 0;
    let totalRecovered = 0;
    const recoveryResults = [];

    for (const wallet of wallets || []) {
      try {
        console.log(`\n🔍 Проверка кошелька: ${wallet.address}`);
        
        const currentUSDTBalance = await getUSDTBalance(wallet.address);
        console.log(`💰 Текущий баланс USDT: ${currentUSDTBalance}`);
        
        if (currentUSDTBalance > 0) {
          // Получаем историю транзакций для поиска пропущенных депозитов
          const transactions = await getUSDTTransactions(wallet.address);
          const depositTransactions = transactions.filter(tx => 
            tx.to === wallet.address.toLowerCase() && 
            (tx.token_info?.symbol === 'USDT' || tx.token_info?.address === USDT_CONTRACT) &&
            tx.type === 'Transfer' &&
            tx.confirmed === true
          );

          console.log(`📊 Найдено транзакций: ${depositTransactions.length}`);

          for (const tx of depositTransactions) {
            const amount = tx.value / 1000000;
            
            // Проверяем, обработана ли уже эта транзакция
            const { data: existingDeposit } = await supabase
              .from('deposits')
              .select('id')
              .eq('txid', tx.transaction_id)
              .single();

            if (!existingDeposit && amount >= 30) {
              console.log(`🎯 ВОССТАНАВЛИВАЕМ ПРОПУЩЕННЫЙ ДЕПОЗИТ: ${amount} USDT`);
              
              await processDeposit(wallet, amount, tx.transaction_id);
              recoveredCount++;
              totalRecovered += amount;
              
              recoveryResults.push({
                wallet: wallet.address,
                user_id: wallet.user_id,
                amount: amount,
                txid: tx.transaction_id,
                status: '✅ Восстановлен'
              });
            }
          }
        }

      } catch (error) {
        console.error(`❌ Ошибка восстановления для ${wallet.address}:`, error);
        recoveryResults.push({
          wallet: wallet.address,
          error: error.message,
          status: '❌ Ошибка'
        });
      }
    }

    console.log(`✅ ВОССТАНОВЛЕНИЕ ЗАВЕРШЕНО: ${recoveredCount} депозитов, ${totalRecovered} USDT`);

    res.json({
      success: true,
      message: `✅ Восстановлено ${recoveredCount} депозитов (${totalRecovered} USDT)`,
      results: recoveryResults,
      summary: {
        recovered_count: recoveredCount,
        total_recovered: totalRecovered,
        checked_wallets: wallets?.length || 0
      }
    });

  } catch (error) {
    console.error('❌ Recovery error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 💰 ПРИНУДИТЕЛЬНЫЙ СБОР ВСЕХ СРЕДСТВ
app.post('/force-collect-all', async (req, res) => {
  try {
    console.log('💰 === ПРИНУДИТЕЛЬНЫЙ СБОР ВСЕХ СРЕДСТВ ===');
    
    const { data: wallets, error } = await supabase
      .from('user_wallets')
      .select('*');

    if (error) throw error;

    let collectedCount = 0;
    let totalCollected = 0;
    const collectionResults = [];

    for (const wallet of wallets || []) {
      try {
        console.log(`\n🔍 Сбор с кошелька: ${wallet.address}`);
        
        const usdtBalance = await getUSDTBalance(wallet.address);
        console.log(`💰 Баланс: ${usdtBalance} USDT`);
        
        if (usdtBalance > 1) {
          const amountToTransfer = usdtBalance - 1;
          
          // Проверяем TRX баланс
          const trxBalance = await getTRXBalance(wallet.address);
          console.log(`⛽ TRX баланс: ${trxBalance}`);
          
          if (trxBalance < 10) {
            console.log(`⛽ Отправляем TRX для газа...`);
            const trxSent = await sendTRXFromMaster(wallet.address, 15);
            if (trxSent) {
              console.log(`✅ TRX отправлен, ждем 15 секунд...`);
              await sleep(15000);
            }
          }

          // Переводим USDT
          console.log(`🔄 Переводим ${amountToTransfer} USDT...`);
          const transferResult = await transferUSDT(wallet.private_key, COMPANY.MAIN.address, amountToTransfer);
          
          if (transferResult) {
            collectedCount++;
            totalCollected += amountToTransfer;
            
            collectionResults.push({
              wallet: wallet.address,
              amount: amountToTransfer,
              status: '✅ Собрано'
            });
            
            console.log(`✅ Успешно собрано: ${amountToTransfer} USDT`);
            
            // Записываем в базу
            await supabase
              .from('collections')
              .insert({
                wallet_address: wallet.address,
                user_id: wallet.user_id,
                amount: amountToTransfer,
                collected_to: COMPANY.MAIN.address,
                created_at: new Date().toISOString()
              });
          } else {
            collectionResults.push({
              wallet: wallet.address,
              amount: amountToTransfer,
              status: '❌ Ошибка перевода'
            });
          }
        } else {
          console.log(`⏭️ Недостаточно средств для сбора: ${usdtBalance} USDT`);
          collectionResults.push({
            wallet: wallet.address,
            amount: usdtBalance,
            status: '⏭️ Недостаточно средств'
          });
        }

      } catch (error) {
        console.error(`❌ Ошибка сбора с ${wallet.address}:`, error);
        collectionResults.push({
          wallet: wallet.address,
          error: error.message,
          status: '❌ Ошибка'
        });
      }
    }

    console.log(`💰 СБОР ЗАВЕРШЕН: Собрано ${totalCollected} USDT с ${collectedCount} кошельков`);

    res.json({
      success: true,
      message: `✅ Собрано ${totalCollected.toFixed(2)} USDT с ${collectedCount} кошельков`,
      results: collectionResults,
      summary: {
        collected_count: collectedCount,
        total_collected: totalCollected,
        checked_wallets: wallets?.length || 0
      }
    });

  } catch (error) {
    console.error('❌ Force collection error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 👤 ВОССТАНОВЛЕНИЕ КОНКРЕТНОГО ПОЛЬЗОВАТЕЛЯ
app.post('/recover-user/:user_id', async (req, res) => {
  try {
    const { user_id } = req.params;
    
    console.log(`🔍 Восстановление пользователя: ${user_id}`);

    // Находим кошелек пользователя
    const { data: wallet, error } = await supabase
      .from('user_wallets')
      .select('*')
      .eq('user_id', user_id)
      .single();

    if (error || !wallet) {
      return res.status(404).json({ success: false, error: 'Кошелек не найден' });
    }

    const recoveryResults = [];
    let recoveredAmount = 0;

    // Проверяем пропущенные депозиты
    const transactions = await getUSDTTransactions(wallet.address);
    const depositTransactions = transactions.filter(tx => 
      tx.to === wallet.address.toLowerCase() && 
      (tx.token_info?.symbol === 'USDT' || tx.token_info?.address === USDT_CONTRACT) &&
      tx.type === 'Transfer' &&
      tx.confirmed === true
    );

    console.log(`📊 Найдено транзакций: ${depositTransactions.length}`);

    for (const tx of depositTransactions) {
      const amount = tx.value / 1000000;
      
      const { data: existingDeposit } = await supabase
        .from('deposits')
        .select('id')
        .eq('txid', tx.transaction_id)
        .single();

      if (!existingDeposit && amount >= 30) {
        console.log(`🎯 Восстанавливаем депозит: ${amount} USDT`);
        
        await processDeposit(wallet, amount, tx.transaction_id);
        recoveredAmount += amount;
        
        recoveryResults.push({
          action: 'deposit_recovery',
          amount: amount,
          txid: tx.transaction_id,
          status: '✅ Восстановлен'
        });
      }
    }

    // Собираем средства после восстановления
    const usdtBalance = await getUSDTBalance(wallet.address);
    if (usdtBalance > 1) {
      const amountToTransfer = usdtBalance - 1;
      
      console.log(`💰 Собираем средства: ${amountToTransfer} USDT`);
      
      // Проверяем TRX
      const trxBalance = await getTRXBalance(wallet.address);
      if (trxBalance < 10) {
        await sendTRXFromMaster(wallet.address, 15);
        await sleep(15000);
      }
      
      const transferResult = await transferUSDT(wallet.private_key, COMPANY.MAIN.address, amountToTransfer);
      
      if (transferResult) {
        recoveryResults.push({
          action: 'collection',
          amount: amountToTransfer,
          status: '✅ Собрано'
        });
        
        await supabase
          .from('collections')
          .insert({
            wallet_address: wallet.address,
            user_id: wallet.user_id,
            amount: amountToTransfer,
            collected_to: COMPANY.MAIN.address,
            created_at: new Date().toISOString()
          });
      } else {
        recoveryResults.push({
          action: 'collection',
          amount: amountToTransfer,
          status: '❌ Ошибка сбора'
        });
      }
    }

    res.json({
      success: true,
      message: `✅ Восстановление завершено для пользователя ${user_id}`,
      wallet: wallet.address,
      recovered_deposits: recoveredAmount,
      results: recoveryResults
    });

  } catch (error) {
    console.error('❌ User recovery error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 🔍 ПРОВЕРКА СТАТУСА MASTER КОШЕЛЬКА
app.get('/check-master', async (req, res) => {
  try {
    const masterUSDT = await getUSDTBalance(COMPANY.MASTER.address);
    const masterTRX = await getTRXBalance(COMPANY.MASTER.address);
    const mainUSDT = await getUSDTBalance(COMPANY.MAIN.address);

    const masterTransactions = await getUSDTTransactions(COMPANY.MASTER.address);
    const mainTransactions = await getUSDTTransactions(COMPANY.MAIN.address);

    res.json({
      master_wallet: {
        address: COMPANY.MASTER.address,
        usdt_balance: masterUSDT,
        trx_balance: masterTRX,
        transactions_count: masterTransactions.length
      },
      main_wallet: {
        address: COMPANY.MAIN.address,
        usdt_balance: mainUSDT,
        transactions_count: mainTransactions.length
      },
      status: masterTRX > 10 ? '✅ Готов к работе' : '❌ Нужно пополнить TRX'
    });

  } catch (error) {
    console.error('❌ Check master error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== ОСНОВНЫЕ ФУНКЦИИ ==========

// ✅ Генерация кошелька
app.post('/generate-wallet', async (req, res) => {
  try {
    const { user_id } = req.body;
    
    if (!user_id) {
      return res.status(400).json({ success: false, error: 'User ID is required' });
    }

    console.log(`🔐 Generating wallet for user: ${user_id}`);

    const { data: existingWallet } = await supabase
      .from('user_wallets')
      .select('address')
      .eq('user_id', user_id)
      .single();

    if (existingWallet) {
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

    if (error) throw error;

    console.log(`✅ New wallet: ${account.address.base58}`);

    res.json({
      success: true,
      address: account.address.base58,
      exists: false
    });

  } catch (error) {
    console.error('❌ Generate wallet error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✅ Проверка депозитов
app.get('/check-deposits', async (req, res) => {
  try {
    console.log('🔄 === STARTING DEPOSIT CHECK ===');
    
    const { data: wallets, error } = await supabase
      .from('user_wallets')
      .select('*');

    if (error) throw error;

    console.log(`🔍 Checking ${wallets?.length || 0} wallets`);
    let processedCount = 0;

    for (const wallet of wallets || []) {
      try {
        console.log(`\n🔎 Checking wallet: ${wallet.address}`);
        
        const currentUSDTBalance = await getUSDTBalance(wallet.address);
        console.log(`💰 Current USDT balance: ${currentUSDTBalance}`);
        
        if (currentUSDTBalance > 0) {
          const { data: user } = await supabase
            .from('users')
            .select('balance')
            .eq('id', wallet.user_id)
            .single();
            
          const lastKnownBalance = user?.balance || 0;
          
          if (currentUSDTBalance > lastKnownBalance) {
            const depositAmount = currentUSDTBalance - lastKnownBalance;
            
            if (depositAmount >= 30) {
              console.log(`🎯 DETECTED DEPOSIT: ${depositAmount} USDT for user ${wallet.user_id}`);
              
              const transactions = await getUSDTTransactions(wallet.address);
              const recentDepositTx = transactions.find(tx => 
                tx.to === wallet.address.toLowerCase() && 
                (tx.token_info?.symbol === 'USDT' || tx.token_info?.address === USDT_CONTRACT) &&
                tx.type === 'Transfer' &&
                tx.confirmed === true
              );
              
              const txid = recentDepositTx?.transaction_id || `manual_${Date.now()}`;
              
              await processDeposit(wallet, depositAmount, txid);
              processedCount++;
            }
          }
        }

        await supabase
          .from('user_wallets')
          .update({ last_checked: new Date().toISOString() })
          .eq('id', wallet.id);

      } catch (error) {
        console.error(`❌ Error processing wallet ${wallet.address}:`, error);
      }
    }

    console.log(`✅ DEPOSIT CHECK COMPLETE: Processed ${processedCount} deposits`);

    res.json({
      success: true,
      message: `✅ Processed ${processedCount} deposits from ${wallets?.length || 0} wallets`
    });

  } catch (error) {
    console.error('❌ Deposit check error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✅ Сбор средств
app.get('/collect-funds', async (req, res) => {
  try {
    console.log('💰 === STARTING FUNDS COLLECTION ===');
    
    const { data: wallets, error } = await supabase
      .from('user_wallets')
      .select('*');

    if (error) throw error;

    let collectedCount = 0;
    let totalCollected = 0;

    for (const wallet of wallets || []) {
      try {
        console.log(`\n🔍 Checking collection for: ${wallet.address}`);
        const result = await collectFundsFromWallet(wallet);
        
        if (result.success) {
          collectedCount++;
          totalCollected += result.amount;
          console.log(`✅ Collected ${result.amount} USDT from ${wallet.address}`);
        }
      } catch (error) {
        console.error(`❌ Error collecting from ${wallet.address}:`, error);
      }
    }

    console.log(`💰 COLLECTION COMPLETE: ${totalCollected} USDT from ${collectedCount} wallets`);

    res.json({
      success: true,
      message: `✅ Collected ${totalCollected.toFixed(2)} USDT from ${collectedCount} wallets`
    });

  } catch (error) {
    console.error('❌ Funds collection error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========

async function collectFundsFromWallet(wallet) {
  try {
    const usdtBalance = await getUSDTBalance(wallet.address);
    console.log(`📊 ${wallet.address} USDT Balance: ${usdtBalance}`);
    
    if (usdtBalance <= 1) {
      console.log(`⏭️ No funds to collect (balance: ${usdtBalance} USDT)`);
      return { success: false, amount: 0 };
    }

    const amountToTransfer = usdtBalance - 1;
    console.log(`💸 Collecting ${amountToTransfer} USDT from ${wallet.address}`);

    const trxBalance = await getTRXBalance(wallet.address);
    console.log(`⛽ ${wallet.address} TRX Balance: ${trxBalance}`);
    
    if (trxBalance < 15) {
      console.log(`⛽ Sending TRX to ${wallet.address} for gas...`);
      const trxSent = await sendTRXFromMaster(wallet.address, 20);
      if (!trxSent) {
        console.log(`❌ Failed to send TRX for gas`);
        return { success: false, amount: 0 };
      }
      console.log(`✅ TRX sent, waiting 15 seconds...`);
      await sleep(15000);
    }

    console.log(`🔄 Transferring ${amountToTransfer} USDT...`);
    const transferResult = await transferUSDT(wallet.private_key, COMPANY.MAIN.address, amountToTransfer);
    
    if (transferResult) {
      console.log(`✅ Successfully collected ${amountToTransfer} USDT`);
      
      await supabase
        .from('collections')
        .insert({
          wallet_address: wallet.address,
          user_id: wallet.user_id,
          amount: amountToTransfer,
          collected_to: COMPANY.MAIN.address,
          created_at: new Date().toISOString()
        });
      
      return { success: true, amount: amountToTransfer };
    } else {
      console.log(`❌ Failed to transfer USDT`);
      return { success: false, amount: 0 };
    }

  } catch (error) {
    console.error(`❌ Collection error:`, error);
    return { success: false, amount: 0 };
  }
}

async function processDeposit(wallet, amount, txid) {
  try {
    console.log(`\n💰 PROCESSING DEPOSIT: ${amount} USDT for user ${wallet.user_id}`);

    await ensureUserExists(wallet.user_id);

    const { data: user } = await supabase
      .from('users')
      .select('balance, total_profit, vip_level')
      .eq('id', wallet.user_id)
      .single();

    if (!user) throw new Error('User not found');

    const newBalance = (user.balance || 0) + amount;
    const newTotalProfit = (user.total_profit || 0) + amount;

    const { error: updateError } = await supabase
      .from('users')
      .update({
        balance: newBalance,
        total_profit: newTotalProfit,
        updated_at: new Date().toISOString()
      })
      .eq('id', wallet.user_id);

    if (updateError) throw updateError;

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

    if (depositError) throw depositError;

    await supabase
      .from('transactions')
      .insert({
        user_id: wallet.user_id,
        type: 'deposit',
        amount: amount,
        description: 'Депозит USDT',
        status: 'completed',
        created_at: new Date().toISOString()
      });

    console.log(`✅ DEPOSIT PROCESSED: ${amount} USDT for user ${wallet.user_id}`);
    console.log(`   New balance: ${newBalance} USDT`);

    console.log(`🔄 Scheduling auto-collection in 10 seconds...`);
    setTimeout(async () => {
      try {
        await collectFundsFromWallet(wallet);
      } catch (error) {
        console.error('❌ Auto-collection error:', error);
      }
    }, 10000);

  } catch (error) {
    console.error('❌ Error processing deposit:', error);
    throw error;
  }
}

// ========== TRON API ФУНКЦИИ ==========

async function getUSDTBalance(address) {
  try {
    const contract = await tronWeb.contract().at(USDT_CONTRACT);
    const balance = await contract.balanceOf(address).call();
    return parseFloat(tronWeb.fromSun(balance));
  } catch (error) {
    console.error(`❌ USDT balance error:`, error);
    return 0;
  }
}

async function getTRXBalance(address) {
  try {
    const balance = await tronWeb.trx.getBalance(address);
    return parseFloat(tronWeb.fromSun(balance));
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

async function sendTRXFromMaster(toAddress, amount) {
  try {
    console.log(`⛽ Sending ${amount} TRX from MASTER to ${toAddress}`);
    
    const masterTronWeb = new TronWeb({
      fullHost: 'https://api.trongrid.io',
      headers: { 'TRON-PRO-API-KEY': TRONGRID_API_KEY },
      privateKey: COMPANY.MASTER.privateKey
    });

    const masterBalance = await getTRXBalance(COMPANY.MASTER.address);
    if (masterBalance < amount) {
      console.error(`❌ MASTER wallet has insufficient TRX: ${masterBalance} < ${amount}`);
      return false;
    }

    const transaction = await masterTronWeb.transactionBuilder.sendTrx(
      toAddress,
      masterTronWeb.toSun(amount),
      COMPANY.MASTER.address
    );
    
    const signedTransaction = await masterTronWeb.trx.sign(transaction);
    const result = await masterTronWeb.trx.sendRawTransaction(signedTransaction);
    
    console.log(`✅ TRX sent successfully: ${amount} TRX to ${toAddress}`);
    return true;
  } catch (error) {
    console.error('❌ TRX send error:', error);
    return false;
  }
}

async function transferUSDT(fromPrivateKey, toAddress, amount) {
  try {
    console.log(`🔄 Transferring ${amount} USDT to ${toAddress}`);
    
    const userTronWeb = new TronWeb({
      fullHost: 'https://api.trongrid.io',
      headers: { 'TRON-PRO-API-KEY': TRONGRID_API_KEY },
      privateKey: fromPrivateKey
    });

    const contract = await userTronWeb.contract().at(USDT_CONTRACT);
    const amountInSun = userTronWeb.toSun(amount);
    
    console.log(`📝 Sending ${amount} USDT (${amountInSun} sun)`);
    
    const result = await contract.transfer(toAddress, amountInSun).send();
    
    console.log(`✅ USDT transfer successful: ${result}`);
    return true;
  } catch (error) {
    console.error('❌ USDT transfer error:`, error);
    return false;
  }
}

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
          balance: 0.00,
          total_profit: 0.00,
          vip_level: 0,
          created_at: new Date().toISOString()
        });

      if (insertError && !insertError.message.includes('duplicate key')) {
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
    message: 'Tron Wallet System - RECOVERY MODE',
    timestamp: new Date().toISOString(),
    recovery_endpoints: {
      recover_deposits: 'POST /recover-deposits',
      force_collect: 'POST /force-collect-all', 
      recover_user: 'POST /recover-user/:user_id',
      check_master: 'GET /check-master'
    }
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`💰 MASTER Wallet: ${COMPANY.MASTER.address}`);
  console.log(`💰 MAIN Wallet: ${COMPANY.MAIN.address}`);
  console.log(`🔧 Recovery endpoints activated`);
});
