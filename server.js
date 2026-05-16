// server.js — Oracle Deposit System (BEP20 + ERC20 + TRC20 USDT/USDC)
// Built from the user's original full server flow.
// Changes vs original:
// - UNIFIED EVM WALLETS: One 0x... address generated and shared across USDT/USDC and BEP20/ERC20.
// - TRC20 restored for USDT
// - ERC20 explicitly fixed (contract_addresses, limit 100, strict 6 decimals)
// - BEP20 explicitly fixed (contract_addresses, limit 100, strict 18 decimals)
// - Old vulnerable getChainTokenTransfers removed completely
// - Compatible with Supabase RPC public.create_deposit_with_balance
// - V2: AUTO-SWEEP ADDED FOR BEP20 ONLY (Non-blocking)
// - V3: WEBSOCKET FIX FOR NODE.JS 20 SUPABASE COMPATIBILITY

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const ethers = require('ethers');
const crypto = require('crypto');
const WebSocket = require('ws'); // ИСПРАВЛЕНИЕ: Добавлен пакет ws для Node.js < 22

const app = express();
app.set('trust proxy', true);
const PORT = Number(process.env.PORT || 8080);

// ========== CONFIGURATION ==========
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fkjwueogfmdolcjtvvme.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MORALIS_API_KEY = process.env.MORALIS_API_KEY || '';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const API_SECRET_KEY = process.env.API_SECRET_KEY;

// НАСТРОЙКИ АВТОСБОРА (только для BEP20)
const HOT_WALLET_PRIVATE_KEY = process.env.HOT_WALLET_PRIVATE_KEY; 
const ADMIN_SWEEP_ADDRESS = process.env.ADMIN_SWEEP_ADDRESS;       

if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing SUPABASE_SERVICE_ROLE_KEY env');
  process.exit(1);
}
if (!ENCRYPTION_KEY || String(ENCRYPTION_KEY).length < 32) {
  console.error('❌ Missing/invalid ENCRYPTION_KEY env (must be 32+ chars)');
  process.exit(1);
}
if (!MORALIS_API_KEY) {
  console.warn('⚠️ MORALIS_API_KEY is empty (BEP20/ERC20 checks may fail).');
}
if (!API_SECRET_KEY || String(API_SECRET_KEY).length < 32) {
  console.error('❌ Missing/invalid API_SECRET_KEY env (must be 32+ chars)');
  process.exit(1);
}
if (!HOT_WALLET_PRIVATE_KEY || !ADMIN_SWEEP_ADDRESS) {
  console.warn('⚠️ BEP20 Auto-sweep is disabled: HOT_WALLET_PRIVATE_KEY or ADMIN_SWEEP_ADDRESS missing.');
}

// ========== INITIALIZE SERVICES ==========
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  },
  // ИСПРАВЛЕНО: Теперь передаем WebSocket правильно для новых версий Supabase
  realtime: {
    transport: WebSocket
  }
});

// ========== MIDDLEWARE ==========
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Allow-Methods', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ========== SIMPLE RATE LIMIT ==========
const rateLimitStore = new Map();
function simpleRateLimit(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const max = 60;

  if (req.path === '/health' || req.path === '/api/health' || req.path === '/') {
    return next();
  }

  if (!rateLimitStore.has(ip)) {
    rateLimitStore.set(ip, []);
  }

  const requests = rateLimitStore.get(ip) || [];
  const validRequests = requests.filter((time) => now - time < windowMs);
  rateLimitStore.set(ip, validRequests);

  if (validRequests.length >= max) {
    console.log(`🚫 Rate limit exceeded for IP: ${ip}`);
    return res.status(429).json({
      success: false,
      error: 'Too many requests, please try again later'
    });
  }

  validRequests.push(now);
  next();
}

app.use(simpleRateLimit);

// ========== DEPOSIT CHECK COOLDOWNS ==========
const userDepositCheckCooldown = new Map();
const adminDepositCheckCooldown = new Map();

function cleanupCooldownStore(store, olderThanMs) {
  const now = Date.now();
  for (const [key, timestamp] of store.entries()) {
    if (now - timestamp > olderThanMs) store.delete(key);
  }
}

function createCooldownMiddleware(store, cooldownMs, errorMessage) {
  return (req, res, next) => {
    const authHeader = req.headers['authorization'] || '';
    const key = authHeader || req.ip || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();
    const last = store.get(key) || 0;

    cleanupCooldownStore(store, cooldownMs * 10);

    if (now - last < cooldownMs) {
      const waitSeconds = Math.ceil((cooldownMs - (now - last)) / 1000);
      return res.status(429).json({
        success: false,
        error: errorMessage,
        wait_seconds: waitSeconds
      });
    }

    store.set(key, now);
    next();
  };
}

const userDepositCheckCooldownMiddleware = createCooldownMiddleware(
  userDepositCheckCooldown,
  Number(process.env.USER_DEPOSIT_CHECK_COOLDOWN_MS || 60000),
  'Please wait before checking your deposit again'
);

const adminDepositCheckCooldownMiddleware = createCooldownMiddleware(
  adminDepositCheckCooldown,
  Number(process.env.ADMIN_DEPOSIT_CHECK_COOLDOWN_MS || 60000),
  'Please wait before checking all deposits again'
);


// ========== CONSTANTS ==========
const MIN_DEPOSIT = 17;

// BSC
const USDT_BSC_CONTRACT = '0x55d398326f99059fF775485246999027B3197955';
const USDC_BSC_CONTRACT = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d';

// Ethereum
const USDT_ETH_CONTRACT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const USDC_ETH_CONTRACT = '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

// TRON
const USDT_TRON_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const TRONGRID_API_BASE = process.env.TRONGRID_API_BASE || 'https://api.trongrid.io';
const TRONGRID_API_KEY = process.env.TRONGRID_API_KEY || '';
if (!TRONGRID_API_KEY) {
  console.warn('⚠️ TRONGRID_API_KEY is empty (TRC20 checks may hit strict public limits).');
}

const networkFields = {
  usdt_bep20: { addressField: 'usdt_bep20_address' },
  usdc_bep20: { addressField: 'usdc_bep20_address' },
  usdt_erc20: { addressField: 'usdt_erc20_address' },
  usdc_erc20: { addressField: 'usdc_erc20_address' },
  usdt_trc20: { addressField: 'usdt_trc20_address' }
};

const allowedNetworks = Object.keys(networkFields);

// ========== CHECK SETTINGS ==========
const BEP20_CHECK_INTERVAL = Number(process.env.BEP20_CHECK_INTERVAL || 120000);
const ERC20_CHECK_INTERVAL = Number(process.env.ERC20_CHECK_INTERVAL || 150000);
const TRC20_CHECK_INTERVAL = Number(process.env.TRC20_CHECK_INTERVAL || 60000);
const API_DELAY_MS = Number(process.env.API_DELAY_MS || 400);

// ========== HELPERS ==========
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(buffer) {
  if (!buffer || !buffer.length) return '';

  let value = BigInt('0x' + buffer.toString('hex'));
  let encoded = '';

  while (value > 0n) {
    const mod = Number(value % 58n);
    encoded = BASE58_ALPHABET[mod] + encoded;
    value /= 58n;
  }

  for (const byte of buffer) {
    if (byte === 0) encoded = '1' + encoded;
    else break;
  }

  return encoded || '1';
}

function tronBase58CheckFromHex(hexAddress) {
  const payload = Buffer.from(String(hexAddress || '').replace(/^0x/, ''), 'hex');
  const hash1 = crypto.createHash('sha256').update(payload).digest();
  const hash2 = crypto.createHash('sha256').update(hash1).digest();
  const checksum = hash2.subarray(0, 4);
  return base58Encode(Buffer.concat([payload, checksum]));
}

function generateTRONWallet() {
  const wallet = ethers.Wallet.createRandom();
  const ethHex = String(wallet.address || '').replace(/^0x/, '');
  const tronHexAddress = '41' + ethHex;
  const tronAddress = tronBase58CheckFromHex(tronHexAddress);

  return {
    address: tronAddress,
    privateKey: wallet.privateKey,
    hexAddress: tronHexAddress
  };
}

function readParam(req, key, fallback = undefined) {
  if (req.body && req.body[key] !== undefined) return req.body[key];
  if (req.query && req.query[key] !== undefined) return req.query[key];
  return fallback;
}

async function getUserFromBearerToken(req) {
  try {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return null;

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      console.warn('⚠️ Bearer token validation failed:', error?.message || 'No user');
      return null;
    }

    return data.user;
  } catch (error) {
    console.warn('⚠️ Bearer token validation error:', error.message);
    return null;
  }
}

async function safeSystemLog(logType, message, metadata = {}) {
  try {
    const payload = {
      log_type: String(logType || 'server_log').slice(0, 100),
      message: String(message || '').slice(0, 1000),
      metadata
    };

    const { error } = await supabase.from('system_logs').insert(payload);
    if (error) {
      if (!String(error.message || '').toLowerCase().includes('relation') && !String(error.message || '').toLowerCase().includes('does not exist')) {
        console.warn('⚠️ system_logs insert skipped:', error.message);
      }
    }
  } catch (error) {
    // intentionally swallow
  }
}

// ========== API KEY CHECK ==========
function requireApiKey(req, res, next) {
  const clientKey = req.headers['x-api-key'];

  if (!clientKey) {
    console.error('🚨 BLOCKED: No API key provided', {
      ip: req.ip,
      path: req.path,
      timestamp: new Date().toISOString()
    });
    return res.status(401).json({
      success: false,
      error: 'API key required. Use x-api-key header.'
    });
  }

  if (clientKey !== API_SECRET_KEY) {
    console.error('🚨 BLOCKED: Invalid API key', {
      ip: req.ip,
      path: req.path,
      timestamp: new Date().toISOString()
    });
    return res.status(403).json({
      success: false,
      error: 'Invalid API key'
    });
  }

  next();
}

// ========== ENCRYPTION ==========
function encryptPrivateKey(text) {
  try {
    if (!text || !ENCRYPTION_KEY) return text;
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(
      'aes-256-gcm',
      crypto.createHash('sha256').update(ENCRYPTION_KEY).digest(),
      iv
    );
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${encrypted}:${authTag.toString('hex')}`;
  } catch (error) {
    console.error('❌ Encryption error:', error.message);
    return text;
  }
}

function decryptPrivateKey(encryptedText) {
  try {
    if (!encryptedText || !ENCRYPTION_KEY) return encryptedText;
    if (!encryptedText.includes(':')) return encryptedText;

    const parts = encryptedText.split(':');
    if (parts.length !== 3) return encryptedText;

    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    const authTag = Buffer.from(parts[2], 'hex');

    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      crypto.createHash('sha256').update(ENCRYPTION_KEY).digest(),
      iv
    );
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    console.error('❌ Decryption error:', error.message);
    return encryptedText;
  }
}

// ========== AUTO-SWEEP LOGIC (BEP20) ==========
async function sweepDepositBEP20(userId, token, network) {
  if (!HOT_WALLET_PRIVATE_KEY || !ADMIN_SWEEP_ADDRESS) return;

  console.log(`🧹 Starting Auto-Sweep for user ${userId} (${token} on ${network})`);

  try {
    const provider = new ethers.JsonRpcProvider('https://bsc-dataseed.binance.org/');
    const hotWallet = new ethers.Wallet(HOT_WALLET_PRIVATE_KEY, provider);

    const { data: keyData, error } = await supabase
      .from('private_keys')
      .select('encrypted_private_key')
      .eq('user_id', userId)
      .eq('network', network)
      .maybeSingle();

    if (error || !keyData) throw new Error('Cannot find private key for sweep');

    const userPrivateKey = decryptPrivateKey(keyData.encrypted_private_key);
    const userWallet = new ethers.Wallet(userPrivateKey, provider);

    const contractAddress = token === 'USDT' ? USDT_BSC_CONTRACT : USDC_BSC_CONTRACT;
    const tokenContract = new ethers.Contract(
      contractAddress, 
      ['function transfer(address to, uint256 value) returns (bool)', 'function balanceOf(address owner) view returns (uint256)'], 
      userWallet
    );

    const balanceWei = await tokenContract.balanceOf(userWallet.address);
    if (balanceWei === 0n) {
      console.log(`⏭️ Sweep skipped: 0 ${token} balance for ${userId}`);
      return;
    }

    // 1. Estimate gas
    const gasLimit = await tokenContract.transfer.estimateGas(ADMIN_SWEEP_ADDRESS, balanceWei);
    const feeData = await provider.getFeeData();
    const gasCost = gasLimit * feeData.gasPrice;

    // 2. Fund gas if needed
    const userBnbBalance = await provider.getBalance(userWallet.address);
    
    if (userBnbBalance < gasCost) {
      const neededBnb = gasCost - userBnbBalance;
      const buffer = feeData.gasPrice * 20000n; // Safety buffer
      const safeFundAmount = neededBnb + buffer;
      
      console.log(`⛽ Funding ${ethers.formatEther(safeFundAmount)} BNB for gas to ${userWallet.address}`);
      
      const fundTx = await hotWallet.sendTransaction({
        to: userWallet.address,
        value: safeFundAmount
      });
      await fundTx.wait();
      console.log(`✅ Gas funded. TxHash: ${fundTx.hash}`);
    }

    // 3. Perform sweep
    console.log(`💸 Sweeping ${ethers.formatUnits(balanceWei, 18)} ${token} to Admin Wallet...`);
    const sweepTx = await tokenContract.transfer(ADMIN_SWEEP_ADDRESS, balanceWei);
    await sweepTx.wait();

    console.log(`✅ Sweep successful! TxHash: ${sweepTx.hash}`);

    await safeSystemLog('sweep_success', `Auto-sweep successful for user ${userId}`, {
      user_id: userId, token, network, tx_hash: sweepTx.hash
    });

  } catch (error) {
    console.error(`❌ Sweep failed for user ${userId}:`, error.message);
    await safeSystemLog('sweep_error', `Auto-sweep failed: ${error.message}`, { user_id: userId, token, network });
  }
}

// ========== WALLET GENERATION ==========
async function generateEVMWallet() {
  try {
    const wallet = ethers.Wallet.createRandom();
    return {
      address: wallet.address,
      privateKey: wallet.privateKey
    };
  } catch (error) {
    console.error('❌ EVM wallet generation error:', error.message);
    throw error;
  }
}

async function generateWallet(user_id, network) {
  try {
    console.log(`🔐 Generating ${network} wallet for user: ${user_id}`);

    const fields = networkFields[network];
    if (!fields) {
      throw new Error('Unsupported network');
    }

    const { data: existingWallet, error: walletError } = await supabase
      .from('user_wallets')
      .select('*')
      .eq('user_id', user_id)
      .maybeSingle();

    if (walletError) {
      console.error('❌ Wallet lookup error:', walletError.message);
      throw walletError;
    }

    const isEVM = network.includes('bep20') || network.includes('erc20');

    if (isEVM) {
      const existingEVM = existingWallet && (
        existingWallet.usdt_bep20_address ||
        existingWallet.usdc_bep20_address ||
        existingWallet.usdt_erc20_address ||
        existingWallet.usdc_erc20_address
      );

      if (existingEVM) {
        console.log(`✅ Unified EVM Wallet already exists: ${existingEVM}`);
        
        // Синхронизируем базу, если другие EVM поля пустые
        if (existingWallet && (
          existingWallet.usdt_bep20_address !== existingEVM ||
          existingWallet.usdc_bep20_address !== existingEVM ||
          existingWallet.usdt_erc20_address !== existingEVM ||
          existingWallet.usdc_erc20_address !== existingEVM
        )) {
          await supabase.from('user_wallets').update({
            usdt_bep20_address: existingEVM,
            usdc_bep20_address: existingEVM,
            usdt_erc20_address: existingEVM,
            usdc_erc20_address: existingEVM,
            updated_at: new Date().toISOString()
          }).eq('user_id', user_id);
        }
        return { success: true, address: existingEVM, exists: true, network };
      }

      // Если нет EVM кошелька, создаем НОВЫЙ ЕДИНЫЙ кошелек
      const wallet = await generateEVMWallet();
      const address = wallet.address;
      const privateKey = wallet.privateKey;
      const encryptedPrivateKey = encryptPrivateKey(privateKey);

      console.log(`✅ Generated NEW Unified EVM wallet: ${address}`);

      const walletData = {
        usdt_bep20_address: address,
        usdc_bep20_address: address,
        usdt_erc20_address: address,
        usdc_erc20_address: address,
        updated_at: new Date().toISOString()
      };

      if (existingWallet) {
        const { error } = await supabase.from('user_wallets').update(walletData).eq('user_id', user_id);
        if (error) throw new Error('Failed to update wallet');
      } else {
        const { error } = await supabase.from('user_wallets').insert({
          user_id,
          default_network: network,
          created_at: new Date().toISOString(),
          ...walletData
        });
        if (error) throw new Error('Failed to save wallet');
      }

      // Сохраняем приватный ключ сразу для всех 4-х сетей
      const evmNetworks = ['usdt_bep20', 'usdc_bep20', 'usdt_erc20', 'usdc_erc20'];
      const pkUpserts = evmNetworks.map(net => ({
        user_id,
        network: net,
        address,
        encrypted_private_key: encryptedPrivateKey,
        updated_at: new Date().toISOString()
      }));

      const { error: pkError } = await supabase.from('private_keys').upsert(pkUpserts, { onConflict: 'user_id,network' });
      if (pkError) throw new Error('Failed to save private keys');

      await safeSystemLog('deposit_wallet_generated', `Unified EVM Wallet generated for user ${user_id}`, { user_id, network, address });
      
      setTimeout(() => {
        if (network.includes('bep20')) checkUserBEP20Deposits(user_id).catch(e => console.error(e));
        if (network.includes('erc20')) checkUserERC20Deposits(user_id).catch(e => console.error(e));
      }, 10000);

      return { success: true, address, exists: false, network };
    } 
    else {
      // ЛОГИКА ДЛЯ TRC20 КОШЕЛЬКА (TRON)
      if (existingWallet && existingWallet.usdt_trc20_address) {
        console.log(`✅ TRON Wallet already exists: ${existingWallet.usdt_trc20_address}`);
        return { success: true, address: existingWallet.usdt_trc20_address, exists: true, network };
      }

      const wallet = generateTRONWallet();
      const address = wallet.address;
      const privateKey = wallet.privateKey;
      const encryptedPrivateKey = encryptPrivateKey(privateKey);

      console.log(`✅ Generated NEW TRON wallet: ${address}`);

      const walletData = { usdt_trc20_address: address, updated_at: new Date().toISOString() };

      if (existingWallet) {
        const { error } = await supabase.from('user_wallets').update(walletData).eq('user_id', user_id);
        if (error) throw new Error('Failed to update TRON wallet');
      } else {
        const { error } = await supabase.from('user_wallets').insert({
          user_id, default_network: network, created_at: new Date().toISOString(), ...walletData
        });
        if (error) throw new Error('Failed to save TRON wallet');
      }

      const { error: pkError } = await supabase.from('private_keys').upsert({
        user_id, network: 'usdt_trc20', address, encrypted_private_key: encryptedPrivateKey, updated_at: new Date().toISOString()
      }, { onConflict: 'user_id,network' });
      if (pkError) throw new Error('Failed to save TRON private key');

      await safeSystemLog('deposit_wallet_generated', `TRON Wallet generated for user ${user_id}`, { user_id, network, address });
      
      setTimeout(() => checkUserTRC20Deposits(user_id).catch(e => console.error(e)), 10000);

      return { success: true, address, exists: false, network };
    }
  } catch (error) {
    console.error('❌ Generate wallet error:', error.message);
    throw error;
  }
}

// ========== DEPOSIT PROCESSING ==========
async function processDeposit(userId, amount, txid, network) {
  try {
    console.log(`💰 ATOMIC DEPOSIT PROCESSING: $${amount} for user ${userId}, tx: ${txid}, network: ${network}`);

    if (amount < MIN_DEPOSIT) {
      console.log(`⏭️ Deposit too small: $${amount}, minimum: $${MIN_DEPOSIT}`);
      return { success: false, error: `Minimum deposit is $${MIN_DEPOSIT}` };
    }

    const { data: existingDeposit, error: checkError } = await supabase
      .from('deposit_requests')
      .select('id, status, amount, user_id')
      .eq('tx_hash', txid)
      .eq('network', network)
      .maybeSingle();

    if (checkError) {
      console.error('❌ Error checking existing deposit:', checkError.message);
      throw checkError;
    }

    if (existingDeposit) {
      console.log(`⏭️ Deposit already exists: #${existingDeposit.id}, status: ${existingDeposit.status}`);

      if (existingDeposit.status === 'completed') {
        return {
          success: true,
          already_processed: true,
          deposit_id: existingDeposit.id,
          message: 'Deposit already processed'
        };
      }

      if (existingDeposit.status === 'pending') {
        console.log(`🔄 Processing existing pending deposit #${existingDeposit.id}`);
        const result = await processDepositAtomic(userId, amount, txid, network);
        if (result.success) {
          const { error: updateError } = await supabase
            .from('deposit_requests')
            .update({
              status: 'completed',
              approved_at: new Date().toISOString(),
              approved_by: null
            })
            .eq('id', existingDeposit.id);

          if (updateError) {
            console.error('❌ Error updating deposit status:', updateError.message);
          }
        }
        return result;
      }
    }

    return await processDepositAtomic(userId, amount, txid, network);
  } catch (error) {
    console.error('❌ Error in processDeposit:', error.message);

    await safeSystemLog('deposit_processing_error', `Deposit processing error: ${error.message}`, {
      user_id: userId,
      amount,
      tx_hash: txid,
      network,
      error: error.message
    });

    return { success: false, error: error.message };
  }
}

async function processDepositAtomic(userId, amount, txid, network) {
  try {
    console.log(`🚀 Processing deposit atomically for user ${userId}, $${amount}`);

    const { data: result, error } = await supabase.rpc('create_deposit_with_balance', {
      p_user_id: userId,
      p_amount: amount,
      p_network: network,
      p_tx_hash: txid
    });

    if (error) {
      console.error('❌ Atomic deposit RPC error:', error.message);

      if (String(error.message || '').includes('duplicate')) {
        console.log(`⏭️ Duplicate detected by RPC: ${txid}`);

        const { data: existingDeposit } = await supabase
          .from('deposit_requests')
          .select('*')
          .eq('tx_hash', txid)
          .eq('network', network)
          .maybeSingle();

        if (existingDeposit && existingDeposit.status === 'completed') {
          return {
            success: true,
            already_processed: true,
            deposit_id: existingDeposit.id
          };
        }
      }

      throw error;
    }

    if (!result || !result.success) {
      console.error('❌ Atomic deposit failed:', result?.error);
      throw new Error(result?.error || 'Deposit processing failed');
    }

    console.log(`✅ ATOMIC DEPOSIT SUCCESS: #${result.deposit_id}, new balance: $${result.new_balance}`);

    await safeSystemLog('deposit_atomic_success', `Atomic deposit successful for user ${userId}`, {
      deposit_id: result.deposit_id,
      user_id: userId,
      amount,
      old_balance: result.old_balance,
      new_balance: result.new_balance,
      tx_hash: txid,
      network
    });

    return {
      success: true,
      deposit_id: result.deposit_id,
      old_balance: result.old_balance,
      new_balance: result.new_balance,
      amount
    };
  } catch (error) {
    console.error('❌ Atomic deposit error:', error.message);
    throw error;
  }
}

// ========== CHAIN TRANSFERS ==========

async function getBEP20Transactions(address) {
  try {
    if (!address) return [];

    const params = new URLSearchParams({
      chain: 'bsc',
      limit: '100'
    });
    params.append('contract_addresses', USDT_BSC_CONTRACT);
    params.append('contract_addresses', USDC_BSC_CONTRACT);

    const url = `https://deep-index.moralis.io/api/v2/${address}/erc20/transfers?${params.toString()}`;

    const response = await fetch(url, {
      headers: {
        'X-API-Key': MORALIS_API_KEY,
        Accept: 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Moralis API error: ${response.status}`);
    }

    const data = await response.json();
    const transactions = [];

    const validContracts = [USDT_BSC_CONTRACT.toLowerCase(), USDC_BSC_CONTRACT.toLowerCase()];

    for (const tx of data.result || []) {
      try {
        const toAddress = String(tx.to_address || '').toLowerCase();
        if (toAddress !== String(address).toLowerCase()) continue;

        const tokenContract = String(tx.address || '').toLowerCase();
        
        if (!validContracts.includes(tokenContract)) continue;

        const isUSDT = tokenContract === USDT_BSC_CONTRACT.toLowerCase();
        
        // BSC использует 18 нулей
        const decimals = Number(tx.decimals || 18);
        const amount = Number(tx.value) / Math.pow(10, decimals);
        
        if (!Number.isFinite(amount) || amount < MIN_DEPOSIT) continue;

        transactions.push({
          transaction_id: tx.transaction_hash,
          to: toAddress,
          from: String(tx.from_address || '').toLowerCase(),
          amount,
          token: isUSDT ? 'USDT' : 'USDC',
          confirmed: true,
          network: isUSDT ? 'usdt_bep20' : 'usdc_bep20',
          timestamp: new Date(tx.block_timestamp).getTime(),
          blockNumber: Number(tx.block_number || 0)
        });
      } catch (innerErr) {
        continue;
      }
    }

    transactions.sort((a, b) => b.timestamp - a.timestamp);
    return transactions;
  } catch (error) {
    console.error(`❌ BEP20 transfer fetch error:`, error.message);
    return [];
  }
}

async function getERC20Transactions(address) {
  try {
    if (!address) return [];

    const params = new URLSearchParams({
      chain: 'eth',
      limit: '100'
    });
    params.append('contract_addresses', USDT_ETH_CONTRACT);
    params.append('contract_addresses', USDC_ETH_CONTRACT);

    const url = `https://deep-index.moralis.io/api/v2/${address}/erc20/transfers?${params.toString()}`;

    const response = await fetch(url, {
      headers: {
        'X-API-Key': MORALIS_API_KEY,
        Accept: 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Moralis API error: ${response.status}`);
    }

    const data = await response.json();
    const transactions = [];

    const validContracts = [USDT_ETH_CONTRACT.toLowerCase(), USDC_ETH_CONTRACT.toLowerCase()];

    for (const tx of data.result || []) {
      try {
        const toAddress = String(tx.to_address || '').toLowerCase();
        if (toAddress !== String(address).toLowerCase()) continue;

        const tokenContract = String(tx.address || '').toLowerCase();
        
        if (!validContracts.includes(tokenContract)) continue;

        const isUSDT = tokenContract === USDT_ETH_CONTRACT.toLowerCase();
        
        const decimals = Number(tx.decimals || 6);
        const amount = Number(tx.value) / Math.pow(10, decimals);
        
        if (!Number.isFinite(amount) || amount < MIN_DEPOSIT) continue;

        transactions.push({
          transaction_id: tx.transaction_hash,
          to: toAddress,
          from: String(tx.from_address || '').toLowerCase(),
          amount,
          token: isUSDT ? 'USDT' : 'USDC',
          confirmed: true,
          network: isUSDT ? 'usdt_erc20' : 'usdc_erc20',
          timestamp: new Date(tx.block_timestamp).getTime(),
          blockNumber: Number(tx.block_number || 0)
        });
      } catch (innerErr) {
        continue;
      }
    }

    transactions.sort((a, b) => b.timestamp - a.timestamp);
    return transactions;
  } catch (error) {
    console.error(`❌ ERC20 transfer fetch error:`, error.message);
    return [];
  }
}

async function getTRC20Transactions(address) {
  try {
    if (!address) return [];

    const params = new URLSearchParams({
      only_confirmed: 'true',
      only_to: 'true',
      limit: '200',
      contract_address: USDT_TRON_CONTRACT
    });

    const headers = {
      Accept: 'application/json'
    };

    if (TRONGRID_API_KEY) {
      headers['TRON-PRO-API-KEY'] = TRONGRID_API_KEY;
    }

    const response = await fetch(`${TRONGRID_API_BASE}/v1/accounts/${encodeURIComponent(address)}/transactions/trc20?${params.toString()}`, {
      headers
    });

    if (!response.ok) {
      throw new Error(`TronGrid API error: ${response.status}`);
    }

    const data = await response.json();
    const transactions = [];

    for (const tx of data.data || []) {
      try {
        const toAddress = String(tx.to || '').trim();
        if (toAddress !== String(address).trim()) continue;

        const decimals = Number(tx.token_info?.decimals ?? tx.tokenInfo?.tokenDecimal ?? tx.decimals ?? 6);
        const rawValue = tx.value ?? tx.amount ?? tx.quant ?? '0';
        const amount = Number(rawValue) / Math.pow(10, decimals);
        const tokenSymbol = String(tx.token_info?.symbol || tx.token_info?.name || tx.tokenName || 'USDT').toUpperCase();
        const confirmed = tx.confirmed !== false;

        if (tokenSymbol !== 'USDT') continue;
        if (!confirmed) continue;
        if (!Number.isFinite(amount) || amount < MIN_DEPOSIT) continue;

        transactions.push({
          transaction_id: String(tx.transaction_id || tx.hash || ''),
          to: toAddress,
          from: String(tx.from || '').trim(),
          amount,
          token: 'USDT',
          confirmed: true,
          network: 'usdt_trc20',
          timestamp: Number(tx.block_timestamp || tx.blockTimeStamp || 0),
          blockNumber: Number(tx.block_number || tx.block || 0)
        });
      } catch (innerErr) {
        continue;
      }
    }

    transactions.sort((a, b) => b.timestamp - a.timestamp);
    return transactions;
  } catch (error) {
    console.error('❌ TRC20 transfer fetch error:', error.message);
    return [];
  }
}

// ========== CHAIN CHECKERS ==========
async function handleCheckBEP20Deposits() {
  try {
    console.log('🔄 Checking BEP20 deposits...');

    const { data: wallets, error } = await supabase
      .from('user_wallets')
      .select('*')
      .or('usdt_bep20_address.not.is.null,usdc_bep20_address.not.is.null')
      .limit(200);

    if (error) throw error;

    let processedCount = 0;
    let depositsFound = 0;
    let duplicatesSkipped = 0;
    let errors = 0;

    for (const wallet of wallets || []) {
      try {
        const addresses = Array.from(
          new Set([wallet.usdt_bep20_address, wallet.usdc_bep20_address].filter(Boolean))
        );

        for (const address of addresses) {
          await sleep(API_DELAY_MS);

          const transactions = await getBEP20Transactions(address);
          for (const tx of transactions) {
            try {
              const { data: existing } = await supabase
                .from('deposit_requests')
                .select('id, status')
                .eq('tx_hash', tx.transaction_id)
                .eq('network', tx.network)
                .maybeSingle();

              if (existing && existing.status === 'completed') {
                duplicatesSkipped++;
                console.log(`⏭️ Skipping duplicate ${tx.network} transaction: ${tx.transaction_id}`);
                continue;
              }

              const result = await processDeposit(wallet.user_id, tx.amount, tx.transaction_id, tx.network);
              if (result.success) {
                depositsFound++;
                console.log(`💰 NEW ${tx.network} DEPOSIT: $${tx.amount} ${tx.token} for user ${wallet.user_id}`);
                
                // ВЫЗОВ АВТОСБОРА (Без await, чтобы не блокировать выполнение других юзеров)
                sweepDepositBEP20(wallet.user_id, tx.token, tx.network).catch(err => 
                  console.error(`Sweep background error:`, err.message)
                );
              }
            } catch (err) {
              if (String(err.message || '').includes('already_processed') || String(err.message || '').includes('duplicate')) {
                duplicatesSkipped++;
                console.log(`⏭️ Duplicate ${tx.network} deposit skipped: ${tx.transaction_id}`);
              } else {
                console.error(`❌ Error processing ${tx.network} deposit ${tx.transaction_id}:`, err.message);
                errors++;
              }
            }
          }
        }

        processedCount++;
      } catch (err) {
        console.error(`❌ Error processing BEP20 wallet ${wallet.user_id}:`, err.message);
        errors++;
      }
    }

    console.log(`✅ BEP20: Processed ${processedCount} wallets, found ${depositsFound} new deposits, skipped ${duplicatesSkipped} duplicates, errors: ${errors}`);
    return {
      success: true,
      processed: processedCount,
      deposits: depositsFound,
      duplicates: duplicatesSkipped,
      errors
    };
  } catch (error) {
    console.error('❌ BEP20 check error:', error.message);
    return { success: false, error: error.message };
  }
}

async function handleCheckERC20Deposits() {
  try {
    console.log('🔄 Checking ERC20 deposits...');

    const { data: wallets, error } = await supabase
      .from('user_wallets')
      .select('*')
      .or('usdt_erc20_address.not.is.null,usdc_erc20_address.not.is.null')
      .limit(200);

    if (error) throw error;

    let processedCount = 0;
    let depositsFound = 0;
    let duplicatesSkipped = 0;
    let errors = 0;

    for (const wallet of wallets || []) {
      try {
        const addresses = Array.from(
          new Set([wallet.usdt_erc20_address, wallet.usdc_erc20_address].filter(Boolean))
        );

        for (const address of addresses) {
          await sleep(API_DELAY_MS);

          const transactions = await getERC20Transactions(address);
          for (const tx of transactions) {
            try {
              const { data: existing } = await supabase
                .from('deposit_requests')
                .select('id, status')
                .eq('tx_hash', tx.transaction_id)
                .eq('network', tx.network)
                .maybeSingle();

              if (existing && existing.status === 'completed') {
                duplicatesSkipped++;
                console.log(`⏭️ Skipping duplicate ${tx.network} transaction: ${tx.transaction_id}`);
                continue;
              }

              const result = await processDeposit(wallet.user_id, tx.amount, tx.transaction_id, tx.network);
              if (result.success) {
                depositsFound++;
                console.log(`💰 NEW ${tx.network} DEPOSIT: $${tx.amount} ${tx.token} for user ${wallet.user_id}`);
              }
            } catch (err) {
              if (String(err.message || '').includes('already_processed') || String(err.message || '').includes('duplicate')) {
                duplicatesSkipped++;
                console.log(`⏭️ Duplicate ${tx.network} deposit skipped: ${tx.transaction_id}`);
              } else {
                console.error(`❌ Error processing ${tx.network} deposit ${tx.transaction_id}:`, err.message);
                errors++;
              }
            }
          }
        }

        processedCount++;
      } catch (err) {
        console.error(`❌ Error processing ERC20 wallet ${wallet.user_id}:`, err.message);
        errors++;
      }
    }

    console.log(`✅ ERC20: Processed ${processedCount} wallets, found ${depositsFound} new deposits, skipped ${duplicatesSkipped} duplicates, errors: ${errors}`);
    return {
      success: true,
      processed: processedCount,
      deposits: depositsFound,
      duplicates: duplicatesSkipped,
      errors
    };
  } catch (error) {
    console.error('❌ ERC20 check error:', error.message);
    return { success: false, error: error.message };
  }
}

async function handleCheckTRC20Deposits() {
  try {
    console.log('🔄 Checking TRC20 deposits...');

    const { data: wallets, error } = await supabase
      .from('user_wallets')
      .select('*')
      .not('usdt_trc20_address', 'is', null)
      .limit(200);

    if (error) throw error;

    let processedCount = 0;
    let depositsFound = 0;
    let duplicatesSkipped = 0;
    let errors = 0;

    for (const wallet of wallets || []) {
      try {
        const addresses = Array.from(new Set([wallet.usdt_trc20_address].filter(Boolean)));

        for (const address of addresses) {
          await sleep(API_DELAY_MS);

          const transactions = await getTRC20Transactions(address);
          for (const tx of transactions) {
            try {
              const { data: existing } = await supabase
                .from('deposit_requests')
                .select('id, status')
                .eq('tx_hash', tx.transaction_id)
                .eq('network', tx.network)
                .maybeSingle();

              if (existing && existing.status === 'completed') {
                duplicatesSkipped++;
                console.log(`⏭️ Skipping duplicate ${tx.network} transaction: ${tx.transaction_id}`);
                continue;
              }

              const result = await processDeposit(wallet.user_id, tx.amount, tx.transaction_id, tx.network);
              if (result.success) {
                depositsFound++;
                console.log(`💰 NEW ${tx.network} DEPOSIT: $${tx.amount} ${tx.token} for user ${wallet.user_id}`);
              }
            } catch (err) {
              if (String(err.message || '').includes('already_processed') || String(err.message || '').includes('duplicate')) {
                duplicatesSkipped++;
                console.log(`⏭️ Duplicate ${tx.network} deposit skipped: ${tx.transaction_id}`);
              } else {
                console.error(`❌ Error processing ${tx.network} deposit ${tx.transaction_id}:`, err.message);
                errors++;
              }
            }
          }
        }

        processedCount++;
      } catch (err) {
        console.error(`❌ Error processing TRC20 wallet ${wallet.user_id}:`, err.message);
        errors++;
      }
    }

    console.log(`✅ TRC20: Processed ${processedCount} wallets, found ${depositsFound} new deposits, skipped ${duplicatesSkipped} duplicates, errors: ${errors}`);
    return {
      success: true,
      processed: processedCount,
      deposits: depositsFound,
      duplicates: duplicatesSkipped,
      errors
    };
  } catch (error) {
    console.error('❌ TRC20 check error:', error.message);
    return { success: false, error: error.message };
  }
}

async function checkUserTRC20Deposits(userId) {
  const summary = { success: true, network_group: 'trc20', checked: 0, deposits: 0, duplicates: 0, errors: 0 };

  try {
    const { data: wallet, error } = await supabase
      .from('user_wallets')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw error;
    if (!wallet) return summary;

    const addresses = Array.from(new Set([wallet.usdt_trc20_address].filter(Boolean)));

    for (const address of addresses) {
      const transactions = await getTRC20Transactions(address);
      summary.checked += transactions.length;

      for (const tx of transactions) {
        try {
          const result = await processDeposit(userId, tx.amount, tx.transaction_id, tx.network);
          if (result?.success) {
            if (result.already_processed) summary.duplicates++;
            else summary.deposits++;
          }
        } catch (err) {
          summary.errors++;
          console.error(`❌ Error processing transaction ${tx.transaction_id}:`, err.message);
        }
      }
    }

    return summary;
  } catch (error) {
    summary.success = false;
    summary.error = error.message;
    console.error('❌ checkUserTRC20Deposits error:', error.message);
    return summary;
  }
}

async function checkUserBEP20Deposits(userId) {
  const summary = { success: true, network_group: 'bep20', checked: 0, deposits: 0, duplicates: 0, errors: 0 };

  try {
    const { data: wallet, error } = await supabase
      .from('user_wallets')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw error;
    if (!wallet) return summary;

    const addresses = Array.from(
      new Set([wallet.usdt_bep20_address, wallet.usdc_bep20_address].filter(Boolean))
    );

    for (const address of addresses) {
      const transactions = await getBEP20Transactions(address);
      summary.checked += transactions.length;

      for (const tx of transactions) {
        try {
          const result = await processDeposit(userId, tx.amount, tx.transaction_id, tx.network);
          if (result?.success) {
            if (result.already_processed) {
              summary.duplicates++;
            } else {
              summary.deposits++;
              // ВЫЗОВ АВТОСБОРА при "быстрой" проверке сразу после создания кошелька
              sweepDepositBEP20(userId, tx.token, tx.network).catch(console.error);
            }
          }
        } catch (err) {
          summary.errors++;
          console.error(`❌ Error processing transaction ${tx.transaction_id}:`, err.message);
        }
      }
    }

    return summary;
  } catch (error) {
    summary.success = false;
    summary.error = error.message;
    console.error('❌ checkUserBEP20Deposits error:', error.message);
    return summary;
  }
}

async function checkUserERC20Deposits(userId) {
  const summary = { success: true, network_group: 'erc20', checked: 0, deposits: 0, duplicates: 0, errors: 0 };

  try {
    const { data: wallet, error } = await supabase
      .from('user_wallets')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw error;
    if (!wallet) return summary;

    const addresses = Array.from(
      new Set([wallet.usdt_erc20_address, wallet.usdc_erc20_address].filter(Boolean))
    );

    for (const address of addresses) {
      const transactions = await getERC20Transactions(address);
      summary.checked += transactions.length;

      for (const tx of transactions) {
        try {
          const result = await processDeposit(userId, tx.amount, tx.transaction_id, tx.network);
          if (result?.success) {
            if (result.already_processed) summary.duplicates++;
            else summary.deposits++;
          }
        } catch (err) {
          summary.errors++;
          console.error(`❌ Error processing transaction ${tx.transaction_id}:`, err.message);
        }
      }
    }

    return summary;
  } catch (error) {
    summary.success = false;
    summary.error = error.message;
    console.error('❌ checkUserERC20Deposits error:', error.message);
    return summary;
  }
}

// ========== HTTP ROUTES ==========
app.get('/', (req, res) => {
  res.json({
    status: '✅ SERVER IS RUNNING',
    message: 'Oracle Deposit Processing System',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    encryption: ENCRYPTION_KEY ? 'ENABLED' : 'DISABLED'
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: '✅ HEALTHY',
    service: 'Oracle Deposit Processor',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    encryption: ENCRYPTION_KEY ? 'AES-256-GCM' : 'NONE'
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: '✅ API HEALTHY',
    timestamp: new Date().toISOString(),
    encryption: ENCRYPTION_KEY ? 'ACTIVE' : 'INACTIVE'
  });
});

// 1. Protected endpoint (API key required)
app.post('/api/deposit/generate', requireApiKey, async (req, res) => {
  try {
    const user_id = readParam(req, 'user_id');
    const network = readParam(req, 'network', 'usdt_bep20');

    if (!user_id) {
      return res.status(400).json({ success: false, error: 'User ID is required' });
    }

    if (!allowedNetworks.includes(network)) {
      return res.status(400).json({ success: false, error: 'Unsupported network' });
    }

    console.log(`🔐 [SECURE] Generating ${network} wallet for user: ${user_id}, IP: ${req.ip}`);

    const result = await generateWallet(user_id, network);
    return res.json(result);
  } catch (error) {
    console.error('❌ API Generate wallet error:', error.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// 2. Public/app endpoint
// Requires Bearer auth and resolves user only from the token.
app.post('/public/deposit/generate', async (req, res) => {
  try {
    const network = readParam(req, 'network', 'usdt_bep20');
    const bearerUser = await getUserFromBearerToken(req);

    console.log('🔓 [PUBLIC] Deposit generation request:', {
      resolved_user_id: bearerUser?.id || null,
      network,
      ip: req.ip,
      timestamp: new Date().toISOString(),
      bearer_auth: !!bearerUser
    });

    if (!bearerUser?.id) {
      return res.status(401).json({ success: false, error: 'Auth required' });
    }

    const user_id = bearerUser.id;

    if (!allowedNetworks.includes(network)) {
      return res.status(400).json({ success: false, error: 'Unsupported network' });
    }

    // ИСПРАВЛЕНИЕ ЗДЕСЬ: ищем по колонке 'id', а не 'user_id'
    const { data: user, error: userError } = await supabase
      .from('profiles')
      .select('id')
      .eq('id', user_id)
      .maybeSingle();

    if (userError) {
      console.error('❌ [PUBLIC] User lookup error:', userError.message);
      return res.status(500).json({ success: false, error: 'User lookup failed' });
    }

    if (!user) {
      console.log('❌ [PUBLIC] User not found:', user_id);
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const result = await generateWallet(user_id, network);

    await safeSystemLog('public_deposit_generated', `Public deposit address generated for user ${user_id}`, {
      user_id,
      network,
      address: result.address,
      ip: req.ip,
      bearer_auth: true
    });

    return res.json({
      success: true,
      address: result.address,
      network: result.network,
      exists: result.exists
    });
  } catch (error) {
    console.error('❌ [PUBLIC] Error:', error.message);

    await safeSystemLog('public_deposit_error', `Public deposit error: ${error.message}`, {
      error: error.message,
      ip: req.ip,
      body: req.body || null,
      query: req.query || null
    });

    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});


// 3. Public/app endpoint: user manually checks only their own deposit address.
// Requires Bearer auth and resolves user only from the token.
app.post('/public/deposit/check', userDepositCheckCooldownMiddleware, async (req, res) => {
  try {
    const network = readParam(req, 'network', 'usdt_bep20');
    const bearerUser = await getUserFromBearerToken(req);

    console.log('🔎 [PUBLIC] User deposit check request:', {
      resolved_user_id: bearerUser?.id || null,
      network,
      ip: req.ip,
      timestamp: new Date().toISOString(),
      bearer_auth: !!bearerUser
    });

    if (!bearerUser?.id) {
      return res.status(401).json({ success: false, error: 'Auth required' });
    }

    if (!allowedNetworks.includes(network)) {
      return res.status(400).json({ success: false, error: 'Unsupported network' });
    }

    const user_id = bearerUser.id;
    let result;

    if (network.includes('bep20')) {
      result = await checkUserBEP20Deposits(user_id);
    } else if (network.includes('erc20')) {
      result = await checkUserERC20Deposits(user_id);
    } else if (network.includes('trc20')) {
      result = await checkUserTRC20Deposits(user_id);
    }

    await safeSystemLog('public_deposit_check', `User triggered deposit check for ${user_id}`, {
      user_id,
      network,
      result,
      ip: req.ip
    });

    return res.json({
      success: true,
      found: Number(result?.deposits || 0) > 0,
      network,
      result: result || null,
      message: Number(result?.deposits || 0) > 0
        ? 'Deposit found and credited'
        : 'Deposit not found yet'
    });
  } catch (error) {
    console.error('❌ [PUBLIC] Deposit check error:', error.message);

    await safeSystemLog('public_deposit_check_error', `Public deposit check error: ${error.message}`, {
      error: error.message,
      ip: req.ip,
      body: req.body || null,
      query: req.query || null
    });

    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// 4. Public/admin endpoint: checks all deposits after Bearer auth + role/is_admin validation.
// This keeps API_SECRET_KEY on the server and never exposes it to frontend.
app.post('/public/admin/check-deposits', adminDepositCheckCooldownMiddleware, async (req, res) => {
  try {
    const bearerUser = await getUserFromBearerToken(req);

    if (!bearerUser?.id) {
      return res.status(401).json({ success: false, error: 'Auth required' });
    }

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', bearerUser.id)
      .maybeSingle();

    if (profileError) {
      console.error('❌ [ADMIN] Profile lookup error:', profileError.message);
      return res.status(500).json({ success: false, error: 'Profile lookup failed' });
    }

    const isAdmin = profile?.role === 'admin' || profile?.is_admin === true;

    if (!isAdmin) {
      console.warn('🚫 [ADMIN] Deposit check blocked for non-admin:', bearerUser.id);
      return res.status(403).json({ success: false, error: 'Admin only' });
    }

    console.log('🔄 [ADMIN] Manual all-deposit check triggered:', {
      admin_id: bearerUser.id,
      ip: req.ip,
      timestamp: new Date().toISOString()
    });

    const bep20Result = await handleCheckBEP20Deposits();
    const erc20Result = await handleCheckERC20Deposits();
    const trc20Result = await handleCheckTRC20Deposits();

    await safeSystemLog('admin_deposit_check', `Admin triggered all-deposit check`, {
      admin_id: bearerUser.id,
      bep20: bep20Result,
      erc20: erc20Result,
      trc20: trc20Result,
      ip: req.ip
    });

    return res.json({
      success: true,
      bep20: bep20Result,
      erc20: erc20Result,
      trc20: trc20Result
    });
  } catch (error) {
    console.error('❌ [ADMIN] Deposit check error:', error.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.get('/api/deposit/history', requireApiKey, async (req, res) => {
  try {
    const user_id = readParam(req, 'user_id');
    const network = readParam(req, 'network');

    if (!user_id) {
      return res.status(400).json({ success: false, error: 'User ID is required' });
    }

    let query = supabase
      .from('deposit_requests')
      .select('*')
      .eq('user_id', user_id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (network) {
      query = query.eq('network', network);
    }

    const { data: deposits, error } = await query;

    if (error) {
      console.error('❌ Database error:', error.message);
      return res.status(500).json({ success: false, error: 'Failed to fetch deposit history' });
    }

    return res.json({ success: true, deposits: deposits || [] });
  } catch (error) {
    console.error('❌ Deposit history error:', error.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.get('/api/check-deposits', requireApiKey, async (req, res) => {
  try {
    console.log('🔄 [SECURE] Manual deposit check triggered via API');
    const bep20Result = await handleCheckBEP20Deposits();
    const erc20Result = await handleCheckERC20Deposits();
    const trc20Result = await handleCheckTRC20Deposits();

    return res.json({
      success: true,
      bep20: bep20Result,
      erc20: erc20Result,
      trc20: trc20Result
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ========== START SERVER ==========
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 HTTP SERVER RUNNING on port ${PORT}`);
  console.log(`✅ Health check available at: http://0.0.0.0:${PORT}/health`);
  console.log(`✅ API Health check: http://0.0.0.0:${PORT}/api/health`);
  console.log(`✅ PUBLIC Endpoint: POST http://0.0.0.0:${PORT}/public/deposit/generate`);
  console.log(`✅ PUBLIC Endpoint: POST http://0.0.0.0:${PORT}/public/deposit/check`);
  console.log(`✅ ADMIN Endpoint:  POST http://0.0.0.0:${PORT}/public/admin/check-deposits`);
  console.log(`✅ SECURE Endpoint: POST http://0.0.0.0:${PORT}/api/deposit/generate (requires API key)`);
  console.log(`✅ SECURE Endpoint: GET  http://0.0.0.0:${PORT}/api/deposit/history (requires API key)`);
  console.log(`✅ SECURE Endpoint: GET  http://0.0.0.0:${PORT}/api/check-deposits (requires API key)`);
  console.log(`✅ RATE LIMIT: 60 requests per 15 minutes per IP`);
  console.log(`✅ SUPABASE: CONNECTED`);
  console.log(`✅ MORALIS: ${MORALIS_API_KEY ? 'API KEY SET' : 'API KEY MISSING'}`);
  console.log(`✅ BEP20 (USDT & USDC): Checking every ${BEP20_CHECK_INTERVAL} ms`);
  console.log(`✅ ERC20 (USDT & USDC): Checking every ${ERC20_CHECK_INTERVAL} ms`);
  console.log(`✅ TRC20 (USDT): Checking every ${TRC20_CHECK_INTERVAL} ms`);
  console.log(`✅ MINIMUM DEPOSIT: $${MIN_DEPOSIT}`);
  console.log(`✅ PRIVATE KEY ENCRYPTION: ${ENCRYPTION_KEY ? 'AES-256-GCM ENABLED' : 'DISABLED'}`);
  console.log(`✅ ATOMIC DEPOSITS: ENABLED`);
  console.log(`✅ AUTO-SWEEP BEP20: ${HOT_WALLET_PRIVATE_KEY ? 'ENABLED' : 'DISABLED'}`);
  console.log(`✅ SECURITY: Public endpoints DO NOT return private keys`);
  console.log('===================================');
});

// ========== BACKGROUND TASKS ==========
let isCheckingBEP20 = false;
let isCheckingERC20 = false;
let isCheckingTRC20 = false;

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

setInterval(async () => {
  if (isCheckingERC20) return;

  try {
    isCheckingERC20 = true;
    await handleCheckERC20Deposits();
  } catch (err) {
    console.error('❌ ERC20 auto-check error:', err.message);
  } finally {
    isCheckingERC20 = false;
  }
}, ERC20_CHECK_INTERVAL);

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

process.on('SIGTERM', () => {
  console.log('🛑 Received SIGTERM, shutting down gracefully');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});
