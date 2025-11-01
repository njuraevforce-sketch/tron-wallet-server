// server.js — UPDATED (IMPROVED BSC RPC HANDLING + HEALTH CHECK)
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

// ========== ETHERSCAN API V2 CONFIGURATION ==========
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || 'AI7FBXG5EU2ENYZNUK988RIMEB5R68N6FT';
const ETHERSCAN_API_URL = process.env.ETHERSCAN_API_URL || 'https://api.etherscan.io/api';
const BSC_CHAIN_ID = '56';

// ========== BSC RPC CONFIGURATION ==========
const BSC_RPC_URLS = [
  'https://bsc-dataseed.binance.org/',
  'https://bsc-dataseed1.defibit.io/',
  'https://bsc-dataseed1.ninicoin.io/',
  'https://bsc-dataseed2.ninicoin.io/',
  'https://bsc-dataseed3.ninicoin.io/',
  'https://bsc-dataseed4.ninicoin.io/',
  'https://bsc-mainnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3',
  'https://1rpc.io/bnb',
  'https://bsc-mainnet.public.blastapi.io',
  'https://bsc.publicnode.com'
];

// Трекер работоспособности RPC
const rpcHealth = new Map();
BSC_RPC_URLS.forEach(url => rpcHealth.set(url, { healthy: true, lastError: 0 }));

function getHealthyBscRpc() {
  const now = Date.now();
  const healthyRpcs = BSC_RPC_URLS.filter(url => {
    const health = rpcHealth.get(url);
    return health.healthy || (now - health.lastError > 60000);
  });
  
  if (healthyRpcs.length === 0) {
    BSC_RPC_URLS.forEach(url => rpcHealth.set(url, { healthy: true, lastError: 0 }));
    return BSC_RPC_URLS[Math.floor(Math.random() * BSC_RPC_URLS.length)];
  }
  
  return healthyRpcs[Math.floor(Math.random() * healthyRpcs.length)];
}

function markRpcUnhealthy(url) {
  rpcHealth.set(url, { healthy: false, lastError: Date.now() });
  console.log(`🔴 Marked RPC as unhealthy: ${url}`);
}

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

// BSC provider with rotation
let bscProvider = new ethers.providers.JsonRpcProvider(getHealthyBscRpc());

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
  "function transfer(address to, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)"
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

// Кэш для балансов (5 минут)
const balanceCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

// ========== HELPERS ==========
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function strip0x(s) {
  if (!s) return s;
  return s.startsWith('0x') ? s.slice(2) : s;
}

function padTo32Bytes(hexWithoutPrefix) {
  return hexWithoutPrefix.padStart(64, '0');
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

// ========== TronGrid request with retry/backoff ==========
async function trongridRequestWithRetry(path, opts = {}, retries = 4, backoffMs = 800) {
  const base = 'https://api.trongrid.io/';
  
  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'TRON-PRO-API-KEY': TRONGRID_API_KEY,
    ...opts.headers
  };
  
  const options = {
    ...opts,
    headers
  };
  
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(base + path, options);
      if (res.status === 429) {
        const wait = backoffMs * Math.pow(2, attempt);
        console.warn(`TronGrid 429 — wait ${wait}ms (attempt ${attempt + 1}/${retries + 1})`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        const txt = await res.text().catch(() => '<no body>');
        throw new Error(`TronGrid HTTP ${res.status}: ${txt}`);
      }
      return await res.json();
    } catch (e) {
      if (attempt === retries) throw e;
      const wait = backoffMs * Math.pow(2, attempt);
      console.warn(`TronGrid request error (attempt ${attempt + 1}), retrying in ${wait}ms: ${e.message}`);
      await sleep(wait);
    }
  }
  throw new Error('TronGrid retry exhausted');
}

// ========== BSC FUNCTIONS ==========
async function getBSCUSDTBalance(address) {
  try {
    const contract = new ethers.Contract(USDT_BSC_CONTRACT, USDT_ABI, bscProvider);
    const balance = await contract.balanceOf(address);
    return Number(ethers.utils.formatUnits(balance, 6));
  } catch (error) {
    console.error('❌ BSC USDT balance error:', error.message);
    return 0;
  }
}

async function getCachedBSCUSDTBalance(address) {
  const cacheKey = `bsc_usdt_${address}`;
  const cached = balanceCache.get(cacheKey);
  
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
    return cached.balance;
  }
  
  const balance = await getBSCUSDTBalance(address);
  balanceCache.set(cacheKey, { balance, timestamp: Date.now() });
  return balance;
}

// Улучшенный RPC fallback с адаптивными чанками
async function getBSCTransactionsRpcFallback(address) {
  const transactions = [];
  
  try {
    let latestBlock;
    let currentRpc = getHealthyBscRpc();
    
    // Получаем последний блок с ротацией при ошибках
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        bscProvider = new ethers.providers.JsonRpcProvider(currentRpc);
        latestBlock = await bscProvider.getBlockNumber();
        break;
      } catch (e) {
        console.warn(`⚠️ Failed to get block from ${currentRpc}: ${e.message}`);
        markRpcUnhealthy(currentRpc);
        currentRpc = getHealthyBscRpc();
        await sleep(1000 * (attempt + 1));
      }
    }
    
    if (!latestBlock) {
      console.error('❌ Failed to get latest block from all RPCs');
      return [];
    }

    const blocksRange = Number(process.env.BSC_SCAN_BLOCKS || 2000);
    const fromBlock = Math.max(latestBlock - blocksRange, 0);
    const toBlock = latestBlock;
    
    let CHUNK_SIZE = Number(process.env.BSC_CHUNK_SIZE || 500);

    console.log(`📦 Scanning blocks ${fromBlock} to ${toBlock} with chunk size ${CHUNK_SIZE}`);

    const filterTopic0 = ethers.utils.id('Transfer(address,address,uint256)');
    
    for (let start = fromBlock; start <= toBlock; start += CHUNK_SIZE) {
      const end = Math.min(start + CHUNK_SIZE - 1, toBlock);
      
      let events = null;
      let chunkAttempts = 0;
      const maxChunkAttempts = 3;
      
      while (chunkAttempts < maxChunkAttempts) {
        try {
          const toTopic = '0x' + padTo32Bytes(strip0x(address));
          const filter = {
            address: USDT_BSC_CONTRACT,
            fromBlock: start,
            toBlock: end,
            topics: [filterTopic0, null, toTopic]
          };

          events = await bscProvider.getLogs(filter);
          break;
        } catch (err) {
          chunkAttempts++;
          
          if (err.message && err.message.includes('limit exceeded')) {
            console.warn(`⚠️ Rate limit on chunk ${start}-${end}, reducing chunk size...`);
            CHUNK_SIZE = Math.max(100, Math.floor(CHUNK_SIZE * 0.7));
            markRpcUnhealthy(currentRpc);
            currentRpc = getHealthyBscRpc();
            bscProvider = new ethers.providers.JsonRpcProvider(currentRpc);
          }
          
          console.warn(`⚠️ Chunk ${start}-${end} attempt ${chunkAttempts} failed: ${err.message}`);
          
          if (chunkAttempts >= maxChunkAttempts) {
            console.warn(`❌ Chunk ${start}-${end} failed after ${maxChunkAttempts} attempts, skipping`);
            break;
          }
          
          const backoff = 1000 * Math.pow(2, chunkAttempts);
          await sleep(backoff);
        }
      }

      if (events) {
        for (const ev of events) {
          try {
            const from = '0x' + ev.topics[1].slice(26);
            const to = '0x' + ev.topics[2].slice(26);
            const valueBn = ethers.BigNumber.from(ev.data);
            const amount = Number(ethers.utils.formatUnits(valueBn, 6));

            if (to.toLowerCase() === address.toLowerCase()) {
              transactions.push({
                transaction_id: ev.transactionHash,
                to,
                from,
                amount,
                token: 'USDT',
                confirmed: true,
                network: 'BEP20'
              });
            }
          } catch (inner) {
            continue;
          }
        }
      }
      
      await sleep(500);
    }

    console.log(`✅ RPC fallback found ${transactions.length} transactions for ${address}`);
    return transactions;

  } catch (error) {
    console.error('❌ RPC fallback fatal error:', error.message);
    return [];
  }
}

// Improved getBSCTransactions: Etherscan V2 first, then improved RPC fallback
async function getBSCTransactions(address) {
  try {
    if (!address) return [];

    // 1) Try Etherscan V2 (multichain) with chainid=56
    try {
      const params = new URLSearchParams({
        chainid: BSC_CHAIN_ID,
        module: 'account',
        action: 'tokentx',
        address: address,
        contractaddress: USDT_BSC_CONTRACT,
        page: '1',
        offset: '100',
        sort: 'desc',
        apikey: ETHERSCAN_API_KEY
      });

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(`${ETHERSCAN_API_URL}?${params}`, {
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();

        if (data && data.status === '1' && Array.isArray(data.result)) {
          console.log(`✅ Etherscan V2: Found ${data.result.length} transactions for ${address}`);
          const transactions = [];
          for (const tx of data.result) {
            try {
              if (tx.to && tx.to.toLowerCase() === address.toLowerCase() &&
                  tx.contractAddress && tx.contractAddress.toLowerCase() === USDT_BSC_CONTRACT.toLowerCase()) {
                transactions.push({
                  transaction_id: tx.hash,
                  to: tx.to,
                  from: tx.from,
                  amount: Number(tx.value) / 1e6,
                  token: 'USDT',
                  confirmed: tx.confirmations ? Number(tx.confirmations) > 0 : true,
                  network: 'BEP20'
                });
              }
            } catch (e) { continue; }
          }
          return transactions;
        } else {
          console.log(`⚠️ Etherscan V2 returned: ${data.message || 'empty/NOTOK'}`);
        }
      }
    } catch (apiError) {
      console.log(`⚠️ Etherscan V2 failed: ${apiError.message}`);
    }

    // 2) Improved RPC fallback with adaptive chunks
    console.log(`🔄 Using improved RPC fallback for BSC transactions: ${address}`);
    return await getBSCTransactionsRpcFallback(address);
    
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
    return 0;
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
    return false;
  }
}

async function transferBSCUSDT(fromPrivateKey, toAddress, amount) {
  try {
    const wallet = new ethers.Wallet(fromPrivateKey, bscProvider);
    const contract = new ethers.Contract(USDT_BSC_CONTRACT, USDT_ABI, wallet);
    
    const amountInWei = ethers.utils.parseUnits(amount.toString(), 6);
    const tx = await contract.transfer(toAddress, amountInWei);
    
    await tx.wait();
    console.log(`✅ BSC USDT transfer: ${amount} USDT to ${toAddress}, txid: ${tx.hash}`);
    return true;
  } catch (error) {
    console.error('❌ BSC USDT transfer error:', error.message);
    return false;
  }
}

// ========== TRON FUNCTIONS ==========
async function getUSDTBalance(address) {
  return enqueueBalanceJob(async () => {
    try {
      if (!address) {
        console.warn('getUSDTBalance: empty address');
        return 0;
      }

      let ownerHex;
      try {
        ownerHex = tronWeb.address.toHex(address);
      } catch (e) {
        console.warn('getUSDTBalance: tronWeb.address.toHex failed for address', address, e && e.message);
        if (typeof address === 'string' && address.startsWith('41')) {
          ownerHex = address;
        } else {
          return 0;
        }
      }

      ownerHex = strip0x(ownerHex);

      let contractHex;
      try {
        contractHex = tronWeb.address.toHex(USDT_CONTRACT);
      } catch (e) {
        contractHex = USDT_CONTRACT;
      }
      contractHex = strip0x(contractHex);

      const param = padTo32Bytes(ownerHex);

      const body = {
        contract_address: contractHex,
        owner_address: ownerHex,
        function_selector: 'balanceOf(address)',
        parameter: param,
        call_value: 0
      };

      const json = await trongridRequestWithRetry('wallet/triggerconstantcontract', {
        method: 'POST',
        body: JSON.stringify(body)
      }, 3, 800);

      if (!json) {
        console.warn('getUSDTBalance: empty json', { address });
        return 0;
      }

      if (json.Error || json.error) {
        console.warn('getUSDTBalance: tronGrid returned error', { address, err: json.Error || json.error });
        return 0;
      }

      const constRes = json.constant_result || json.constantResult || json.constantResults;
      if (!constRes || !Array.isArray(constRes) || constRes.length === 0) {
        console.warn('getUSDTBalance: no constant_result in response', { address, json });
        return 0;
      }

      const hexBalance = String(constRes[0] || '0').replace(/^0x/, '');
      const clean = hexBalance.replace(/^0+/, '') || '0';
      let bn;
      try {
        bn = BigInt('0x' + clean);
      } catch (parseErr) {
        console.error('getUSDTBalance: BigInt parse failed', { address, hexBalance, parseErr });
        return 0;
      }

      const amount = Number(bn) / 1_000_000;
      return amount;
    } catch (err) {
      console.error('❌ getUSDTBalance fatal error:', err && err.message ? err.message : err);
      return 0;
    }
  });
}

async function getUSDTTransactions(address) {
  try {
    if (!address) return [];
    const path = `v1/accounts/${address}/transactions/trc20?limit=30&only_confirmed=true`;
    const json = await trongridRequestWithRetry(path, {}, 3, 800);

    const raw = json.data || [];
    const transactions = [];

    for (const tx of raw) {
      try {
        const tokenAddr = tx.token_info?.address || tx.contract || tx.tokenInfo?.address;
        if (!tokenAddr) continue;
        if (tokenAddr !== USDT_CONTRACT) continue;

        const to = toBase58IfHex(tx.to || tx.to_address);
        const from = toBase58IfHex(tx.from || tx.from_address);
        const rawValue = tx.value ?? tx.amount ?? tx.quantity ?? 0;
        const amount = Number(rawValue) / 1_000_000;

        transactions.push({
          transaction_id: tx.transaction_id || tx.txid || tx.hash,
          to,
          from,
          amount,
          token: 'USDT',
          confirmed: !!tx.confirmed,
          network: 'TRC20'
        });
      } catch (innerErr) {
        console.warn('Skipping malformed tx item', innerErr && innerErr.message ? innerErr.message : innerErr);
        continue;
      }
    }

    return transactions;
  } catch (error) {
    console.error('❌ getUSDTTransactions error:', error && error.message ? error.message : error);
    return [];
  }
}

async function getTRXBalance(address) {
  try {
    const json = await trongridRequestWithRetry(`v1/accounts/${address}`, {}, 3, 800);
    
    if (json && json.data && json.data.length > 0) {
      const balance = json.data[0].balance || 0;
      return balance / 1_000_000;
    }
    return 0;
  } catch (error) {
    console.error('❌ TRX balance error:', error && error.message ? error.message : error);
    return 0;
  }
}

async function sendTRX(fromPrivateKey, toAddress, amount) {
  try {
    const pk = normalizePrivateKeyForTron(fromPrivateKey);
    if (!pk) {
      console.error('sendTRX: missing private key');
      return false;
    }

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
    
    const broadcastResult = await trongridRequestWithRetry('wallet/broadcasttransaction', {
      method: 'POST',
      body: JSON.stringify(signedTransaction)
    }, 3, 800);

    if (broadcastResult && broadcastResult.result === true) {
      console.log(`✅ TRX sent: ${amount} TRX to ${toAddress}, txid: ${broadcastResult.txid}`);
      return true;
    } else {
      console.error('❌ TRX send failed:', broadcastResult);
      return false;
    }
  } catch (error) {
    console.error('❌ TRX send error:', error && error.message ? error.message : error);
    return false;
  }
}

async function transferUSDT(fromPrivateKey, toAddress, amount) {
  try {
    const pk = normalizePrivateKeyForTron(fromPrivateKey);
    if (!pk) {
      console.error('transferUSDT: missing private key');
      return false;
    }

    const tronWebForSigning = new TronWeb({
      fullHost: 'https://api.trongrid.io',
      privateKey: pk
    });

    const contract = await tronWebForSigning.contract().at(USDT_CONTRACT);
    const amountInSun = Math.floor(amount * 1_000_000);

    console.log(`🔄 Sending ${amount} USDT to ${toAddress}...`);
    const result = await contract.transfer(toAddress, amountInSun).send();
    
    if (result && (result.result === true || result.transaction || result.txid)) {
      console.log(`✅ USDT transfer submitted: ${amount} USDT to ${toAddress}`);
      return true;
    } else {
      console.error('❌ USDT transfer returned unexpected result:', result);
      return false;
    }
  } catch (error) {
    console.error('❌ USDT transfer error:', error && error.message ? error.message : error);
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
      usdtBalance = await getCachedBSCUSDTBalance(wallet.address);
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
    
    const bscWallets = wallets.filter(w => w.network === 'BEP20');
    const trcWallets = wallets.filter(w => w.network === 'TRC20');
    
    let processedCount = 0;
    let depositsFound = 0;
    let duplicatesSkipped = 0;

    // Process TRC20 wallets first (faster)
    for (const wallet of trcWallets) {
      try {
        await sleep(200);
        const transactions = await getUSDTTransactions(wallet.address);
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
        console.error(`❌ Error processing TRC20 wallet ${wallet.address}:`, err.message);
      }
    }

    // Then process BSC wallets (slower but with API priority)
    for (const wallet of bscWallets) {
      try {
        await sleep(3000);
        const transactions = await getBSCTransactions(wallet.address);
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
        console.error(`❌ Error processing BSC wallet ${wallet.address}:`, err.message);
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
        await sleep(200);
        const result = await autoCollectToMainWallet(wallet);
        if (result && result.success) {
          collectedCount++;
          totalCollected += result.amount;
          await sleep(500);
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
    message: 'Tron & BSC Wallet System - IMPROVED BSC RPC HANDLING',
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
      'Etherscan API V2 Integration',
      'IMPROVED BSC RPC HEALTH CHECKING',
      'ADAPTIVE CHUNK SIZING',
      'RPC ROTATION WITH BACKOFF'
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
  console.log(`✅ BSC RPC: ${BSC_RPC_URLS.length} PROVIDERS WITH HEALTH CHECKING`);
  console.log(`✅ ETHERSCAN API V2: KEY SET (${ETHERSCAN_API_KEY.substring(0, 8)}...)`);
  console.log(`💰 TRC20 MASTER: ${COMPANY.MASTER.address}`);
  console.log(`💰 TRC20 MAIN: ${COMPANY.MAIN.address}`);
  console.log(`💰 BEP20 MASTER: ${COMPANY_BSC.MASTER.address}`);
  console.log(`💰 BEP20 MAIN: ${COMPANY_BSC.MAIN.address}`);
  console.log(`⏰ AUTO-CHECK: EVERY ${Math.round(CHECK_INTERVAL_MS / 1000)}s`);
  console.log(`🔧 THROTTLING: ${BALANCE_CONCURRENCY} concurrent requests`);
  console.log(`🌐 SUPPORTED NETWORKS: TRC20, BEP20`);
  console.log('===================================');
});
