// server.js — АДАПТИРОВАН ДЛЯ GLY PLATFORM
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const TronWeb = require('tronweb');

const app = express();
const PORT = process.env.PORT || 3000;

// ========== КОНФИГУРАЦИЯ GLY ==========
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jxyazsguwkbklavamzyj.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp4eWF6c2d1d2tia2xhdmFtenlqIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NDU1MjgzMywiZXhwIjoyMDgwMTI4ODMzfQ.nvjoMzRgLRmR3ekIYgIzLTO_Hdxh37is1m3BApY9xk4';
const TRONGRID_API_KEY = process.env.TRONGRID_API_KEY || '8fa63ef4-f010-4ad2-a556-a7124563bafd';
const MORALIS_API_KEY = process.env.MORALIS_API_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6ImQ0NWE5ODZjLWI3ZWItNGJhNC04NDdlLTE1YWFlNTYyNDNhOSIsIm9yZ0lkIjoiNDgxMTM3IiwidXNlcklkIjoiNDk0OTkyIiwidHlwZUlkIjoiYTYzNmUzYjQtN2QyYS00OTlhLTlhM2MtZjZhODA0M2Y1NGZmIiwidHlwZSI6IlBST0pFQ1QiLCJpYXQiOjE3NjMwMzE2NzgsImV4cCI6NDkxODc5MTY3OH0.ZaidcBOM5qWrYRPdFwrDXABVWLh-LmYbfNAmyG-a_jE';

// ========== МИДЛВАРЕ ==========
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Allow-Methods', '*');
  next();
});

// ========== HTTP РОУТЫ ==========
app.get('/', (req, res) => {
  res.json({
    status: '✅ СЕРВЕР РАБОТАЕТ',
    message: 'GLY Auto Deposit Processing System',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development'
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: '✅ ЗДОРОВ',
    service: 'GLY Deposit Processor',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: '✅ API ЗДОРОВ',
    timestamp: new Date().toISOString()
  });
});

// ========== ИНИЦИАЛИЗАЦИЯ СЕРВИСОВ ==========
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const tronWeb = new TronWeb({
  fullHost: 'https://api.trongrid.io',
  headers: { 'TRON-PRO-API-KEY': TRONGRID_API_KEY }
});

// ========== КОНСТАНТЫ ==========
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const USDT_BSC_CONTRACT = '0x55d398326f99059fF775485246999027B3197955';
const MIN_DEPOSIT = 17;

// ========== ОПТИМИЗИРОВАННЫЕ НАСТРОЙКИ ==========
const TRC20_CHECK_INTERVAL = 45000; // 45 секунд - TRC20 быстрый
const BEP20_CHECK_INTERVAL = 180000; // 3 минуты - BEP20 экономный
const BEP20_DELAY_MS = 500; // 2 запроса/секунду для Moralis
const TRC20_DELAY_MS = 100; // 10 запросов/секунду для TronGrid

// ========== ПОМОЩНИКИ ==========
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

// ========== ГЕНЕРАЦИЯ КОШЕЛЬКА ==========
async function generateTRC20Wallet() {
  try {
    const account = await tronWeb.createAccount();
    return {
      address: account.address.base58,
      privateKey: account.privateKey
    };
  } catch (error) {
    console.error('❌ Ошибка генерации TRC20 кошелька:', error);
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
    console.error('❌ Ошибка генерации BEP20 кошелька:', error);
    throw error;
  }
}

// ========== ОБРАБОТКА ДЕПОЗИТА ==========
async function processDeposit(wallet, amount, txid, network) {
  try {
    console.log(`💰 ОБРАБОТКА ДЕПОЗИТА: ${amount} USDT для пользователя ${wallet.user_id}, txid: ${txid}, сеть: ${network}`);

    // Проверка дублирующей транзакции
    const { data: existingDeposit, error: checkError } = await supabase
      .from('deposit_transactions')
      .select('id, status, amount')
      .eq('tx_hash', txid)
      .eq('network', network)
      .maybeSingle();

    if (checkError) {
      console.error('Ошибка проверки существующего депозита:', checkError);
      throw checkError;
    }

    if (existingDeposit) {
      console.log(`✅ Депозит уже обработан: ${txid}, статус: ${existingDeposit.status}, сумма: ${existingDeposit.amount}`);
      return { success: false, reason: 'already_processed', existing: existingDeposit };
    }

    // Проверка существования пользователя
    await ensureUserExists(wallet.user_id);

    // Вставка записи о депозите
    const { data: newDeposit, error: depositError } = await supabase
      .from('deposit_transactions')
      .insert({
        user_id: wallet.user_id,
        tx_hash: txid,
        amount: amount,
        network: network,
        status: 'confirmed',
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (depositError) {
      if (depositError.code === '23505') {
        console.log(`🔄 Депозит уже обрабатывается другим потоком: ${txid}`);
        return { success: false, reason: 'concurrent_processing' };
      }
      throw new Error(`Ошибка вставки депозита: ${depositError.message}`);
    }

    // Обновление баланса пользователя
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('balance, vip_level')
      .eq('id', wallet.user_id)
      .single();

    if (userError) {
      await supabase.from('deposit_transactions').delete().eq('id', newDeposit.id);
      throw new Error(`Ошибка получения пользователя: ${userError.message}`);
    }

    const currentBalance = Number(user.balance) || 0;
    const newBalance = currentBalance + amount;

    const { error: updateError } = await supabase
      .from('users')
      .update({
        balance: newBalance,
        updated_at: new Date().toISOString()
      })
      .eq('id', wallet.user_id);

    if (updateError) {
      await supabase.from('deposit_transactions').delete().eq('id', newDeposit.id);
      throw new Error(`Ошибка обновления баланса: ${updateError.message}`);
    }

    // Создание записи транзакции
    await supabase.from('transactions').insert({
      user_id: wallet.user_id,
      type: 'deposit',
      amount: amount,
      status: 'completed',
      description: `Auto deposit ${amount} USDT (${network})`,
      created_at: new Date().toISOString()
    });

    // Обновление VIP уровня если применимо
    if (newBalance >= 20 && user.vip_level === 1) {
      await supabase
        .from('users')
        .update({ vip_level: 1 })
        .eq('id', wallet.user_id);
      console.log(`⭐ VIP уровень повышен до 1 для пользователя ${wallet.user_id}`);
    }

    console.log(`✅ ДЕПОЗИТ ОБРАБОТАН: ${amount} USDT для пользователя ${wallet.user_id}`);
    console.log(`💰 Новый баланс: ${newBalance} USDT`);

    return { success: true, amount, deposit_id: newDeposit.id };

  } catch (error) {
    console.error('❌ Ошибка обработки депозита:', error.message);
    throw error;
  }
}

// ========== API ЭНДПОИНТЫ ==========
app.post('/api/deposit/generate', async (req, res) => {
  try {
    const { user_id, network = 'trc20' } = req.query;
    if (!user_id) return res.status(400).json({ success: false, error: 'User ID обязателен' });

    console.log(`🔐 Генерация ${network} кошелька для пользователя: ${user_id}`);
    await ensureUserExists(user_id);

    // Проверка существующего кошелька
    const { data: existingWallet } = await supabase
      .from('deposit_addresses')
      .select('address')
      .eq('user_id', user_id)
      .eq('network', network)
      .single();

    if (existingWallet) {
      console.log(`✅ Кошелек уже существует: ${existingWallet.address} (${network})`);
      return res.json({ 
        success: true, 
        address: existingWallet.address, 
        exists: true, 
        network 
      });
    }

    let address, private_key;

    // Генерация нового кошелька
    if (network === 'trc20') {
      const wallet = await generateTRC20Wallet();
      address = wallet.address;
      private_key = wallet.privateKey;
    } else if (network === 'bep20') {
      const wallet = await generateBEP20Wallet();
      address = wallet.address;
      private_key = wallet.privateKey;
    } else {
      return res.status(400).json({ success: false, error: 'Неподдерживаемая сеть' });
    }

    // Сохранение в базу данных
    const { data, error } = await supabase.from('deposit_addresses').insert({
      user_id,
      address,
      private_key,
      network,
      created_at: new Date().toISOString()
    }).select().single();

    if (error) {
      console.error('❌ Ошибка базы данных:', error);
      return res.status(500).json({ success: false, error: 'Ошибка сохранения кошелька' });
    }

    console.log(`✅ Новый ${network} кошелек создан: ${address}`);
    
    // Немедленная проверка существующих депозитов
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
      exists: false, 
      network 
    });
  } catch (error) {
    console.error('❌ Ошибка генерации кошелька:', error.message);
    res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
  }
});

app.get('/api/deposit/history', async (req, res) => {
  try {
    const { user_id, network = 'trc20' } = req.query;
    if (!user_id) return res.status(400).json({ success: false, error: 'User ID обязателен' });

    const { data: deposits, error } = await supabase
      .from('deposit_transactions')
      .select('*')
      .eq('user_id', user_id)
      .eq('network', network)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) {
      console.error('❌ Ошибка базы данных:', error);
      return res.status(500).json({ success: false, error: 'Ошибка получения истории депозитов' });
    }

    res.json({ success: true, deposits: deposits || [] });
  } catch (error) {
    console.error('❌ Ошибка истории депозитов:', error.message);
    res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
  }
});

// ========== ПРОВЕРКА ДЕПОЗИТОВ ==========
app.get('/api/check-deposits', async (req, res) => { 
  try {
    console.log('🔄 Ручная проверка депозитов через API');
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

// ========== TRC20 ТРАНЗАКЦИИ (БЫСТРО - БЕЗ ЛИМИТОВ) ==========
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
    console.error('❌ Ошибка TRC20 транзакций:', error.message);
    return [];
  }
}

// ========== BEP20 ТРАНЗАКЦИИ (ОПТИМИЗИРОВАННО ДЛЯ 40K DCU) ==========
async function getBEP20Transactions(address) {
  try {
    console.log(`🔍 Проверка BEP20 через Moralis: ${address}`);
    
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
      throw new Error(`Ошибка API Moralis: ${response.status}`);
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

    console.log(`✅ Найдено ${transactions.length} BEP20 транзакций для ${address}`);
    return transactions;

  } catch (error) {
    console.error('❌ Ошибка API Moralis:', error.message);
    return [];
  }
}

// ========== ОПТИМИЗИРОВАННАЯ ПРОВЕРКА TRC20 ==========
async function handleCheckTRC20Deposits() {
  try {
    console.log('🔄 Проверка TRC20 депозитов...');
    
    const { data: wallets, error } = await supabase
      .from('deposit_addresses')
      .select('*')
      .eq('network', 'trc20')
      .limit(100);

    if (error) throw error;

    let processedCount = 0;
    let depositsFound = 0;

    for (const wallet of wallets || []) {
      try {
        await sleep(TRC20_DELAY_MS);
        
        const transactions = await getTRC20Transactions(wallet.address);
        
        for (const tx of transactions) {
          if (tx.to === wallet.address && tx.token === 'USDT' && tx.amount >= MIN_DEPOSIT) {
            try {
              const result = await processDeposit(wallet, tx.amount, tx.transaction_id, 'trc20');
              if (result.success) {
                depositsFound++;
                console.log(`💰 НОВЫЙ TRC20 ДЕПОЗИТ: ${tx.amount} USDT для пользователя ${wallet.user_id}`);
              }
            } catch (err) {
              console.error(`❌ Ошибка обработки TRC20 депозита ${tx.transaction_id}:`, err.message);
            }
          }
        }
        processedCount++;
      } catch (err) {
        console.error(`❌ Ошибка обработки TRC20 кошелька ${wallet.address}:`, err.message);
      }
    }

    console.log(`✅ TRC20: Обработано ${processedCount} кошельков, найдено ${depositsFound} депозитов`);
    return { success: true, processed: processedCount, deposits: depositsFound };
    
  } catch (error) {
    console.error('❌ Ошибка проверки TRC20:', error.message);
    return { success: false, error: error.message };
  }
}

// ========== ОПТИМИЗИРОВАННАЯ ПРОВЕРКА BEP20 ==========
async function handleCheckBEP20Deposits() {
  try {
    console.log('🔄 Проверка BEP20 депозитов...');
    
    const { data: wallets, error } = await supabase
      .from('deposit_addresses')
      .select('*')
      .eq('network', 'bep20')
      .limit(100);

    if (error) throw error;

    let processedCount = 0;
    let depositsFound = 0;

    for (const wallet of wallets || []) {
      try {
        await sleep(BEP20_DELAY_MS);
        
        const transactions = await getBEP20Transactions(wallet.address);
        
        for (const tx of transactions) {
          if (tx.to.toLowerCase() === wallet.address.toLowerCase() && tx.token === 'USDT' && tx.amount >= MIN_DEPOSIT) {
            try {
              const result = await processDeposit(wallet, tx.amount, tx.transaction_id, 'bep20');
              if (result.success) {
                depositsFound++;
                console.log(`💰 НОВЫЙ BEP20 ДЕПОЗИТ: ${tx.amount} USDT для пользователя ${wallet.user_id}`);
              }
            } catch (err) {
              console.error(`❌ Ошибка обработки BEP20 депозита ${tx.transaction_id}:`, err.message);
            }
          }
        }
        processedCount++;
      } catch (err) {
        console.error(`❌ Ошибка обработки BEP20 кошелька ${wallet.address}:`, err.message);
      }
    }

    console.log(`✅ BEP20: Обработано ${processedCount} кошельков, найдено ${depositsFound} депозитов`);
    return { success: true, processed: processedCount, deposits: depositsFound };
    
  } catch (error) {
    console.error('❌ Ошибка проверки BEP20:', error.message);
    return { success: false, error: error.message };
  }
}

// ========== ПОМОЩНИКИ ==========
async function ensureUserExists(userId) {
  try {
    const { data } = await supabase.from('users').select('id').eq('id', userId).single();
    if (!data) {
      await supabase.from('users').insert({
        id: userId,
        username: `user-${userId}`,
        email: `user-${userId}@gly.io`,
        password: 'temp123',
        payment_password: 'temp123',
        invite_code: `REF-${userId.substring(0, 8)}`,
        balance: 0.00,
        vip_level: 1,
        created_at: new Date().toISOString()
      });
      console.log(`✅ Пользователь создан: ${userId}`);
    }
  } catch (error) {
    console.error('❌ Ошибка ensureUserExists:', error.message);
  }
}

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
          const result = await processDeposit(wallet, tx.amount, tx.transaction_id, 'trc20');
          if (result.success) {
            console.log(`💰 НАЙДЕН НОВЫЙ TRC20 ДЕПОЗИТ: ${tx.amount} USDT для пользователя ${userId}`);
          }
        } catch (err) {
          console.error(`❌ Ошибка обработки транзакции ${tx.transaction_id}:`, err);
        }
      }
    }
  } catch (error) {
    console.error('❌ Ошибка checkUserTRC20Deposits:', error);
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
          const result = await processDeposit(wallet, tx.amount, tx.transaction_id, 'bep20');
          if (result.success) {
            console.log(`💰 НАЙДЕН НОВЫЙ BEP20 ДЕПОЗИТ: ${tx.amount} USDT для пользователя ${userId}`);
          }
        } catch (err) {
          console.error(`❌ Ошибка обработки транзакции ${tx.transaction_id}:`, err);
        }
      }
    }
  } catch (error) {
    console.error('❌ Ошибка checkUserBEP20Deposits:', error);
  }
}

// ========== ЗАПУСК СЕРВЕРА ==========
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 HTTP СЕРВЕР ЗАПУЩЕН на порту ${PORT}`);
  console.log(`✅ Проверка здоровья: http://0.0.0.0:${PORT}/health`);
  console.log(`✅ Проверка API здоровья: http://0.0.0.0:${PORT}/api/health`);
  console.log(`✅ SUPABASE: ПОДКЛЮЧЕН`);
  console.log(`✅ TRONGRID: API KEY УСТАНОВЛЕН (100K запросов/день)`);
  console.log(`✅ MORALIS: API KEY УСТАНОВЛЕН (40K DCU/день)`);
  console.log(`✅ TRC20: Проверка каждые 45 секунд`);
  console.log(`✅ BEP20: Проверка каждые 3 минуты`);
  console.log('===================================');
});

// ========== ФОНОВЫЕ ЗАДАЧИ ==========
let isCheckingTRC20 = false;
let isCheckingBEP20 = false;

// TRC20 фоновая проверка (Быстрая)
setInterval(async () => {
  if (isCheckingTRC20) return;
  
  try {
    isCheckingTRC20 = true;
    await handleCheckTRC20Deposits();
  } catch (err) {
    console.error('❌ Ошибка автоматической проверки TRC20:', err.message);
  } finally {
    isCheckingTRC20 = false;
  }
}, TRC20_CHECK_INTERVAL);

// BEP20 фоновая проверка (Оптимизированная для DCU)
setInterval(async () => {
  if (isCheckingBEP20) return;
  
  try {
    isCheckingBEP20 = true;
    await handleCheckBEP20Deposits();
  } catch (err) {
    console.error('❌ Ошибка автоматической проверки BEP20:', err.message);
  } finally {
    isCheckingBEP20 = false;
  }
}, BEP20_CHECK_INTERVAL);

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Получен SIGTERM, завершение работы');
  server.close(() => {
    console.log('✅ Сервер закрыт');
    process.exit(0);
  });
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('❌ Необработанное исключение:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Необработанное отклонение промиса:', promise, 'причина:', reason);
});
