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

// ✅ Генерация кошелька
app.post('/generate-wallet', async (req, res) => {
  try {
    const { user_id } = req.body;
    
    if (!user_id) {
      return res.status(400).json({ success: false, error: 'User ID required' });
    }

    // Проверяем существующий кошелек
    const { data: existingWallet } = await supabase
      .from('user_wallets')
      .select('address')
      .eq('user_id', user_id)
      .single();

    if (existingWallet) {
      return res.json({ success: true, address: existingWallet.address, exists: true });
    }

    // Генерируем новый кошелёк
    const account = TronWeb.utils.accounts.generateAccount();
    
    // Сохраняем в базу
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

    res.json({ success: true, address: account.address.base58, exists: false });

  } catch (error) {
    console.error('Generate wallet error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✅ ПРОВЕРКА ДЕПОЗИТОВ + АВТОСБОР
app.get('/check-deposits', async (req, res) => {
  try {
    console.log('🔄 Checking deposits and auto-collecting...');
    
    const { data: wallets } = await supabase.from('user_wallets').select('*');
    if (!wallets?.length) {
      return res.json({ success: true, message: 'No wallets', processed: 0 });
    }

    let processedDeposits = 0;
    let collectedWallets = 0;

    for (const wallet of wallets) {
      try {
        // 1. Проверяем депозиты
        const transactions = await getUSDTTransactions(wallet.address);
        const newDeposits = transactions.filter(tx => 
          tx.token_info?.symbol === 'USDT' && 
          tx.to === wallet.address.toLowerCase() && 
          tx.type === 'Transfer' &&
          (tx.value / 1000000) >= 30
        );

        for (const tx of newDeposits) {
          const amount = tx.value / 1000000;
          
          const { data: existing } = await supabase
            .from('deposits')
            .select('id')
            .eq('txid', tx.transaction_id)
            .single();

          if (!existing) {
            await processDeposit(wallet, amount, tx.transaction_id);
            processedDeposits++;
            console.log(`✅ Deposit processed: ${amount} USDT`);
          }
        }

        // 2. АВТОСБОР СРЕДСТВ
        const usdtBalance = await getUSDTBalance(wallet.address);
        if (usdtBalance > 1) {
          const success = await collectWithTRXSupport(wallet, usdtBalance);
          if (success) collectedWallets++;
        }

        // Обновляем время проверки
        await supabase
          .from('user_wallets')
          .update({ last_checked: new Date().toISOString() })
          .eq('id', wallet.id);

      } catch (error) {
        console.log(`Skipping wallet ${wallet.address}:`, error.message);
      }
    }

    res.json({ 
      success: true, 
      message: `Processed ${processedDeposits} deposits, collected from ${collectedWallets} wallets`,
      processed: processedDeposits,
      collected: collectedWallets
    });

  } catch (error) {
    console.error('Check deposits error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✅ АВТОСБОР С ПОДДЕРЖКОЙ ОТПРАВКИ 2 TRX
async function collectWithTRXSupport(wallet, usdtBalance) {
  try {
    const amountToTransfer = usdtBalance - 1; // Оставляем 1 USDT
    
    // Проверяем TRX баланс
    const trxBalance = await getTRXBalance(wallet.address);
    
    // Если мало TRX - автоматически отправляем 2 TRX
    if (trxBalance < 3) {
      console.log(`⛽ Low TRX (${trxBalance}), sending 2 TRX to ${wallet.address}`);
      const trxSent = await sendTRX(COMPANY.MASTER.privateKey, wallet.address, 2);
      
      if (trxSent) {
        console.log(`⏳ Waiting 10 seconds for TRX confirmation...`);
        await new Promise(resolve => setTimeout(resolve, 10000));
        
        // Проверяем баланс снова после отправки
        const newTrxBalance = await getTRXBalance(wallet.address);
        console.log(`💰 New TRX balance: ${newTrxBalance}`);
        
        if (newTrxBalance < 1) {
          console.log(`❌ TRX still not arrived, skipping collection`);
          return false;
        }
      } else {
        console.log(`❌ Failed to send TRX, skipping collection`);
        return false;
      }
    }

    console.log(`💸 Collecting ${amountToTransfer} USDT from ${wallet.address}`);
    
    // Переводим USDT на MAIN кошелек
    const transferResult = await transferUSDT(wallet.private_key, COMPANY.MAIN.address, amountToTransfer);
    
    if (transferResult) {
      console.log(`✅ Collected ${amountToTransfer} USDT`);
      
      // Обновляем информацию о сборе
      await supabase
        .from('user_wallets')
        .update({ 
          last_collected: new Date().toISOString(),
          total_collected: (wallet.total_collected || 0) + amountToTransfer
        })
        .eq('id', wallet.id);
      
      return true;
    } else {
      console.log(`❌ USDT transfer failed for ${wallet.address}`);
      return false;
    }

  } catch (error) {
    console.error(`Collection error for ${wallet.address}:`, error.message);
    return false;
  }
}

// ✅ ФУНКЦИЯ ОТПРАВКИ TRX (2 TRX)
async function sendTRX(fromPrivateKey, toAddress, amount = 2) {
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
    console.error('❌ TRX send error:', error.message);
    return false;
  }
}

// ========== TRON API ФУНКЦИИ ==========

async function getUSDTBalance(address) {
  try {
    const contract = await tronWeb.contract().at('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
    const balance = await contract.balanceOf(address).call();
    return balance / 1000000;
  } catch (error) {
    return 0;
  }
}

async function getTRXBalance(address) {
  try {
    const balance = await tronWeb.trx.getBalance(address);
    return balance / 1000000;
  } catch (error) {
    return 0;
  }
}

async function getUSDTTransactions(address) {
  try {
    const response = await fetch(
      `https://api.trongrid.io/v1/accounts/${address}/transactions/trc20?limit=20&only_confirmed=true`,
      {
        headers: { 'Accept': 'application/json', 'TRON-PRO-API-KEY': TRONGRID_API_KEY }
      }
    );

    if (!response.ok) return [];
    const data = await response.json();
    return data.data || [];
  } catch (error) {
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
    return true;
  } catch (error) {
    console.error('USDT transfer error:', error.message);
    return false;
  }
}

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========

async function processDeposit(wallet, amount, txid) {
  try {
    await ensureUserExists(wallet.user_id);

    const { data: user } = await supabase
      .from('users')
      .select('balance, total_profit')
      .eq('id', wallet.user_id)
      .single();

    if (user) {
      const newBalance = (parseFloat(user.balance) || 0) + amount;
      const newTotalProfit = (parseFloat(user.total_profit) || 0) + amount;

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
          wallet_address: wallet.address,
          created_at: new Date().toISOString()
        });

      await supabase
        .from('transactions')
        .insert({
          user_id: wallet.user_id,
          type: 'deposit',
          amount: amount,
          description: 'Deposit received',
          status: 'completed',
          created_at: new Date().toISOString()
        });

      console.log(`✅ Balance updated: +${amount} USDT for user ${wallet.user_id}`);
    }

  } catch (error) {
    console.error('Process deposit error:', error);
    throw error;
  }
}

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
    }
  } catch (error) {
    console.error('ensureUserExists error:', error);
  }
}

// Health check
app.get('/health', async (req, res) => {
  try {
    const { data: wallets, error } = await supabase
      .from('user_wallets')
      .select('count')
      .limit(1);
    
    res.json({ 
      status: '✅ OK', 
      database: error ? '❌ ERROR' : '✅ CONNECTED',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ status: '❌ ERROR', error: error.message });
  }
});

app.get('/', (req, res) => {
  res.json({ status: '✅ OK', message: 'Tron Wallet System' });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Supabase: ${SUPABASE_URL ? '✅ CONNECTED' : '❌ MISSING'}`);
  console.log(`🔑 TronGrid: ${TRONGRID_API_KEY ? '✅ SET' : '❌ MISSING'}`);
  console.log(`💰 MASTER Wallet: ${COMPANY.MASTER.address}`);
  console.log(`💰 MAIN Wallet: ${COMPANY.MAIN.address}`);
});
