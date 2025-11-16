// server.js — MORALIS API FOR BSC
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const TronWeb = require('tronweb');
const { ethers } = require('ethers');

const app = express();
const PORT = process.env.PORT || 3000;

// ========== ENVIRONMENT VARIABLES ==========
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://bpsmizhrzgfbjqfpqkcz.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOi...';
const TRONGRID_API_KEY = process.env.TRONGRID_API_KEY || '19e2411a-3c3e-479d-8c85-2abc716af397';

// ========== MORALIS API CONFIGURATION ==========
const MORALIS_API_KEY = process.env.MORALIS_API_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6IjdmMWYwM2UyLWFhNzMtNGQ5ZC1iYWEzLWYzMDQyNmM1MjliZSIsIm9yZ0lkIjoiNDgxNjMxIiwidXNlcklkIjoiNDk1NTAwIiwidHlwZUlkIjoiYmViNTAwMTctZTY0Ni00NTY3LWI0NmUtNjA3OGJlOTYwNTdlIiwidHlwZSI6IlBST0pFQ1QiLCJpYXQiOjE3NjMyOTA1NzgsImV4cCI6NDkxOTA1MDU3OH0.tHAQ3asv_kauMJ46oT3Bnedk3YlcrZoALOYhdmAoLxc';

// ========== BSC RPC CONFIGURATION ==========
const BSC_RPC_URLS = [
  'https://bsc-dataseed.binance.org/',
  'https://bsc-dataseed1.defibit.io/',
  'https://bsc-dataseed1.ninicoin.io/',
  'https://bsc-dataseed2.ninicoin.io/',
];

let currentRpcIndex = 0;
function getNextBscRpc() {
  const rpc = BSC_RPC_URLS[currentRpcIndex];
  currentRpcIndex = (currentRpcIndex + 1) % BSC_RPC_URLS.length;
  return rpc;
}

let bscProvider = new ethers.providers.JsonRpcProvider(getNextBscRpc());

// COMPANY wallets - TRC20
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

// COMPANY wallets - BEP20
const COMPANY_BSC = {
  MASTER: {
    address: '0x60F3159e6b935759d6b4994473eeeD1e3ad27408',
    privateKey: process.env.MASTER_BSC_PRIVATE_KEY
  },
  MAIN: {
    address: '0x01F28A131bdda7255EcBE800C3ebACBa2c7076c7',
    privateKey: process.env.MAIN_BSC_PRIVATE_KEY
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
const USDT_BSC_CONTRACT = '0x55d398326f99059fF775485246999027B3197955';
const USDT_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)"
];

const MIN_DEPOSIT = 20;
const KEEP_AMOUNT = 1.0;
const MIN_TRX_FOR_FEE = 3;
const MIN_BNB_FOR_FEE = 0.005;
const FUND_TRX_AMOUNT = 10;
const FUND_BNB_AMOUNT = 0.01;

// Throttling / concurrency
const BALANCE_CONCURRENCY = Number(process.env.BALANCE_CONCURRENCY || 2);
const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS || 5 * 60 * 1000);

// ========== HELPERS ==========
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizePrivateKeyForTron(pk) {
  if (!pk) return null;
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
        setTimeout(runBalanceQueue, 150);
      })
      .catch(err => {
        currentBalanceRequests--;
        job.reject(err);
        setTimeout(runBalanceQueue, 150);
      });
  }
}

// ========== MORALIS API FUNCTIONS ==========
async function moralisRequest(endpoint, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(`https://deep-index.moralis.io/api/v2${endpoint}`, {
        headers: {
          'X-API-Key': MORALIS_API_KEY,
          'Accept': 'application/json'
        }
      });

      if (response.status === 429) {
        if (attempt < retries) {
          const backoff = 2000 * Math.pow(2, attempt);
          console.warn(`⚠️ Moralis rate limit, waiting ${backoff}ms...`);
          await sleep(backoff);
          continue;
        }
      }

      const data = await response.json();
      
      if (response.ok) {
        return data;
      } else {
        console.log(`❌ Moralis API error: ${data.message || response.statusText}`);
        return { result: [] };
      }
    } catch (error) {
      console.error(`❌ Moralis request attempt ${attempt + 1} failed:`, error.message);
      if (attempt === retries) throw error;
      await sleep(1000 * (attempt + 1));
    }
  }
  return { result: [] };
}

// ========== BSC FUNCTIONS ==========
async function getBSCUSDTBalance(address) {
  try {
    const contract = new ethers.Contract(USDT_BSC_CONTRACT, USDT_ABI, bscProvider);
    const balance = await contract.balanceOf(address);
    return Number(ethers.utils.formatUnits(balance, 18)); // USDT BSC has 18 decimals
  } catch (error) {
    console.error('❌ BSC USDT balance error:', error.message);
    return 0;
  }
}

async function getBSCTransactions(address) {
  try {
    if (!address) return [];

    console.log(`🔍 Checking BSC transactions via Moralis API: ${address}`);
    
    const data = await moralisRequest(`/${address}/erc20/transfers?chain=bsc&limit=50`);
    
    if (data.result && Array.isArray(data.result)) {
      console.log(`✅ Moralis API: Found ${data.result.length} token transfers for ${address}`);
      
      const transactions = [];
      for (const tx of data.result) {
        try {
          // Filter for USDT transfers to this address
          if (tx.address && tx.address.toLowerCase() === USDT_BSC_CONTRACT.toLowerCase() &&
              tx.to_address && tx.to_address.toLowerCase() === address.toLowerCase()) {
            
            const amount = Number(tx.value) / Math.pow(10, tx.decimals || 18);
            
            transactions.push({
              transaction_id: tx.transaction_hash,
              to: tx.to_address,
              from: tx.from_address,
              amount: amount,
              token: 'USDT',
              confirmed: true, // Moralis returns confirmed transactions
              network: 'BEP20',
              timestamp: new Date(tx.block_timestamp).getTime()
            });
          }
        } catch (e) { 
          console.warn('Skipping malformed BSC transaction:', e.message);
          continue; 
        }
      }
      
      // Sort by timestamp (newest first)
      transactions.sort((a, b) => b.timestamp - a.timestamp);
      return transactions;
    } else {
      console.log(`ℹ️ Moralis API: No transactions found for ${address}`);
      return [];
    }
  } catch (error) {
    console.error('❌ BSC transactions error:', error.message);
    return [];
  }
}

async function getBSCBalance(address) {
  try {
    const balance = await bscProvider.getBalance(address);
    return Number(ethers.utils.formatEther(balance));
  } catch (error) {
    console.error('❌ BSC balance error:', error.message);
    // Try to rotate RPC provider
    try {
      bscProvider = new ethers.providers.JsonRpcProvider(getNextBscRpc());
      const balance = await bscProvider.getBalance(address);
      return Number(ethers.utils.formatEther(balance));
    } catch (retryError) {
      return 0;
    }
  }
}

async function sendBSC(fromPrivateKey, toAddress, amount) {
  try {
    const wallet = new ethers.Wallet(fromPrivateKey, bscProvider);
    const tx = await wallet.sendTransaction({
      to: toAddress,
      value: ethers.utils.parseEther(amount.toString())
    });
    
    await tx.wait();
    console.log(`✅ BSC sent: ${amount} BNB to ${toAddress}, txid: ${tx.hash}`);
    return true;
  } catch (error) {
    console.error('❌ BSC send error:', error.message);
    // Try with different RPC
    try {
      bscProvider = new ethers.providers.JsonRpcProvider(getNextBscRpc());
      const wallet = new ethers.Wallet(fromPrivateKey, bscProvider);
      const tx = await wallet.sendTransaction({
        to: toAddress,
        value: ethers.utils.parseEther(amount.toString())
      });
      
      await tx.wait();
      console.log(`✅ BSC sent (retry): ${amount} BNB to ${toAddress}, txid: ${tx.hash}`);
      return true;
    } catch (retryError) {
      return false;
    }
  }
}

async function transferBSCUSDT(fromPrivateKey, toAddress, amount) {
  try {
    const wallet = new ethers.Wallet(fromPrivateKey, bscProvider);
    const contract = new ethers.Contract(USDT_BSC_CONTRACT, USDT_ABI, wallet);
    
    const amountInWei = ethers.utils.parseUnits(amount.toString(), 18); // USDT BSC has 18 decimals
    const tx = await contract.transfer(toAddress, amountInWei);
    
    await tx.wait();
    console.log(`✅ BSC USDT transfer: ${amount} USDT to ${toAddress}, txid: ${tx.hash}`);
    return true;
  } catch (error) {
    console.error('❌ BSC USDT transfer error:', error.message);
    // Try with different RPC
    try {
      bscProvider = new ethers.providers.JsonRpcProvider(getNextBscRpc());
      const wallet = new ethers.Wallet(fromPrivateKey, bscProvider);
      const contract = new ethers.Contract(USDT_BSC_CONTRACT, USDT_ABI, wallet);
      
      const amountInWei = ethers.utils.parseUnits(amount.toString(), 18);
      const tx = await contract.transfer(toAddress, amountInWei);
      
      await tx.wait();
      console.log(`✅ BSC USDT transfer (retry): ${amount} USDT to ${toAddress}, txid: ${tx.hash}`);
      return true;
    } catch (retryError) {
      return false;
    }
  }
}

// ========== TRON FUNCTIONS (БЕЗ ИЗМЕНЕНИЙ) ==========
async function getUSDTBalance(address) {
  return enqueueBalanceJob(async () => {
    try {
      if (!address) return 0;

      const tronWebForChecking = new TronWeb({
        fullHost: 'https://api.trongrid.io',
        headers: { 'TRON-PRO-API-KEY': TRONGRID_API_KEY }
      });

      try {
        const contract = await tronWebForChecking.contract().at(USDT_CONTRACT);
        const result = await contract.balanceOf(address).call();
        return Number(result) / 1_000_000;
      } catch (error) {
        console.warn('getUSDTBalance contract call failed, trying fallback:', error.message);
        // Fallback to old method
        return await getUSDTBalanceFallback(address);
      }
    } catch (err) {
      console.error('❌ getUSDTBalance fatal error:', err.message);
      return 0;
    }
  });
}

async function getUSDTBalanceFallback(address) {
  try {
    const ownerHex = tronWeb.address.toHex(address).replace(/^0x/, '');
    const contractHex = tronWeb.address.toHex(USDT_CONTRACT).replace(/^0x/, '');

    const param = ownerHex.padStart(64, '0');

    const body = {
      owner_address: ownerHex,
      contract_address: contractHex,
      function_selector: 'balanceOf(address)',
      parameter: param,
      call_value: 0
    };

    const response = await fetch('https://api.trongrid.io/wallet/triggerconstantcontract', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'TRON-PRO-API-KEY': TRONGRID_API_KEY
      },
      body: JSON.stringify(body)
    });

    const json = await response.json();

    if (json.constant_result && json.constant_result.length > 0) {
      const hexBalance = json.constant_result[0].replace(/^0x/, '');
      const clean = hexBalance.replace(/^0+/, '') || '0';
      const bn = BigInt('0x' + clean);
      return Number(bn) / 1_000_000;
    }
    return 0;
  } catch (error) {
    console.error('❌ getUSDTBalanceFallback error:', error.message);
    return 0;
  }
}

async function getUSDTTransactions(address) {
  try {
    if (!address) return [];
    
    const response = await fetch(`https://api.trongrid.io/v1/accounts/${address}/transactions/trc20?limit=50&only_confirmed=true`, {
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

        transactions.push({
          transaction_id: tx.transaction_id,
          to,
          from,
          amount,
          token: 'USDT',
          confirmed: true,
          network: 'TRC20',
          timestamp: tx.block_timestamp
        });
      } catch (innerErr) {
        continue;
      }
    }

    // Sort by timestamp (newest first)
    transactions.sort((a, b) => b.timestamp - a.timestamp);
    return transactions;
  } catch (error) {
    console.error('❌ getUSDTTransactions error:', error.message);
    return [];
  }
}

async function getTRXBalance(address) {
  try {
    const response = await fetch(`https://api.trongrid.io/v1/accounts/${address}`, {
      headers: {
        'TRON-PRO-API-KEY': TRONGRID_API_KEY
      }
    });
    
    const json = await response.json();
    
    if (json && json.data && json.data.length > 0) {
      const balance = json.data[0].balance || 0;
      return balance / 1_000_000;
    }
    return 0;
  } catch (error) {
    console.error('❌ TRX balance error:', error.message);
    return 0;
  }
}

async function sendTRX(fromPrivateKey, toAddress, amount) {
  try {
    const pk = normalizePrivateKeyForTron(fromPrivateKey);
    if (!pk) return false;

    const tronWebForSigning = new TronWeb({
      fullHost: 'https://api.trongrid.io',
      privateKey: pk
    });

    const fromAddress = tronWebForSigning.address.fromPrivateKey(pk);
    
    const transaction = await tronWebForSigning.transactionBuilder.sendTrx(
      toAddress,
      tronWebForSigning.toSun(amount),
      fromAddress
    );

    const signedTransaction = await tronWebForSigning.trx.sign(transaction);
    
    const broadcastResult = await tronWebForSigning.trx.sendRawTransaction(signedTransaction);
    
    if (broadcastResult.result) {
      console.log(`✅ TRX sent: ${amount} TRX to ${toAddress}, txid: ${broadcastResult.txid}`);
      return true;
    } else {
      console.error('❌ TRX send failed:', broadcastResult);
      return false;
    }
  } catch (error) {
    console.error('❌ TRX send error:', error.message);
    return false;
  }
}

async function transferUSDT(fromPrivateKey, toAddress, amount) {
  try {
    const pk = normalizePrivateKeyForTron(fromPrivateKey);
    if (!pk) return false;

    const tronWebForSigning = new TronWeb({
      fullHost: 'https://api.trongrid.io',
      privateKey: pk
    });

    const contract = await tronWebForSigning.contract().at(USDT_CONTRACT);
    const amountInSun = Math.floor(amount * 1_000_000);

    console.log(`🔄 Sending ${amount} USDT to ${toAddress}...`);
    const result = await contract.transfer(toAddress, amountInSun).send();
    
    if (result && result.result) {
      console.log(`✅ USDT transfer submitted: ${amount} USDT to ${toAddress}, txid: ${result.transaction?.txID || result.txid}`);
      return true;
    } else {
      console.error('❌ USDT transfer returned unexpected result:', result);
      return false;
    }
  } catch (error) {
    console.error('❌ USDT transfer error:', error.message);
    return false;
  }
}

// ========== UNIVERSAL AUTO-COLLECT ==========
async function autoCollectToMainWallet(wallet) {
  try {
    console.log(`💰 AUTO-COLLECT started for: ${wallet.address} (${wallet.network})`);
    
    let usdtBalance, nativeBalance, minNativeForFee, fundAmount, companyMain, companyMaster;
    let transferFunction, sendNativeFunction;
    
    if (wallet.network === 'TRC20') {
      usdtBalance = await getUSDTBalance(wallet.address);
      nativeBalance = await getTRXBalance(wallet.address);
      minNativeForFee = MIN_TRX_FOR_FEE;
      fundAmount = FUND_TRX_AMOUNT;
      companyMain = COMPANY.MAIN;
      companyMaster = COMPANY.MASTER;
      transferFunction = transferUSDT;
      sendNativeFunction = sendTRX;
    } else if (wallet.network === 'BEP20') {
      usdtBalance = await getBSCUSDTBalance(wallet.address);
      nativeBalance = await getBSCBalance(wallet.address);
      minNativeForFee = MIN_BNB_FOR_FEE;
      fundAmount = FUND_BNB_AMOUNT;
      companyMain = COMPANY_BSC.MAIN;
      companyMaster = COMPANY_BSC.MASTER;
      transferFunction = transferBSCUSDT;
      sendNativeFunction = sendBSC;
    } else {
      throw new Error(`Unsupported network: ${wallet.network}`);
    }
    
    console.log(`📊 USDT Balance: ${usdtBalance} USDT`);
    const amountToTransfer = Math.max(0, usdtBalance - KEEP_AMOUNT);

    if (amountToTransfer <= 0) {
      console.log(`❌ Nothing to collect: ${usdtBalance} USDT`);
      return { success: false, reason: 'low_balance' };
    }

    console.log(`⛽ Native Balance: ${nativeBalance} ${wallet.network === 'TRC20' ? 'TRX' : 'BNB'}`);

    if (nativeBalance < minNativeForFee) {
      console.log(`🔄 Funding ${fundAmount} ${wallet.network === 'TRC20' ? 'TRX' : 'BNB'} from MASTER to ${wallet.address} for gas`);
      const nativeSent = await sendNativeFunction(companyMaster.privateKey, wallet.address, fundAmount);
      if (!nativeSent) {
        console.log('❌ Failed to fund native currency from MASTER');
        return { success: false, reason: 'funding_failed' };
      }
      
      await sleep(15000);
      const newNativeBalance = wallet.network === 'TRC20' ? await getTRXBalance(wallet.address) : await getBSCBalance(wallet.address);
      console.log(`🔄 New native balance after funding: ${newNativeBalance} ${wallet.network === 'TRC20' ? 'TRX' : 'BNB'}`);
      if (newNativeBalance < minNativeForFee) {
        console.log('❌ Native currency still insufficient after funding');
        return { success: false, reason: 'native_still_insufficient' };
      }
    }

    console.log(`🔄 Transferring ${amountToTransfer} USDT to MAIN wallet...`);
    const transferResult = await transferFunction(wallet.private_key, companyMain.address, amountToTransfer);

    if (transferResult) {
      console.log(`✅ SUCCESS: Collected ${amountToTransfer} USDT from ${wallet.address}`);

      try {
        await supabase.from('transactions').insert({
          user_id: wallet.user_id,
          type: 'collect',
          amount: amountToTransfer,
          description: `Auto-collected to ${companyMain.address} (${wallet.network})`,
          status: 'completed',
          created_at: new Date().toISOString()
        });
      } catch (e) {
        console.warn('Warning: failed to insert collect transaction record', e.message);
      }

      return { success: true, amount: amountToTransfer };
    } else {
      console.log(`❌ FAILED: USDT transfer from ${wallet.address}`);
      return { success: false, reason: 'usdt_transfer_failed' };
    }
  } catch (error) {
    console.error('❌ Auto-collection fatal error:', error.message);
    return { success: false, reason: 'error', error: error.stack };
  }
}

// ========== UNIVERSAL DEPOSIT PROCESSING ==========
async function processDeposit(wallet, amount, txid, network) {
  try {
    console.log(`💰 PROCESSING DEPOSIT: ${amount} USDT for user ${wallet.user_id}, txid: ${txid}, network: ${network}`);

    const { data: existingDeposit, error: checkError } = await supabase
      .from('deposits')
      .select('id, status, amount')
      .eq('txid', txid)
      .eq('network', network)
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

    const { data: newDeposit, error: depositError } = await supabase
      .from('deposits')
      .insert({
        user_id: wallet.user_id,
        amount,
        txid,
        network,
        status: 'processing',
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (depositError) {
      if (depositError.code === '23505') {
        console.log(`🔄 Deposit already being processed by another thread: ${txid}`);
        return { success: false, reason: 'concurrent_processing' };
      }
      throw new Error(`Deposit insert failed: ${depositError.message}`);
    }

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('balance, total_profit, vip_level')
      .eq('id', wallet.user_id)
      .single();

    if (userError) {
      await supabase.from('deposits').delete().eq('id', newDeposit.id);
      throw new Error(`user fetch error: ${userError.message}`);
    }

    const currentBalance = Number(user.balance) || 0;
    const newBalance = currentBalance + amount;
    const newTotalProfit = (Number(user.total_profit) || 0) + amount;

    const { error: updateError } = await supabase
      .from('users')
      .update({
        balance: newBalance,
        total_profit: newTotalProfit,
        updated_at: new Date().toISOString()
      })
      .eq('id', wallet.user_id);

    if (updateError) {
      await supabase.from('deposits').delete().eq('id', newDeposit.id);
      throw new Error(`Balance update failed: ${updateError.message}`);
    }

    await supabase
      .from('deposits')
      .update({ status: 'confirmed' })
      .eq('id', newDeposit.id);

    await supabase.from('transactions').insert({
      user_id: wallet.user_id,
      type: 'deposit',
      amount,
      description: `Депозит USDT (${network}) - ${txid.substring(0, 10)}...`,
      status: 'completed',
      created_at: new Date().toISOString()
    });

    if (newBalance >= 20 && user.vip_level === 0) {
      await supabase
        .from('users')
        .update({ vip_level: 1 })
        .eq('id', wallet.user_id);
      console.log(`⭐ VIP Level upgraded to 1 for user ${wallet.user_id}`);
    }

    console.log(`✅ DEPOSIT PROCESSED: ${amount} USDT for user ${wallet.user_id}`);
    console.log(`💰 New balance: ${newBalance} USDT`);

    setTimeout(() => {
      autoCollectToMainWallet(wallet).catch(err => {
        console.error('Auto-collect post-deposit failed:', err.message);
      });
    }, 10000);

    return { success: true, amount, deposit_id: newDeposit.id };

  } catch (error) {
    console.error('❌ Error processing deposit:', error.message);
    
    try {
      await supabase
        .from('deposits')
        .delete()
        .eq('txid', txid)
        .eq('network', network)
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
    const { user_id, network = 'TRC20' } = req.body;
    if (!user_id) return res.status(400).json({ success: false, error: 'User ID is required' });

    console.log(`🔐 Generating ${network} wallet for user: ${user_id}`);
    await ensureUserExists(user_id);

    const { data: existingWallet } = await supabase
      .from('user_wallets')
      .select('address')
      .eq('user_id', user_id)
      .eq('network', network)
      .single();

    if (existingWallet) {
      console.log(`✅ Wallet already exists: ${existingWallet.address} (${network})`);
      return res.json({ success: true, address: existingWallet.address, exists: true, network });
    }

    let address, private_key;

    if (network === 'TRC20') {
      const account = TronWeb.utils.accounts.generateAccount();
      address = account.address.base58;
      private_key = account.privateKey;
    } else if (network === 'BEP20') {
      const wallet = ethers.Wallet.createRandom();
      address = wallet.address;
      private_key = wallet.privateKey;
    } else {
      return res.status(400).json({ success: false, error: 'Unsupported network' });
    }

    const { data, error } = await supabase.from('user_wallets').insert({
      user_id,
      address,
      private_key,
      network,
      created_at: new Date().toISOString()
    }).select().single();

    if (error) {
      console.error('❌ Database error:', error);
      return res.status(500).json({ success: false, error: 'Failed to save wallet' });
    }

    console.log(`✅ New ${network} wallet created: ${address}`);
    setTimeout(() => checkUserDeposits(user_id, network), 5000);

    res.json({ success: true, address, exists: false, network });
  } catch (error) {
    console.error('❌ Generate wallet error:', error.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.post('/check-deposits', async (req, res) => { await handleCheckDeposits(req, res); });
app.get('/check-deposits', async (req, res) => { await handleCheckDeposits(req, res); });

async function handleCheckDeposits(req = {}, res = {}) {
  try {
    console.log('🔄 Checking deposits for all users and networks...');
    const { data: wallets, error } = await supabase.from('user_wallets').select('*').limit(200);
    if (error) throw error;

    console.log(`🔍 Checking ${wallets?.length || 0} wallets across all networks`);
    
    let processedCount = 0;
    let depositsFound = 0;
    let duplicatesSkipped = 0;

    for (const wallet of wallets || []) {
      try {
        // Add delay between wallet checks to avoid rate limits
        if (wallet.network === 'BEP20') {
          await sleep(500); // 500ms для BSC
        } else {
          await sleep(1000); // 1 second для TRC20
        }
        
        let transactions = [];

        if (wallet.network === 'TRC20') {
          transactions = await getUSDTTransactions(wallet.address);
        } else if (wallet.network === 'BEP20') {
          transactions = await getBSCTransactions(wallet.address);
        }

        for (const tx of transactions) {
          const recipient = wallet.network === 'TRC20' ? tx.to : tx.to.toLowerCase();
          const walletAddress = wallet.network === 'TRC20' ? wallet.address : wallet.address.toLowerCase();
          
          if (recipient === walletAddress && tx.token === 'USDT' && tx.amount >= MIN_DEPOSIT) {
            try {
              const result = await processDeposit(wallet, tx.amount, tx.transaction_id, wallet.network);
              if (result.success) {
                depositsFound++;
              } else if (result.reason === 'already_processed' || result.reason === 'concurrent_processing') {
                duplicatesSkipped++;
              }
            } catch (err) {
              console.error(`❌ Error processing deposit ${tx.transaction_id}:`, err.message);
            }
          }
        }

        await supabase.from('user_wallets').update({ last_checked: new Date().toISOString() }).eq('id', wallet.id);
        processedCount++;
      } catch (err) {
        console.error(`❌ Error processing wallet ${wallet.address}:`, err.message);
      }
    }

    const message = `✅ Processed ${processedCount} wallets, found ${depositsFound} new deposits, skipped ${duplicatesSkipped} duplicates`;
    console.log(message);
    if (res && typeof res.json === 'function') res.json({ success: true, message });
    return { success: true, message };
  } catch (error) {
    console.error('❌ Deposit check error:', error.message);
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
        await sleep(2000); // Increased delay to avoid rate limits
        const result = await autoCollectToMainWallet(wallet);
        if (result && result.success) {
          collectedCount++;
          totalCollected += result.amount;
          await sleep(1000);
        }
      } catch (err) {
        console.error(`❌ Error collecting from ${wallet.address}:`, err.message);
      }
    }

    const message = `✅ Collected ${totalCollected.toFixed(6)} USDT from ${collectedCount} wallets`;
    console.log(message);
    if (res && typeof res.json === 'function') res.json({ success: true, message });
    return { success: true, message };
  } catch (error) {
    console.error('❌ Funds collection error:', error.message);
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
    console.error('❌ ensureUserExists error:', error.message);
  }
}

async function checkUserDeposits(userId, network) {
  try {
    const { data: wallet } = await supabase
      .from('user_wallets')
      .select('*')
      .eq('user_id', userId)
      .eq('network', network)
      .single();
    
    if (!wallet) return;
    
    console.log(`🔍 Checking ${network} deposits for user ${userId}, wallet: ${wallet.address}`);
    
    // ДОБАВИМ ЗАДЕРЖКУ ДЛЯ BEP20
    if (network === 'BEP20') {
      await sleep(500);
    }
    
    let transactions = [];

    if (network === 'TRC20') {
      transactions = await getUSDTTransactions(wallet.address);
    } else if (network === 'BEP20') {
      transactions = await getBSCTransactions(wallet.address);
    }
    
    for (const tx of transactions) {
      const recipient = network === 'TRC20' ? tx.to : tx.to.toLowerCase();
      const walletAddress = network === 'TRC20' ? wallet.address : wallet.address.toLowerCase();
      
      if (recipient === walletAddress && tx.token === 'USDT' && tx.amount >= MIN_DEPOSIT) {
        try {
          const result = await processDeposit(wallet, tx.amount, tx.transaction_id, network);
          if (result.success) {
            console.log(`💰 FOUND NEW DEPOSIT: ${tx.amount} USDT for user ${userId} (${network})`);
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
    message: 'Tron & BSC Wallet System - MORALIS API FOR BSC',
    timestamp: new Date().toISOString(),
    networks: ['TRC20', 'BEP20'],
    features: [
      'Multi-Network Wallet Generation',
      'Deposit Processing (Atomic)',
      'Balance Updates',
      'Auto Collection (throttled)',
      'Gas Management (TRX/BNB)',
      'USDT Transfers',
      'DUPLICATE PROTECTION',
      'MORALIS API FOR BSC (40k req/day)',
      'TRONGRID API FOR TRC20'
    ]
  });
});

// ========== Scheduler (internal call) ==========
setInterval(async () => {
  try {
    console.log('🕒 AUTO-CHECK: Scanning for deposits (internal call)...');
    await handleCheckDeposits();
  } catch (err) {
    console.error('❌ Auto-check internal error:', err.message);
  }
}, CHECK_INTERVAL_MS);

// ========== START SERVER ==========
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 SERVER RUNNING on port ${PORT}`);
  console.log(`✅ SUPABASE: ${SUPABASE_URL ? 'CONNECTED' : 'MISSING'}`);
  console.log(`✅ TRONGRID: API KEY ${TRONGRID_API_KEY ? 'SET' : 'MISSING'}`);
  console.log(`✅ MORALIS API: 40K REQUESTS/DAY AVAILABLE`);
  console.log(`💰 TRC20 MASTER: ${COMPANY.MASTER.address}`);
  console.log(`💰 TRC20 MAIN: ${COMPANY.MAIN.address}`);
  console.log(`💰 BEP20 MASTER: ${COMPANY_BSC.MASTER.address}`);
  console.log(`💰 BEP20 MAIN: ${COMPANY_BSC.MAIN.address}`);
  console.log(`⏰ AUTO-CHECK: EVERY ${Math.round(CHECK_INTERVAL_MS / 1000)}s`);
  console.log(`🔧 BSC APPROACH: MORALIS API (40K req/day)`);
  console.log(`🌐 SUPPORTED NETWORKS: TRC20, BEP20`);
  console.log('===================================');
});
