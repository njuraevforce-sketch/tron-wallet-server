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

// ========== ОСНОВНЫЕ ЭНДПОИНТЫ ==========

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
    console.log('🔄 Checking deposits...');
    
    const { data: wallets, error } = await supabase
      .from('user_wallets')
      .select('*');

    if (error) throw error;

    console.log(`🔍 Checking ${wallets?.length || 0} wallets`);
    let processedCount = 0;

    for (const wallet of wallets || []) {
      try {
        const transactions = await getUSDTTransactions(wallet.address);
        const usdtTransactions = transactions.filter(tx => 
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
});

// ✅ Сбор средств
app.get('/collect-funds', async (req, res) => {
  try {
    console.log('💰 Collecting funds...');
    
    const { data: wallets, error } = await supabase
      .from('user_wallets')
      .select('*');

    if (error) throw error;

    let collectedCount = 0;
    let totalCollected = 0;

    for (const wallet of wallets || []) {
      try {
        const result = await collectFundsFromWallet(wallet);
        if (result.success) {
          collectedCount++;
          totalCollected += result.amount;
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

// ========== ФУНКЦИИ ВОССТАНОВЛЕНИЯ ==========

// 🔄 Восстановление пропущенных депозитов
app.post('/recover-deposits', async (req, res) => {
  try {
    console.log('🔄 Recovering missed deposits...');
    
    const { data: wallets, error } = await supabase
      .from('user_wallets')
      .select('*');

    if (error) throw error;

    let recoveredCount = 0;
    let totalRecovered = 0;

    for (const wallet of wallets || []) {
      try {
        const transactions = await getUSDTTransactions(wallet.address);
        const depositTransactions = transactions.filter(tx => 
          tx.to === wallet.address.toLowerCase() && 
          tx.type === 'Transfer' &&
          tx.confirmed === true
        );

        for (const tx of depositTransactions) {
          const amount = tx.value / 1000000;
          
          const { data: existingDeposit } = await supabase
            .from('deposits')
            .select('id')
            .eq('txid', tx.transaction_id)
            .single();

          if (!existingDeposit && amount >= 30) {
            console.log(`🎯 Recovering deposit: ${amount} USDT`);
            await processDeposit(wallet, amount, tx.transaction_id);
            recoveredCount++;
            totalRecovered += amount;
          }
        }

      } catch (error) {
        console.error(`❌ Error recovering ${wallet.address}:`, error);
      }
    }

    res.json({
      success: true,
      message: `✅ Recovered ${recoveredCount} deposits (${totalRecovered} USDT)`
    });

  } catch (error) {
    console.error('❌ Recovery error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 💰 Принудительный сбор всех средств
app.post('/force-collect-all', async (req, res) => {
  try {
    console.log('💰 Force collecting all funds...');
    
    const { data: wallets, error } = await supabase
      .from('user_wallets')
      .select('*');

    if (error) throw error;

    let collectedCount = 0;
    let totalCollected = 0;

    for (const wallet of wallets || []) {
      try {
        const usdtBalance = await getUSDTBalance(wallet.address);
        
        if (usdtBalance > 1) {
          const amountToTransfer = usdtBalance - 1;
          
          const trxBalance = await getTRXBalance(wallet.address);
          if (trxBalance < 10) {
            await sendTRXFromMaster(wallet.address, 15);
            await sleep(15000);
          }

          const transferResult = await transferUSDT(wallet.private_key, COMPANY.MAIN.address, amountToTransfer);
          
          if (transferResult) {
            collectedCount++;
            totalCollected += amountToTransfer;
            
            await supabase
              .from('collections')
              .insert({
                wallet_address: wallet.address,
                user_id: wallet.user_id,
                amount: amountToTransfer,
                collected_to: COMPANY.MAIN.address,
                created_at: new Date().toISOString()
              });
          }
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
    console.error('❌ Force collection error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 🔍 Проверка статуса MASTER кошелька
app.get('/check-master', async (req, res) => {
  try {
    const masterUSDT = await getUSDTBalance(COMPANY.MASTER.address);
    const masterTRX = await getTRXBalance(COMPANY.MASTER.address);
    const mainUSDT = await getUSDTBalance(COMPANY.MAIN.address);

    res.json({
      master_wallet: {
        address: COMPANY.MASTER.address,
        usdt_balance: masterUSDT,
        trx_balance: masterTRX
      },
      main_wallet: {
        address: COMPANY.MAIN.address,
        usdt_balance: mainUSDT
      },
      status: masterTRX > 10 ? '✅ Ready' : '❌ Need TRX'
    });

  } catch (error) {
    console.error('❌ Check master error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========

async function collectFundsFromWallet(wallet) {
  try {
    const usdtBalance = await getUSDTBalance(wallet.address);
    
    if (usdtBalance <= 1) {
      return { success: false, amount: 0 };
    }

    const amountToTransfer = usdtBalance - 1;

    const trxBalance = await getTRXBalance(wallet.address);
    if (trxBalance < 10) {
      await sendTRXFromMaster(wallet.address, 15);
      await sleep(15000);
    }

    const transferResult = await transferUSDT(wallet.private_key, COMPANY.MAIN.address, amountToTransfer);
    
    if (transferResult) {
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
    }

    return { success: false, amount: 0 };

  } catch (error) {
    console.error(`❌ Collection error:`, error);
    return { success: false, amount: 0 };
  }
}

async function processDeposit(wallet, amount, txid) {
  try {
    await ensureUserExists(wallet.user_id);

    const { data: user } = await supabase
      .from('users')
      .select('balance, total_profit')
      .eq('id', wallet.user_id)
      .single();

    if (user) {
      const newBalance = (user.balance || 0) + amount;
      const newTotalProfit = (user.total_profit || 0) + amount;

      await supabase
        .from('users')
        .update({
          balance: newBalance,
          total_profit: newTotalProfit
        })
        .eq('id', wallet.user_id);

      await supabase
        .from('deposits')
        .insert({
          user_id: wallet.user_id,
          wallet_address: wallet.address,
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
          description: 'Deposit USDT',
          status: 'completed',
          created_at: new Date().toISOString()
        });

      console.log(`✅ Deposit processed: ${amount} USDT for user ${wallet.user_id}`);

      // Auto collect after 10 seconds
      setTimeout(async () => {
        try {
          await collectFundsFromWallet(wallet);
        } catch (error) {
          console.error('❌ Auto-collection error:', error);
        }
      }, 10000);
    }
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

async function sendTRXFromMaster(toAddress, amount) {
  try {
    const masterTronWeb = new TronWeb({
      fullHost: 'https://api.trongrid.io',
      headers: { 'TRON-PRO-API-KEY': TRONGRID_API_KEY },
      privateKey: COMPANY.MASTER.privateKey
    });

    const transaction = await masterTronWeb.transactionBuilder.sendTrx(
      toAddress,
      masterTronWeb.toSun(amount),
      COMPANY.MASTER.address
    );
    
    const signedTransaction = await masterTronWeb.trx.sign(transaction);
    const result = await masterTronWeb.trx.sendRawTransaction(signedTransaction);
    
    console.log(`✅ TRX sent: ${amount} TRX to ${toAddress}`);
    return true;
  } catch (error) {
    console.error('❌ TRX send error:', error);
    return false;
  }
}

async function transferUSDT(fromPrivateKey, toAddress, amount) {
  try {
    const userTronWeb = new TronWeb({
      fullHost: 'https://api.trongrid.io',
      headers: { 'TRON-PRO-API-KEY': TRONGRID_API_KEY },
      privateKey: fromPrivateKey
    });

    const contract = await userTronWeb.contract().at(USDT_CONTRACT);
    const amountInSun = Math.floor(amount * 1000000);
    
    const result = await contract.transfer(toAddress, amountInSun).send();
    
    console.log(`✅ USDT transfer successful: ${amount} USDT`);
    return true;
  } catch (error) {
    console.error('❌ USDT transfer error:', error);
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
      await supabase
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
    message: 'Tron Wallet System - FIXED VERSION',
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`💰 MASTER Wallet: ${COMPANY.MASTER.address}`);
  console.log(`💰 MAIN Wallet: ${COMPANY.MAIN.address}`);
});
