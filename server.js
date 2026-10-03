// server.js — Oracle Deposit System (BEP20 + ERC20 + TRC20 USDT/USDC)
// Built from the user's original full server flow.
// Changes vs original:
// - UNIFIED EVM WALLETS: One 0x... address generated and shared across USDT/USDC and BEP20/ERC20.
// - TRC20 restored for USDT
// - ERC20/BEP20 discovery migrated from Moralis to Alchemy JSON-RPC
// - Confirmed ERC20/BEP20 Transfer logs are scanned in safe block windows
// - Old vulnerable getChainTokenTransfers removed completely
// - Compatible with Supabase RPC public.credit_chain_deposit
// - V2: AUTO-SWEEP ADDED FOR BEP20 ONLY (Non-blocking)
// - V3: WEBSOCKET FIX FOR NODE.JS 20 SUPABASE COMPATIBILITY
// - V5: ALCHEMY PROVIDER - Moralis removed without changing database crediting
// - V6: BEP20 user check scans Alchemy history newest-first in bounded batches
//   so deposits older than the former 600-block window are not skipped.
// - V7: selected-network checks run as single-flight background jobs with
//   progress polling and a process-wide Alchemy 429 protection gate.
// - PixelNFT compatibility: atomic database RPCs, credited/reversed statuses,
//   encrypted key envelopes and existing PixelNFT app/admin API contracts.
//   Atomic crediting, confirmation flags, scan timers and BEP20 sweep flow
//   deliberately remain compatible with the supplied server (8).js.

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
const ALCHEMY_API_KEY = String(process.env.ALCHEMY_API_KEY || '').trim();
const ALCHEMY_ETH_RPC_URL = String(
  process.env.ALCHEMY_ETH_RPC_URL ||
  (ALCHEMY_API_KEY ? `https://eth-mainnet.g.alchemy.com/v2/${encodeURIComponent(ALCHEMY_API_KEY)}` : '')
).trim();
const ALCHEMY_BSC_RPC_URL = String(
  process.env.ALCHEMY_BSC_RPC_URL ||
  (ALCHEMY_API_KEY ? `https://bnb-mainnet.g.alchemy.com/v2/${encodeURIComponent(ALCHEMY_API_KEY)}` : '')
).trim();
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
if (!ALCHEMY_ETH_RPC_URL || !ALCHEMY_BSC_RPC_URL) {
  console.warn('⚠️ Alchemy RPC is not fully configured (BEP20/ERC20 checks may fail).');
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
  res.header('Access-Control-Expose-Headers', 'Server-Timing, X-Response-Time');
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

  if (req.path === '/health' || req.path === '/api/health' || req.path === '/' || req.path === '/public/deposit/check/status') {
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

function userDepositCheckRequestMiddleware(req, res, next) {
  const asyncValue = readParam(req, 'async', false);
  const asyncMode = asyncValue === true || String(asyncValue).toLowerCase() === 'true';
  if (asyncMode) return next();
  return userDepositCheckCooldownMiddleware(req, res, next);
}

const adminDepositCheckCooldownMiddleware = createCooldownMiddleware(
  adminDepositCheckCooldown,
  Number(process.env.ADMIN_DEPOSIT_CHECK_COOLDOWN_MS || 60000),
  'Please wait before checking all deposits again'
);


// ========== CONSTANTS ==========
const MIN_DEPOSIT = 1;

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

function boundedEnvInteger(name, fallback, minimum, maximum) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

// Alchemy Free currently limits eth_getLogs to ten blocks per request on BNB
// and Ethereum. Paid plans can raise the two *_LOG_BLOCK_RANGE values.
const ALCHEMY_REQUEST_TIMEOUT_MS = boundedEnvInteger('ALCHEMY_REQUEST_TIMEOUT_MS', 15000, 1000, 60000);
const ALCHEMY_MAX_RETRIES = boundedEnvInteger('ALCHEMY_MAX_RETRIES', 4, 0, 8);
const ALCHEMY_RETRY_BASE_MS = boundedEnvInteger('ALCHEMY_RETRY_BASE_MS', 500, 100, 10000);
const ALCHEMY_ETH_MAX_PAGES = boundedEnvInteger('ALCHEMY_ETH_MAX_PAGES', 2, 1, 10);
const ALCHEMY_ADDRESS_BATCH_SIZE = boundedEnvInteger('ALCHEMY_ADDRESS_BATCH_SIZE', 200, 1, 500);
const ALCHEMY_BSC_LOG_BLOCK_RANGE = boundedEnvInteger('ALCHEMY_BSC_LOG_BLOCK_RANGE', 10, 1, 10000);
const ALCHEMY_ETH_LOG_BLOCK_RANGE = boundedEnvInteger('ALCHEMY_ETH_LOG_BLOCK_RANGE', 10, 1, 10000);
const ALCHEMY_BSC_CONFIRMATIONS = boundedEnvInteger('ALCHEMY_BSC_CONFIRMATIONS', 3, 1, 100);
const ALCHEMY_ETH_CONFIRMATIONS = boundedEnvInteger('ALCHEMY_ETH_CONFIRMATIONS', 12, 1, 200);
// Railway restarts must not hide deposits that are already more than 1,200
// BSC blocks old. Recovery is processed in bounded chunks below, so this
// larger safety window does not create one oversized provider request burst.
const ALCHEMY_BSC_INITIAL_LOOKBACK_BLOCKS = boundedEnvInteger('ALCHEMY_BSC_INITIAL_LOOKBACK_BLOCKS', 10000, 10, 100000);
const ALCHEMY_ETH_INITIAL_LOOKBACK_BLOCKS = boundedEnvInteger('ALCHEMY_ETH_INITIAL_LOOKBACK_BLOCKS', 720, 10, 100000);
const ALCHEMY_BSC_MANUAL_LOOKBACK_BLOCKS = boundedEnvInteger('ALCHEMY_BSC_MANUAL_LOOKBACK_BLOCKS', 600, 10, 100000);
const ALCHEMY_ETH_MANUAL_LOOKBACK_BLOCKS = boundedEnvInteger('ALCHEMY_ETH_MANUAL_LOOKBACK_BLOCKS', 300, 10, 100000);
const ALCHEMY_BSC_REORG_OVERLAP_BLOCKS = boundedEnvInteger('ALCHEMY_BSC_REORG_OVERLAP_BLOCKS', 20, 1, 500);
const ALCHEMY_ETH_REORG_OVERLAP_BLOCKS = boundedEnvInteger('ALCHEMY_ETH_REORG_OVERLAP_BLOCKS', 12, 1, 500);
const ALCHEMY_BSC_RECOVERY_BLOCKS_PER_CHECK = boundedEnvInteger('ALCHEMY_BSC_RECOVERY_BLOCKS_PER_CHECK', 2000, 10, 10000);
const ALCHEMY_BSC_LOG_DELAY_MS = boundedEnvInteger('ALCHEMY_BSC_LOG_DELAY_MS', 200, 0, 5000);
const DEPOSIT_WALLET_PAGE_SIZE = boundedEnvInteger('DEPOSIT_WALLET_PAGE_SIZE', 500, 50, 1000);
// Workers overlap network latency, while one process-wide gate below spaces
// every eth_getLogs attempt so simultaneous user/background scans cannot burst
// through the Alchemy free-plan throughput limit.
const ALCHEMY_BSC_USER_SCAN_CONCURRENCY = 4;
const ALCHEMY_LOG_REQUEST_MIN_INTERVAL_MS = boundedEnvInteger('ALCHEMY_LOG_REQUEST_MIN_INTERVAL_MS', 150, 50, 5000);
const ALCHEMY_RATE_LIMIT_PAUSE_MS = boundedEnvInteger('ALCHEMY_RATE_LIMIT_PAUSE_MS', 5000, 1000, 60000);
const DEPOSIT_CHECK_JOB_TTL_MS = boundedEnvInteger('DEPOSIT_CHECK_JOB_TTL_MS', 15 * 60 * 1000, 60 * 1000, 60 * 60 * 1000);
const DEPOSIT_CHECK_RESULT_REUSE_MS = boundedEnvInteger('DEPOSIT_CHECK_RESULT_REUSE_MS', 60 * 1000, 5 * 1000, 5 * 60 * 1000);
const DEPOSIT_CHECK_JOB_CONCURRENCY = boundedEnvInteger('DEPOSIT_CHECK_JOB_CONCURRENCY', 2, 1, 10);

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
    if (req.pixelUser) return req.pixelUser;
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return null;

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      console.warn('⚠️ Bearer token validation failed:', error?.message || 'No user');
      return null;
    }

    // getUser verifies the signature; the DB additionally rejects revoked
    // sessions and blocked profiles. Never authorize from user_metadata.
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    if (claims.sub !== data.user.id || !/^[0-9a-f-]{36}$/i.test(claims.session_id || '')) return null;
    const { data: state, error: stateError } = await supabase.rpc('pixel_app_api', {
      p_user: data.user.id, p_session: claims.session_id,
      p_action: 'user.state', p_payload: {}
    });
    if (stateError || !state || state.error) return null;
    req.pixelSession = claims.session_id;
    req.pixelState = state;
    req.pixelUser = data.user;
    return req.pixelUser;
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

// Logging and reconciliation must never delay a user-facing address response.
// Errors remain visible in Railway logs, while the critical wallet writes are
// still awaited inside generateWallet().
function runInBackground(label, task) {
  Promise.resolve()
    .then(task)
    .catch((error) => console.warn(`⚠️ Background task failed (${label}):`, error.message));
}


// ========== DEPOSIT ADDRESS SYNC ==========
// register_deposit_wallets writes addresses and encrypted keys atomically.
// This compatibility helper verifies the saved address; it must not bypass
// the database's write restrictions with a separate upsert.
function getDepositAsset(network) {
  return String(network || '').toLowerCase().startsWith('usdc_') ? 'USDC' : 'USDT';
}

async function syncDepositAddress(userId, network, address) {
  if (!userId || !network || !address) return;

  const normalizedNetwork = String(network).trim().toLowerCase();
  const asset = getDepositAsset(normalizedNetwork);

  const { data, error } = await supabase
    .from('deposit_addresses')
    .select('address')
    .eq('user_id', userId)
    .eq('asset', asset)
    .eq('network', normalizedNetwork)
    .eq('is_active', true)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to sync deposit address: ${error.message}`);
  }
  const matches = normalizedNetwork.endsWith('_trc20')
    ? data?.address === address
    : data?.address?.toLowerCase() === String(address).toLowerCase();
  if (!matches) throw new Error('DEPOSIT_ADDRESS_MISMATCH');
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
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(String(text || ''))) throw new Error('INVALID_PRIVATE_KEY');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(
      'aes-256-gcm',
      crypto.createHash('sha256').update(ENCRYPTION_KEY).digest(),
      iv
    );
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();
    return `v1:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  } catch (error) {
    console.error('❌ Encryption error:', error.message);
    throw new Error('PRIVATE_KEY_ENCRYPTION_FAILED');
  }
}

function decryptPrivateKey(encryptedText) {
  try {
    const parts = String(encryptedText || '').split(':');
    const modern = parts.length === 4 && parts[0] === 'v1';
    const legacy = parts.length === 3;
    if (!modern && !legacy) throw new Error('KEY_ENVELOPE_INVALID');
    const ivHex = modern ? parts[1] : parts[0];
    const encrypted = modern ? parts[3] : parts[1];
    const tagHex = parts[2];
    if (!(modern ? /^[a-f0-9]{24}$/ : /^[a-f0-9]{32}$/).test(ivHex) ||
        !/^[a-f0-9]{32}$/.test(tagHex) || !/^(?:[a-f0-9]{2})+$/.test(encrypted)) {
      throw new Error('KEY_ENVELOPE_INVALID');
    }
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(tagHex, 'hex');

    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      crypto.createHash('sha256').update(ENCRYPTION_KEY).digest(),
      iv
    );
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(decrypted)) throw new Error('INVALID_PRIVATE_KEY');
    return decrypted;
  } catch (error) {
    console.error('❌ Decryption error:', error.message);
    throw new Error('PRIVATE_KEY_DECRYPTION_FAILED');
  }
}

// ========== AUTO-SWEEP LOGIC (BEP20) ==========
async function sweepDepositBEP20(userId, token, network) {
  if (!HOT_WALLET_PRIVATE_KEY || !ADMIN_SWEEP_ADDRESS) return;

  console.log(`🧹 Starting Auto-Sweep for user ${userId} (${token} on ${network})`);

  try {
    const provider = new ethers.JsonRpcProvider('https://bsc-dataseed.binance.org/');
    const hotWallet = new ethers.Wallet(HOT_WALLET_PRIVATE_KEY, provider);

    // The DB removes only its outer PGP envelope. AES-GCM decryption stays
    // here on the deposit server, using the original ENCRYPTION_KEY.
    const { data: keyData, error } = await supabase.rpc('deposit_key_envelope', {
      p_user_id: userId, p_network: network
    });

    if (error || !keyData) throw new Error('Cannot find private key for sweep');

    const userPrivateKey = decryptPrivateKey(keyData.server_cipher);
    const userWallet = new ethers.Wallet(userPrivateKey, provider);
    if (userWallet.address.toLowerCase() !== String(keyData.address).toLowerCase()) {
      throw new Error('SWEEP_KEY_ADDRESS_MISMATCH');
    }

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
  const fields = networkFields[network];
  if (!fields) throw new Error('Unsupported network');
  const { data: existingWallet, error: walletError } = await supabase
    .from('deposit_wallets').select('*').eq('user_id', user_id).maybeSingle();
  if (walletError) throw walletError;
  // Never replace an existing address/key pair, including partially migrated
  // wallets. Incomplete old records need explicit recovery, not new keys.
  if (existingWallet && allowedNetworks.some(net => !existingWallet[networkFields[net].addressField])) {
    throw new Error('WALLET_KEYS_INCOMPLETE');
  }

  const evm = existingWallet ? null : await generateEVMWallet();
  const tron = existingWallet ? null : generateTRONWallet();
  const { data: wallet, error } = await supabase.rpc('register_deposit_wallets', {
    p_user_id: user_id,
    p_evm_address: evm?.address || null,
    p_evm_key: evm ? encryptPrivateKey(evm.privateKey) : null,
    p_tron_address: tron?.address || null,
    p_tron_key: tron ? encryptPrivateKey(tron.privateKey) : null
  });
  if (error) throw error;
  if (!wallet || wallet.user_id !== user_id || allowedNetworks.some(net => !wallet[networkFields[net].addressField])) {
    throw new Error('WALLET_SAVE_FAILED');
  }
  const address = wallet[fields.addressField];
  // Another server may have won the DB lock; always return the saved address.
  const exists = !!existingWallet || (evm && wallet.usdt_bep20_address !== evm.address);
  if (!exists) {
    runInBackground('deposit_wallet_generated', () => safeSystemLog(
      'deposit_wallet_generated', 'Deposit wallets generated for user ' + user_id,
      { user_id, network, address }
    ));
    setTimeout(() => {
      const options = { network };
      if (network.includes('bep20')) checkUserBEP20Deposits(user_id, options).catch(console.error);
      if (network.includes('erc20')) checkUserERC20Deposits(user_id, options).catch(console.error);
      if (network.includes('trc20')) checkUserTRC20Deposits(user_id, options).catch(console.error);
    }, 10000);
  }
  return { success: true, address, exists: !!exists, network, wallet };
}

// One DB transaction registers the unified EVM wallet, TRON wallet and all
// five encrypted key/address records. Concurrent calls reuse that transaction.
const walletGenerationInFlight = new Map();
async function generateWalletSingleFlight(userId, network) {
  if (!networkFields[network]) throw new Error('Unsupported network');
  let operation = walletGenerationInFlight.get(userId);
  if (!operation) {
    operation = generateWallet(userId, network).finally(() => {
      if (walletGenerationInFlight.get(userId) === operation) walletGenerationInFlight.delete(userId);
    });
    walletGenerationInFlight.set(userId, operation);
  }
  const result = await operation;
  return { ...result, network, address: result.wallet[networkFields[network].addressField] };
}

// ========== DEPOSIT PROCESSING ==========
function normalizeEventIndex(value) {
  let parsed;
  try {
    const raw = String(value ?? '').trim();
    if (!raw) throw new Error('empty');
    parsed = typeof value === 'number' ? value : Number(BigInt(raw));
  } catch (_) {
    throw new Error('INVALID_EVENT_INDEX');
  }
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 2147483647) {
    throw new Error('INVALID_EVENT_INDEX');
  }
  return parsed;
}

function depositIdentityMatches(deposit, userId, amount, network, address) {
  if (!deposit || deposit.user_id !== userId || Number(deposit.amount) !== Number(amount)) return false;

  const savedAddress = String(deposit.address || '').trim();
  const currentAddress = String(address || '').trim();
  if (!savedAddress || !currentAddress) return true;
  return String(network).endsWith('_trc20')
    ? savedAddress === currentAddress
    : savedAddress.toLowerCase() === currentAddress.toLowerCase();
}

async function findLegacyEventZeroDeposit(userId, amount, txid, network, address, eventIndex) {
  // Before logIndex was forwarded, every chain event was stored as index 0.
  // Keep those already-credited rows idempotent when their real index is non-zero.
  if (eventIndex === 0) return null;

  const { data, error } = await supabase
    .from('deposits')
    .select('id,user_id,asset,network,address,amount,status,event_index')
    .eq('network', network)
    .eq('tx_hash', txid)
    .eq('event_index', 0)
    .maybeSingle();

  if (error) throw error;
  if (!data || !['credited', 'reversed', 'completed'].includes(data.status)) return null;
  return depositIdentityMatches(data, userId, amount, network, address) ? data : null;
}

async function processDeposit(userId, amount, txid, network, address = null, confirmations = 1, eventIndex = 0) {
  try {
    const normalizedNetwork = String(network || '').trim().toLowerCase();
    const hash = String(txid || '').trim().toLowerCase().replace(/^0x/, '');
    const normalizedTxid = normalizedNetwork.endsWith('_trc20') ? hash : '0x' + hash;
    const normalizedEventIndex = normalizeEventIndex(eventIndex);
    if (!Number.isFinite(Number(amount)) || Number(amount) < MIN_DEPOSIT) {
      return { success: false, error: 'Minimum deposit is $' + MIN_DEPOSIT };
    }

    const legacyDeposit = await findLegacyEventZeroDeposit(
      userId,
      Number(amount),
      normalizedTxid,
      normalizedNetwork,
      address,
      normalizedEventIndex
    );
    if (legacyDeposit) {
      return {
        success: true,
        already_processed: true,
        deposit_id: legacyDeposit.id,
        status: legacyDeposit.status,
        amount: Number(legacyDeposit.amount),
        asset: legacyDeposit.asset,
        network: legacyDeposit.network
      };
    }

    // The RPC owns the duplicate check AND all financial writes. A separate
    // JS read cannot protect against concurrent manual/background checks. The
    // read above exists only for rows created before real logIndex forwarding.
    return await processDepositAtomic(userId, Number(amount), normalizedTxid,
      normalizedNetwork, address, confirmations, normalizedEventIndex);
  } catch (error) {
    console.error('❌ Error in processDeposit:', error.message);
    await safeSystemLog('deposit_processing_error', 'Deposit processing error: ' + error.message, {
      user_id: userId, amount, tx_hash: txid, network, address, confirmations, event_index: eventIndex
    });
    return { success: false, error: error.message };
  }
}

async function processDepositAtomic(userId, amount, txid, network, address = null, confirmations = 1, eventIndex = 0) {
  const { data: result, error } = await supabase.rpc('credit_chain_deposit', {
    p_user_id: userId,
    p_amount: amount,
    p_network: network,
    p_tx_hash: txid,
    p_address: address || null,
    // Original server protocol: confirmed provider transfer -> 1, else -> 0.
    // This is not a fabricated count of blockchain confirmations.
    p_confirmations: Math.max(Number(confirmations || 0), 0),
    p_event_index: eventIndex
  });
  if (error) throw error;
  if (!result || result.success !== true) throw new Error(result?.error || 'Deposit processing failed');
  const alreadyProcessed = result.already_processed === true || result.duplicate === true;
  if (!alreadyProcessed) {
    await safeSystemLog('deposit_atomic_success', 'Atomic deposit successful for user ' + userId, {
      deposit_id: result.deposit_id, user_id: userId, amount: result.amount,
      old_balance: result.old_balance, new_balance: result.new_balance,
      asset: result.asset, tx_hash: txid, network, event_index: eventIndex
    });
  }
  return {
    success: true,
    already_processed: alreadyProcessed,
    deposit_id: result.deposit_id,
    status: result.status || 'credited',
    old_balance: result.old_balance,
    new_balance: result.new_balance,
    amount: result.amount,
    asset: result.asset,
    network: result.network,
    personal_bonus: result.personal_bonus,
    inviter_bonus: result.inviter_bonus
  };
}

// ========== CHAIN TRANSFERS ==========
const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const alchemyLastScannedBlock = { bsc: null, eth: null };
const alchemyBlockTimestampCache = new Map();
let alchemyRequestId = 0;
let nextAlchemyLogRequestAt = 0;
let alchemyLogPausedUntil = 0;

async function waitForAlchemyLogRequestSlot() {
  while (true) {
    const now = Date.now();
    const scheduledAt = Math.max(now, nextAlchemyLogRequestAt, alchemyLogPausedUntil);
    nextAlchemyLogRequestAt = scheduledAt + ALCHEMY_LOG_REQUEST_MIN_INTERVAL_MS;
    if (scheduledAt > now) await sleep(scheduledAt - now);
    if (Date.now() >= alchemyLogPausedUntil) return;
  }
}

function pauseAlchemyLogRequests(waitMs = ALCHEMY_RATE_LIMIT_PAUSE_MS) {
  alchemyLogPausedUntil = Math.max(alchemyLogPausedUntil, Date.now() + Math.max(0, waitMs));
  nextAlchemyLogRequestAt = Math.max(nextAlchemyLogRequestAt, alchemyLogPausedUntil);
}

const ALCHEMY_CHAIN_CONFIG = {
  bsc: {
    label: 'BEP20',
    rpcUrl: ALCHEMY_BSC_RPC_URL,
    confirmations: ALCHEMY_BSC_CONFIRMATIONS,
    initialLookback: ALCHEMY_BSC_INITIAL_LOOKBACK_BLOCKS,
    manualLookback: ALCHEMY_BSC_MANUAL_LOOKBACK_BLOCKS,
    reorgOverlap: ALCHEMY_BSC_REORG_OVERLAP_BLOCKS,
    logBlockRange: ALCHEMY_BSC_LOG_BLOCK_RANGE,
    recoveryBlocksPerCheck: ALCHEMY_BSC_RECOVERY_BLOCKS_PER_CHECK,
    logDelayMs: ALCHEMY_BSC_LOG_DELAY_MS,
    tokens: {
      [USDT_BSC_CONTRACT.toLowerCase()]: { symbol: 'USDT', decimals: 18, network: 'usdt_bep20' },
      [USDC_BSC_CONTRACT.toLowerCase()]: { symbol: 'USDC', decimals: 18, network: 'usdc_bep20' }
    }
  },
  eth: {
    label: 'ERC20',
    rpcUrl: ALCHEMY_ETH_RPC_URL,
    confirmations: ALCHEMY_ETH_CONFIRMATIONS,
    initialLookback: ALCHEMY_ETH_INITIAL_LOOKBACK_BLOCKS,
    manualLookback: ALCHEMY_ETH_MANUAL_LOOKBACK_BLOCKS,
    reorgOverlap: ALCHEMY_ETH_REORG_OVERLAP_BLOCKS,
    logBlockRange: ALCHEMY_ETH_LOG_BLOCK_RANGE,
    tokens: {
      [USDT_ETH_CONTRACT.toLowerCase()]: { symbol: 'USDT', decimals: 6, network: 'usdt_erc20' },
      [USDC_ETH_CONTRACT.toLowerCase()]: { symbol: 'USDC', decimals: 6, network: 'usdc_erc20' }
    }
  }
};

function normalizeEvmAddress(address) {
  const normalized = String(address || '').trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(normalized) ? normalized : '';
}

function evmAddressTopic(address) {
  const normalized = normalizeEvmAddress(address);
  if (!normalized) throw new Error('Invalid EVM address');
  return '0x' + normalized.slice(2).padStart(64, '0');
}

function evmAddressFromTopic(topic) {
  const value = String(topic || '').toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(value)) return '';
  return normalizeEvmAddress('0x' + value.slice(24));
}

function rpcHexNumber(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid block number');
  return '0x' + value.toString(16);
}

function safeRpcNumber(value, fieldName) {
  let parsed;
  try {
    parsed = typeof value === 'number' ? value : Number(BigInt(String(value)));
  } catch (_) {
    throw new Error(`Invalid Alchemy ${fieldName}`);
  }
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Invalid Alchemy ${fieldName}`);
  return parsed;
}

function chunkValues(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function retryAfterMilliseconds(response) {
  const raw = response?.headers?.get?.('retry-after');
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

async function alchemyRpc(chainKey, method, params) {
  const chain = ALCHEMY_CHAIN_CONFIG[chainKey];
  if (!chain?.rpcUrl) throw new Error(`Alchemy ${chainKey.toUpperCase()} RPC is not configured`);

  let lastError;
  for (let attempt = 0; attempt <= ALCHEMY_MAX_RETRIES; attempt++) {
    if (method === 'eth_getLogs') await waitForAlchemyLogRequestSlot();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ALCHEMY_REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(chain.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: ++alchemyRequestId,
          method,
          params
        }),
        signal: controller.signal
      });

      const retryAfterMs = retryAfterMilliseconds(response);
      const rawBody = await response.text();
      let payload = null;
      try {
        payload = rawBody ? JSON.parse(rawBody) : null;
      } catch (_) {
        // A gateway can return HTML/text during a transient outage.
      }

      if (!response.ok) {
        const error = new Error(`Alchemy ${chain.label} ${method} HTTP ${response.status}`);
        error.status = response.status;
        error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        error.retryAfterMs = retryAfterMs;
        throw error;
      }

      if (!payload || payload.error) {
        const code = payload?.error?.code;
        const providerMessage = String(payload?.error?.message || 'invalid JSON-RPC response').slice(0, 240);
        const error = new Error(`Alchemy ${chain.label} ${method} error${code == null ? '' : ` ${code}`}: ${providerMessage}`);
        error.code = code;
        error.retryable = code === -32005 || /rate|limit|timeout|temporar|busy|unavailable/i.test(providerMessage);
        throw error;
      }

      return payload.result;
    } catch (error) {
      const normalizedError = error?.name === 'AbortError'
        ? Object.assign(new Error(`Alchemy ${chain.label} ${method} timed out`), { retryable: true })
        : error;
      lastError = normalizedError;

      const retryable = normalizedError?.retryable !== false;
      if (!retryable || attempt >= ALCHEMY_MAX_RETRIES) throw normalizedError;

      const exponentialDelay = ALCHEMY_RETRY_BASE_MS * (2 ** attempt);
      const jitter = Math.floor(Math.random() * Math.max(100, ALCHEMY_RETRY_BASE_MS));
      const retryDelay = Math.max(Number(normalizedError?.retryAfterMs || 0), exponentialDelay + jitter);
      if (method === 'eth_getLogs' && (normalizedError?.status === 429 || normalizedError?.code === -32005)) {
        pauseAlchemyLogRequests(Math.max(ALCHEMY_RATE_LIMIT_PAUSE_MS, retryDelay));
      }
      await sleep(retryDelay);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error(`Alchemy ${chainKey} request failed`);
}

async function alchemyBlockTimestamp(chainKey, blockHex) {
  const cacheKey = `${chainKey}:${String(blockHex).toLowerCase()}`;
  if (alchemyBlockTimestampCache.has(cacheKey)) return alchemyBlockTimestampCache.get(cacheKey);

  let timestamp = Date.now();
  try {
    const block = await alchemyRpc(chainKey, 'eth_getBlockByNumber', [blockHex, false]);
    const seconds = safeRpcNumber(block?.timestamp, 'block timestamp');
    timestamp = seconds * 1000;
  } catch (error) {
    console.warn(`⚠️ Alchemy ${chainKey.toUpperCase()} block timestamp fallback:`, error.message);
  }

  alchemyBlockTimestampCache.set(cacheKey, timestamp);
  if (alchemyBlockTimestampCache.size > 2000) {
    const oldestKey = alchemyBlockTimestampCache.keys().next().value;
    if (oldestKey) alchemyBlockTimestampCache.delete(oldestKey);
  }
  return timestamp;
}

async function resolveAlchemyScanRange(chainKey, mode) {
  const chain = ALCHEMY_CHAIN_CONFIG[chainKey];
  const latestBlock = safeRpcNumber(await alchemyRpc(chainKey, 'eth_blockNumber', []), 'latest block');
  const latestConfirmedBlock = latestBlock - chain.confirmations;
  if (latestConfirmedBlock < 0) return null;

  let fromBlock;
  if (mode === 'background' && Number.isSafeInteger(alchemyLastScannedBlock[chainKey])) {
    fromBlock = Math.max(0, alchemyLastScannedBlock[chainKey] - chain.reorgOverlap + 1);
  } else {
    const lookback = mode === 'background' ? chain.initialLookback : chain.manualLookback;
    fromBlock = Math.max(0, latestConfirmedBlock - lookback + 1);
  }

  if (fromBlock > latestConfirmedBlock) fromBlock = latestConfirmedBlock;
  const recoveryBatch = mode === 'background' ? Number(chain.recoveryBlocksPerCheck || 0) : 0;
  const toBlock = recoveryBatch > 0
    ? Math.min(latestConfirmedBlock, fromBlock + recoveryBatch - 1)
    : latestConfirmedBlock;
  return { fromBlock, toBlock };
}

async function scanAlchemyLogTransfers(chainKey, addresses, mode = 'manual', options = {}) {
  const chain = ALCHEMY_CHAIN_CONFIG[chainKey];
  if (!chain) throw new Error(`Unsupported Alchemy chain: ${chainKey}`);

  const normalizedAddresses = Array.from(new Set((addresses || []).map(normalizeEvmAddress).filter(Boolean)));
  if (!normalizedAddresses.length) return { transactions: [], fromBlock: null, toBlock: null };

  const hasExplicitRange = Number.isSafeInteger(options?.fromBlock) && Number.isSafeInteger(options?.toBlock);
  const scanRange = hasExplicitRange
    ? {
        fromBlock: Math.max(0, options.fromBlock),
        toBlock: Math.max(0, options.toBlock)
      }
    : await resolveAlchemyScanRange(chainKey, mode);
  if (!scanRange) return { transactions: [], fromBlock: null, toBlock: null };
  if (scanRange.fromBlock > scanRange.toBlock) return { transactions: [], fromBlock: scanRange.fromBlock, toBlock: scanRange.toBlock };

  const requestedNetwork = String(options?.network || '').trim().toLowerCase();
  const contractAddresses = Object.entries(chain.tokens)
    .filter(([, token]) => !requestedNetwork || token.network === requestedNetwork)
    .map(([address]) => address);
  if (!contractAddresses.length) throw new Error(`Unsupported ${chain.label} token network: ${requestedNetwork}`);
  const addressChunks = chunkValues(normalizedAddresses, ALCHEMY_ADDRESS_BATCH_SIZE);
  const rawLogs = [];
  const logRequests = [];

  for (let fromBlock = scanRange.fromBlock; fromBlock <= scanRange.toBlock; fromBlock += chain.logBlockRange) {
    const toBlock = Math.min(scanRange.toBlock, fromBlock + chain.logBlockRange - 1);

    for (const addressChunk of addressChunks) {
      logRequests.push({ fromBlock, toBlock, addressChunk });
    }
  }

  const requestedConcurrency = Number.isSafeInteger(options?.concurrency) ? options.concurrency : 1;
  const concurrency = Math.max(1, Math.min(requestedConcurrency, ALCHEMY_BSC_USER_SCAN_CONCURRENCY));
  let nextRequestIndex = 0;
  let completedRequests = 0;

  async function logWorker() {
    while (nextRequestIndex < logRequests.length) {
      const requestIndex = nextRequestIndex++;
      const { fromBlock, toBlock, addressChunk } = logRequests[requestIndex];
      const destinationTopics = addressChunk.map(evmAddressTopic);
      const logs = await alchemyRpc(chainKey, 'eth_getLogs', [{
        fromBlock: rpcHexNumber(fromBlock),
        toBlock: rpcHexNumber(toBlock),
        address: contractAddresses,
        topics: [
          ERC20_TRANSFER_TOPIC,
          null,
          destinationTopics.length === 1 ? destinationTopics[0] : destinationTopics
        ]
      }]);

      if (!Array.isArray(logs)) throw new Error(`Alchemy ${chain.label} eth_getLogs returned invalid data`);
      rawLogs.push(...logs);
      completedRequests++;
      if (typeof options?.onProgress === 'function') {
        try {
          options.onProgress({
            completedRequests,
            totalRequests: logRequests.length,
            fromBlock: scanRange.fromBlock,
            toBlock: scanRange.toBlock
          });
        } catch (progressError) {
          console.warn('⚠️ Deposit scan progress callback failed:', progressError.message);
        }
      }
      if (chain.logDelayMs > 0) await sleep(chain.logDelayMs);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, logRequests.length)) }, () => logWorker())
  );

  const destinationSet = new Set(normalizedAddresses);
  const uniqueLogs = new Map();
  for (const log of rawLogs) {
    if (log?.removed === true) continue;
    const uniqueKey = `${String(log?.transactionHash || '').toLowerCase()}:${String(log?.logIndex || '')}:${String(log?.address || '').toLowerCase()}`;
    if (!uniqueLogs.has(uniqueKey)) uniqueLogs.set(uniqueKey, log);
  }

  const transactions = [];
  for (const log of uniqueLogs.values()) {
    try {
      const tokenContract = normalizeEvmAddress(log?.address);
      const token = chain.tokens[tokenContract];
      if (!token) continue;

      const toAddress = evmAddressFromTopic(log?.topics?.[2]);
      if (!destinationSet.has(toAddress)) continue;

      const fromAddress = evmAddressFromTopic(log?.topics?.[1]);
      const rawAmount = BigInt(String(log?.data || '0x0'));
      const amount = Number(ethers.formatUnits(rawAmount, token.decimals));
      if (!Number.isFinite(amount) || amount < MIN_DEPOSIT) continue;

      const blockNumber = safeRpcNumber(log?.blockNumber, 'log block number');
      const blockHex = rpcHexNumber(blockNumber);
      const timestamp = await alchemyBlockTimestamp(chainKey, blockHex);
      const transactionId = String(log?.transactionHash || '').toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(transactionId)) continue;
      const eventIndex = normalizeEventIndex(log?.logIndex);

      transactions.push({
        transaction_id: transactionId,
        event_index: eventIndex,
        to: toAddress,
        from: fromAddress,
        amount,
        token: token.symbol,
        confirmed: true,
        network: token.network,
        timestamp,
        blockNumber
      });
    } catch (error) {
      throw new Error(`Alchemy ${chain.label} returned an invalid Transfer log: ${error.message}`);
    }
  }

  transactions.sort((a, b) => b.blockNumber - a.blockNumber || b.event_index - a.event_index || b.timestamp - a.timestamp);
  return { transactions, fromBlock: scanRange.fromBlock, toBlock: scanRange.toBlock };
}

async function getAlchemyLogTransfers(chainKey, addresses, mode = 'manual', options = {}) {
  const scan = await scanAlchemyLogTransfers(chainKey, addresses, mode, options);
  return scan.transactions;
}

function alchemyAssetTransferEventIndex(transfer) {
  const candidates = [transfer?.logIndex, transfer?.metadata?.logIndex];
  for (const candidate of candidates) {
    if (candidate !== null && candidate !== undefined && String(candidate).trim() !== '') {
      return normalizeEventIndex(candidate);
    }
  }

  // ERC20 transfer uniqueId is normally <tx hash>:log:<log index>.
  const uniqueId = String(transfer?.uniqueId || '').trim();
  const match = uniqueId.match(/(?:^|:)(0x[0-9a-f]+|[0-9]+)$/i);
  if (match) return normalizeEventIndex(match[1]);

  const error = new Error('Alchemy ERC20 transfer logIndex is unavailable');
  error.code = 'EVENT_INDEX_UNAVAILABLE';
  throw error;
}

async function getAlchemyERC20AssetTransfers(address, network = '') {
  const normalizedAddress = normalizeEvmAddress(address);
  if (!normalizedAddress) return [];

  const chain = ALCHEMY_CHAIN_CONFIG.eth;
  const requestedNetwork = String(network || '').trim().toLowerCase();
  const contractAddresses = Object.entries(chain.tokens)
    .filter(([, token]) => !requestedNetwork || token.network === requestedNetwork)
    .map(([contractAddress]) => contractAddress);
  if (!contractAddresses.length) throw new Error(`Unsupported ERC20 token network: ${requestedNetwork}`);
  const latestBlock = safeRpcNumber(await alchemyRpc('eth', 'eth_blockNumber', []), 'latest block');
  const confirmedBlock = Math.max(0, latestBlock - chain.confirmations);
  const transactions = [];
  let pageKey = null;

  for (let page = 0; page < ALCHEMY_ETH_MAX_PAGES; page++) {
    const request = {
      fromBlock: '0x0',
      toBlock: rpcHexNumber(confirmedBlock),
      toAddress: normalizedAddress,
      contractAddresses,
      category: ['erc20'],
      excludeZeroValue: true,
      withMetadata: true,
      order: 'desc',
      maxCount: '0x3e8'
    };
    if (pageKey) request.pageKey = pageKey;

    const result = await alchemyRpc('eth', 'alchemy_getAssetTransfers', [request]);
    if (!result || !Array.isArray(result.transfers)) {
      throw new Error('Alchemy ERC20 Transfers API returned invalid data');
    }

    for (const transfer of result.transfers) {
      try {
        const toAddress = normalizeEvmAddress(transfer?.to);
        if (toAddress !== normalizedAddress) continue;

        const tokenContract = normalizeEvmAddress(transfer?.rawContract?.address);
        const token = chain.tokens[tokenContract];
        if (!token) continue;

        let amount = Number(transfer?.value);
        const rawValue = transfer?.rawContract?.value;
        if (rawValue != null && String(rawValue) !== '') {
          amount = Number(ethers.formatUnits(BigInt(String(rawValue)), token.decimals));
        }
        if (!Number.isFinite(amount) || amount < MIN_DEPOSIT) continue;

        const transactionId = String(transfer?.hash || '').toLowerCase();
        if (!/^0x[0-9a-f]{64}$/.test(transactionId)) continue;
        const eventIndex = alchemyAssetTransferEventIndex(transfer);

        transactions.push({
          transaction_id: transactionId,
          event_index: eventIndex,
          to: toAddress,
          from: normalizeEvmAddress(transfer?.from),
          amount,
          token: token.symbol,
          confirmed: true,
          network: token.network,
          timestamp: Date.parse(transfer?.metadata?.blockTimestamp || '') || Date.now(),
          blockNumber: safeRpcNumber(transfer?.blockNum, 'transfer block number')
        });
      } catch (error) {
        if (error?.code === 'EVENT_INDEX_UNAVAILABLE') throw error;
        continue;
      }
    }

    pageKey = String(result.pageKey || '').trim();
    if (!pageKey) break;
  }

  const uniqueTransactions = new Map();
  for (const transaction of transactions) {
    const key = `${transaction.network}:${transaction.transaction_id}:${transaction.event_index}`;
    if (!uniqueTransactions.has(key)) uniqueTransactions.set(key, transaction);
  }
  return Array.from(uniqueTransactions.values()).sort((a, b) => b.blockNumber - a.blockNumber || b.event_index - a.event_index || b.timestamp - a.timestamp);
}

async function getBEP20Transactions(address) {
  try {
    return await getAlchemyLogTransfers('bsc', [address], 'manual');
  } catch (error) {
    console.error('❌ BEP20 Alchemy transfer fetch error:', error.message);
    throw error;
  }
}

async function getERC20Transactions(address, network = '') {
  try {
    return await getAlchemyERC20AssetTransfers(address, network);
  } catch (error) {
    console.warn('⚠️ ERC20 Transfers API failed; using Alchemy log fallback:', error.message);
    try {
      return await getAlchemyLogTransfers('eth', [address], 'manual', { network });
    } catch (fallbackError) {
      console.error('❌ ERC20 Alchemy transfer fetch error:', fallbackError.message);
      throw fallbackError;
    }
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
async function fetchAllDepositWallets(selectColumns, filter) {
  const wallets = [];

  for (let offset = 0; ; offset += DEPOSIT_WALLET_PAGE_SIZE) {
    let query = supabase
      .from('deposit_wallets')
      .select(selectColumns)
      .order('user_id', { ascending: true })
      .range(offset, offset + DEPOSIT_WALLET_PAGE_SIZE - 1);

    if (filter?.or) query = query.or(filter.or);
    if (filter?.notNull) query = query.not(filter.notNull, 'is', null);

    const { data, error } = await query;
    if (error) throw error;
    wallets.push(...(data || []));
    if (!data || data.length < DEPOSIT_WALLET_PAGE_SIZE) break;
  }

  return wallets;
}

function buildEvmWalletAddressIndex(wallets, addressFields, label) {
  const index = new Map();

  for (const wallet of wallets || []) {
    for (const field of addressFields) {
      const address = normalizeEvmAddress(wallet?.[field]);
      if (!address) continue;

      const existing = index.get(address);
      if (existing && existing.user_id !== wallet.user_id) {
        throw new Error(`${label} address belongs to multiple users: ${address}`);
      }
      index.set(address, wallet);
    }
  }

  return index;
}

async function handleCheckEvmDeposits({ chainKey, label, addressFields, filter, sweepAfterCredit }) {
  try {
    console.log(`🔄 Checking ${label} deposits via Alchemy...`);

    const selectColumns = ['user_id', ...addressFields].join(',');
    const wallets = await fetchAllDepositWallets(selectColumns, { or: filter });
    const walletByAddress = buildEvmWalletAddressIndex(wallets, addressFields, label);
    const scan = await scanAlchemyLogTransfers(chainKey, Array.from(walletByAddress.keys()), 'background');
    const transactions = scan.transactions;

    let depositsFound = 0;
    let duplicatesSkipped = 0;
    let errors = 0;
    // One sweep per user/token is enough: it transfers the complete on-chain
    // token balance and avoids parallel sweep attempts during recovery replay.
    const pendingSweeps = new Map();
    const rememberSweep = (wallet, tx) => {
      if (!sweepAfterCredit) return;
      const key = `${wallet.user_id}:${tx.token}:${tx.network}`;
      pendingSweeps.set(key, { userId: wallet.user_id, token: tx.token, network: tx.network });
    };

    for (const tx of transactions) {
      const wallet = walletByAddress.get(normalizeEvmAddress(tx.to));
      if (!wallet) continue;

      try {
        const { data: existing, error: existingError } = await supabase
          .from('deposits')
          .select('id, status')
          .eq('tx_hash', tx.transaction_id)
          .eq('network', tx.network)
          .eq('event_index', tx.event_index)
          .maybeSingle();

        if (existingError) throw existingError;
        if (existing && ['credited', 'reversed'].includes(existing.status)) {
          duplicatesSkipped++;
          console.log(`⏭️ Skipping duplicate ${tx.network} transaction: ${tx.transaction_id}`);
          // A manually credited deposit bypassed the original auto-sweep call.
          // When recovery sees it again, retry the sweep without re-crediting.
          if (existing.status === 'credited') rememberSweep(wallet, tx);
          continue;
        }

        const result = await processDeposit(
          wallet.user_id,
          tx.amount,
          tx.transaction_id,
          tx.network,
          tx.to,
          tx.confirmed ? 1 : 0,
          tx.event_index
        );
        if (!result.success) throw new Error(result.error || 'Deposit processing failed');
        if (result.already_processed) {
          duplicatesSkipped++;
          if (result.status === 'credited') rememberSweep(wallet, tx);
          continue;
        }

        depositsFound++;
        console.log(`💰 NEW ${tx.network} DEPOSIT: $${tx.amount} ${tx.token} for user ${wallet.user_id}`);

        rememberSweep(wallet, tx);
      } catch (error) {
        if (/already_processed|duplicate/i.test(String(error.message || ''))) {
          duplicatesSkipped++;
          console.log(`⏭️ Duplicate ${tx.network} deposit skipped: ${tx.transaction_id}`);
        } else {
          errors++;
          console.error(`❌ Error processing ${tx.network} deposit ${tx.transaction_id}:`, error.message);
        }
      }
    }

    for (const sweep of pendingSweeps.values()) {
      // Non-blocking: crediting and the scanner cursor never wait for gas or a
      // sweep receipt. A later recovery replay can safely request it again.
      sweepDepositBEP20(sweep.userId, sweep.token, sweep.network).catch((error) =>
        console.error('Sweep background error:', error.message)
      );
    }

    // Advance only after every discovered transfer was either atomically credited
    // or proved to be an existing transaction. A database error must be retried.
    if (errors === 0 && Number.isSafeInteger(scan.toBlock)) {
      alchemyLastScannedBlock[chainKey] = scan.toBlock;
    }

    console.log(`✅ ${label}: Processed ${wallets.length} wallets, found ${depositsFound} new deposits, skipped ${duplicatesSkipped} duplicates, errors: ${errors}`);
    return {
      success: errors === 0,
      processed: wallets.length,
      deposits: depositsFound,
      duplicates: duplicatesSkipped,
      errors
    };
  } catch (error) {
    console.error(`❌ ${label} check error:`, error.message);
    return { success: false, error: error.message };
  }
}

async function handleCheckBEP20Deposits() {
  return handleCheckEvmDeposits({
    chainKey: 'bsc',
    label: 'BEP20',
    addressFields: ['usdt_bep20_address', 'usdc_bep20_address'],
    filter: 'usdt_bep20_address.not.is.null,usdc_bep20_address.not.is.null',
    sweepAfterCredit: true
  });
}

async function handleCheckERC20Deposits() {
  return handleCheckEvmDeposits({
    chainKey: 'eth',
    label: 'ERC20',
    addressFields: ['usdt_erc20_address', 'usdc_erc20_address'],
    filter: 'usdt_erc20_address.not.is.null,usdc_erc20_address.not.is.null',
    sweepAfterCredit: false
  });
}

async function handleCheckTRC20Deposits() {
  try {
    console.log('🔄 Checking TRC20 deposits...');

    const wallets = await fetchAllDepositWallets(
      'user_id,usdt_trc20_address',
      { notNull: 'usdt_trc20_address' }
    );

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
                .from('deposits')
                .select('id, status')
                .eq('tx_hash', tx.transaction_id)
                .eq('network', tx.network)
                .maybeSingle();

              if (existing && ['credited', 'reversed'].includes(existing.status)) {
                duplicatesSkipped++;
                console.log(`⏭️ Skipping duplicate ${tx.network} transaction: ${tx.transaction_id}`);
                continue;
              }

              const result = await processDeposit(wallet.user_id, tx.amount, tx.transaction_id, tx.network, tx.to || address, tx.confirmed ? 1 : 0);
              if (!result.success) throw new Error(result.error || 'Deposit processing failed');
              if (result.already_processed) { duplicatesSkipped++; continue; }
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

async function checkUserTRC20Deposits(userId, options = {}) {
  const summary = { success: true, network_group: 'trc20', checked: 0, deposits: 0, duplicates: 0, errors: 0 };

  try {
    const requestedNetwork = String(options?.network || '').trim().toLowerCase();
    if (requestedNetwork && requestedNetwork !== 'usdt_trc20') {
      throw new Error(`Unsupported TRC20 network: ${requestedNetwork}`);
    }
    if (typeof options?.onProgress === 'function') options.onProgress({ phase: 'recent', scannedBlocks: null, totalBlocks: null });
    const { data: wallet, error } = await supabase
      .from('deposit_wallets')
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
          const result = await processDeposit(userId, tx.amount, tx.transaction_id, tx.network, tx.to || address, tx.confirmed ? 1 : 0);
          if (!result?.success) throw new Error(result?.error || 'Deposit processing failed');
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

async function checkUserBEP20Deposits(userId, options = {}) {
  const summary = { success: true, network_group: 'bep20', checked: 0, deposits: 0, duplicates: 0, errors: 0 };

  try {
    const requestedNetwork = String(options?.network || '').trim().toLowerCase();
    if (requestedNetwork && !requestedNetwork.endsWith('_bep20')) {
      throw new Error(`Unsupported BEP20 network: ${requestedNetwork}`);
    }

    const { data: wallet, error } = await supabase
      .from('deposit_wallets')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw error;
    if (!wallet) return summary;

    const selectedAddressField = requestedNetwork ? networkFields[requestedNetwork]?.addressField : null;
    const rawAddresses = selectedAddressField
      ? [wallet[selectedAddressField]]
      : [wallet.usdt_bep20_address, wallet.usdc_bep20_address];
    const addresses = Array.from(new Set(rawAddresses.map(normalizeEvmAddress).filter(Boolean)));

    const chain = ALCHEMY_CHAIN_CONFIG.bsc;
    const latestBlock = safeRpcNumber(await alchemyRpc('bsc', 'eth_blockNumber', []), 'latest block');
    const latestConfirmedBlock = latestBlock - chain.confirmations;
    if (latestConfirmedBlock < 0 || !addresses.length) return summary;

    // Search the existing 10,000-block recovery window newest-first. The first
    // 600-block band is the fast path; older bands are the extended scan.
    const historyFromBlock = Math.max(0, latestConfirmedBlock - chain.initialLookback + 1);
    const blocksPerAddress = latestConfirmedBlock - historyFromBlock + 1;
    const totalBlocks = blocksPerAddress * addresses.length;
    const bandSize = Math.max(chain.logBlockRange, chain.manualLookback);
    let completedAddressBlocks = 0;

    const reportProgress = (progress) => {
      if (typeof options?.onProgress !== 'function') return;
      try {
        options.onProgress({
          phase: progress.phase,
          scannedBlocks: Math.min(totalBlocks, Math.max(0, progress.scannedBlocks)),
          totalBlocks
        });
      } catch (progressError) {
        console.warn('⚠️ BEP20 progress reporting failed:', progressError.message);
      }
    };

    reportProgress({ phase: 'recent', scannedBlocks: 0 });

    for (const address of addresses) {
      let bandToBlock = latestConfirmedBlock;
      let extendedHistoryLogged = false;

      while (bandToBlock >= historyFromBlock) {
        const bandFromBlock = Math.max(historyFromBlock, bandToBlock - bandSize + 1);
        const completedBeforeBand = latestConfirmedBlock - bandToBlock;
        const bandBlocks = bandToBlock - bandFromBlock + 1;
        const scan = await scanAlchemyLogTransfers('bsc', [address], 'manual', {
          fromBlock: bandFromBlock,
          toBlock: bandToBlock,
          concurrency: ALCHEMY_BSC_USER_SCAN_CONCURRENCY,
          network: requestedNetwork,
          onProgress: ({ completedRequests, totalRequests }) => {
            const currentBandBlocks = totalRequests > 0
              ? Math.ceil((completedRequests / totalRequests) * bandBlocks)
              : bandBlocks;
            const scannedBlocks = completedAddressBlocks + completedBeforeBand + currentBandBlocks;
            reportProgress({
              phase: completedBeforeBand + currentBandBlocks > bandSize ? 'extended' : 'recent',
              scannedBlocks
            });
          }
        });
        const transactions = scan.transactions;
        let creditedInBand = 0;
        summary.checked += transactions.length;

        for (const tx of transactions) {
          try {
            const result = await processDeposit(userId, tx.amount, tx.transaction_id, tx.network, tx.to || address, tx.confirmed ? 1 : 0, tx.event_index);
            if (!result?.success) throw new Error(result?.error || 'Deposit processing failed');
            if (result.already_processed) {
              summary.duplicates++;
            } else {
              summary.deposits++;
              creditedInBand++;
              // Existing non-blocking auto-sweep behavior is preserved.
              sweepDepositBEP20(userId, tx.token, tx.network).catch(console.error);
            }
          } catch (err) {
            summary.errors++;
            console.error(`❌ Error processing transaction ${tx.transaction_id}:`, err.message);
          }
        }

        if (creditedInBand > 0 || bandFromBlock === historyFromBlock) break;

        if (!extendedHistoryLogged) {
          console.log(`🔎 BEP20: no uncredited transfer in the latest ${bandSize} blocks for ${userId}; extending Alchemy history scan`);
          extendedHistoryLogged = true;
        }
        reportProgress({
          phase: 'extended',
          scannedBlocks: completedAddressBlocks + completedBeforeBand + bandBlocks
        });
        bandToBlock = bandFromBlock - 1;
      }

      completedAddressBlocks += blocksPerAddress;
    }

    summary.scanned_blocks = Math.min(totalBlocks, completedAddressBlocks);
    summary.total_blocks = totalBlocks;
    return summary;
  } catch (error) {
    summary.success = false;
    summary.error = error.message;
    console.error('❌ checkUserBEP20Deposits error:', error.message);
    return summary;
  }
}

async function checkUserERC20Deposits(userId, options = {}) {
  const summary = { success: true, network_group: 'erc20', checked: 0, deposits: 0, duplicates: 0, errors: 0 };

  try {
    const requestedNetwork = String(options?.network || '').trim().toLowerCase();
    if (requestedNetwork && !requestedNetwork.endsWith('_erc20')) {
      throw new Error(`Unsupported ERC20 network: ${requestedNetwork}`);
    }
    if (typeof options?.onProgress === 'function') options.onProgress({ phase: 'recent', scannedBlocks: null, totalBlocks: null });
    const { data: wallet, error } = await supabase
      .from('deposit_wallets')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw error;
    if (!wallet) return summary;

    const selectedAddressField = requestedNetwork ? networkFields[requestedNetwork]?.addressField : null;
    const rawAddresses = selectedAddressField
      ? [wallet[selectedAddressField]]
      : [wallet.usdt_erc20_address, wallet.usdc_erc20_address];
    const addresses = Array.from(new Set(rawAddresses.filter(Boolean)));

    for (const address of addresses) {
      const transactions = await getERC20Transactions(address, requestedNetwork);
      summary.checked += transactions.length;

      for (const tx of transactions) {
        try {
          const result = await processDeposit(userId, tx.amount, tx.transaction_id, tx.network, tx.to || address, tx.confirmed ? 1 : 0, tx.event_index);
          if (!result?.success) throw new Error(result?.error || 'Deposit processing failed');
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

// Compatibility with pixelnft-api: an empty body checks this user's three
// chain groups; an explicit network preserves the original single-group API.
async function checkUserRequestedNetworks(userId, network = '', options = {}) {
  const selectedNetwork = String(network || '').trim().toLowerCase();
  const checkOptions = { ...options, network: selectedNetwork };
  const jobs = [];
  if (!selectedNetwork || selectedNetwork.endsWith('_bep20')) jobs.push(checkUserBEP20Deposits(userId, checkOptions));
  if (!selectedNetwork || selectedNetwork.endsWith('_erc20')) jobs.push(checkUserERC20Deposits(userId, checkOptions));
  if (!selectedNetwork || selectedNetwork.endsWith('_trc20')) jobs.push(checkUserTRC20Deposits(userId, checkOptions));
  const groups = await Promise.all(jobs);
  const failures = groups.filter(g => !g.success || g.errors > 0).map(g => ({
    network: g.network_group, error: g.error || 'DEPOSIT_PROCESSING_FAILED', count: g.errors
  }));
  return {
    success: failures.length === 0,
    checked: groups.reduce((sum, g) => sum + Number(g.checked || 0), 0),
    deposits: groups.reduce((sum, g) => sum + Number(g.deposits || 0), 0),
    duplicates: groups.reduce((sum, g) => sum + Number(g.duplicates || 0), 0),
    errors: groups.reduce((sum, g) => sum + Number(g.errors || 0), 0),
    failures, groups
  };
}

// In-memory jobs keep the HTTP request short while the authenticated client
// polls a safe, read-only status endpoint. Financial crediting remains inside
// the existing atomic processDeposit flow above.
const depositCheckJobs = new Map();
const activeDepositCheckJobByUser = new Map();
const depositCheckQueue = [];
let runningDepositCheckJobs = 0;

function cleanupDepositCheckJobs() {
  const now = Date.now();
  for (const [jobId, job] of depositCheckJobs.entries()) {
    if (job.status === 'queued' || job.status === 'running') continue;
    if (now - job.updatedAt <= DEPOSIT_CHECK_JOB_TTL_MS) continue;
    depositCheckJobs.delete(jobId);
    if (activeDepositCheckJobByUser.get(job.userId) === jobId) {
      activeDepositCheckJobByUser.delete(job.userId);
    }
  }
}

function updateDepositCheckJobProgress(job, progress = {}) {
  if (!job || !['queued', 'running'].includes(job.status)) return;
  if (progress.phase) job.phase = progress.phase;
  if (Number.isFinite(progress.scannedBlocks)) job.scannedBlocks = Math.max(0, Number(progress.scannedBlocks));
  if (Number.isFinite(progress.totalBlocks) && Number(progress.totalBlocks) > 0) job.totalBlocks = Number(progress.totalBlocks);
  if (job.totalBlocks > 0) {
    const percent = Math.min(99, Math.floor((job.scannedBlocks / job.totalBlocks) * 100));
    job.percent = Math.max(job.percent || 0, percent);
  }
  job.updatedAt = Date.now();
}

function publicDepositCheckJob(job, reused = false) {
  const result = job.result || {};
  const checking = job.status === 'queued' || job.status === 'running';
  return {
    success: true,
    job_id: job.id,
    job_status: job.status,
    checking,
    reused,
    network: job.network,
    phase: job.phase,
    progress: {
      percent: Number.isFinite(job.percent) ? job.percent : null,
      scanned_blocks: Number.isFinite(job.scannedBlocks) ? job.scannedBlocks : null,
      total_blocks: Number.isFinite(job.totalBlocks) ? job.totalBlocks : null
    },
    found: Boolean(job.found),
    checked: Number(result.checked || 0),
    deposits: Number(result.deposits || 0),
    duplicates: Number(result.duplicates || 0),
    error_code: job.errorCode || null,
    created_at: new Date(job.createdAt).toISOString(),
    updated_at: new Date(job.updatedAt).toISOString()
  };
}

function resultWasAlchemyRateLimited(result) {
  return (result?.failures || []).some((failure) => /Alchemy .* (HTTP 429|error -32005)/i.test(String(failure?.error || '')));
}

async function runDepositCheckJob(job) {
  job.status = 'running';
  job.phase = 'recent';
  job.updatedAt = Date.now();

  const onProgress = (progress) => updateDepositCheckJobProgress(job, progress);
  let result = await checkUserRequestedNetworks(job.userId, job.network, { onProgress });

  // A provider-side burst can still happen during platform-wide traffic. Wait
  // once and resume automatically instead of asking the user to press again.
  if (resultWasAlchemyRateLimited(result)) {
    job.phase = 'retrying';
    job.updatedAt = Date.now();
    pauseAlchemyLogRequests(ALCHEMY_RATE_LIMIT_PAUSE_MS);
    await sleep(ALCHEMY_RATE_LIMIT_PAUSE_MS);
    result = await checkUserRequestedNetworks(job.userId, job.network, { onProgress });
  }

  job.result = result;
  job.found = Number(result?.deposits || 0) > 0;
  job.updatedAt = Date.now();
  job.finishedAt = job.updatedAt;

  if (result?.success) {
    job.status = 'completed';
    job.phase = job.found ? 'credited' : 'complete';
    job.percent = 100;
  } else {
    job.status = 'failed';
    job.phase = 'failed';
    job.errorCode = resultWasAlchemyRateLimited(result)
      ? 'DEPOSIT_PROVIDER_BUSY'
      : 'DEPOSIT_CHECK_FAILED';
  }
}

function drainDepositCheckQueue() {
  while (runningDepositCheckJobs < DEPOSIT_CHECK_JOB_CONCURRENCY && depositCheckQueue.length) {
    const jobId = depositCheckQueue.shift();
    const job = depositCheckJobs.get(jobId);
    if (!job || job.status !== 'queued') continue;
    runningDepositCheckJobs++;
    runDepositCheckJob(job)
      .catch((error) => {
        job.status = 'failed';
        job.phase = 'failed';
        job.errorCode = /429|rate|limit/i.test(String(error?.message || ''))
          ? 'DEPOSIT_PROVIDER_BUSY'
          : 'DEPOSIT_CHECK_FAILED';
        job.updatedAt = Date.now();
        job.finishedAt = job.updatedAt;
        console.error(`❌ Deposit check job ${job.id} failed:`, error.message);
      })
      .finally(() => {
        runningDepositCheckJobs--;
        drainDepositCheckQueue();
      });
  }
}

function startOrReuseDepositCheckJob(userId, network) {
  cleanupDepositCheckJobs();
  const existingId = activeDepositCheckJobByUser.get(userId);
  const existing = existingId ? depositCheckJobs.get(existingId) : null;
  if (existing) {
    const running = existing.status === 'queued' || existing.status === 'running';
    const recentlyFinished = existing.finishedAt && Date.now() - existing.finishedAt < DEPOSIT_CHECK_RESULT_REUSE_MS;
    if (running || (existing.network === network && recentlyFinished)) return { job: existing, reused: true };
  }

  const now = Date.now();
  const job = {
    id: crypto.randomUUID(),
    userId,
    network,
    status: 'queued',
    phase: 'queued',
    percent: null,
    scannedBlocks: null,
    totalBlocks: null,
    found: false,
    result: null,
    errorCode: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: null
  };
  depositCheckJobs.set(job.id, job);
  activeDepositCheckJobByUser.set(userId, job.id);
  depositCheckQueue.push(job.id);
  drainDepositCheckQueue();
  return { job, reused: false };
}

async function verifyAdminUnlock(req, user) {
  const { data, error } = await supabase.rpc('pixel_app_api', {
    p_user: user.id, p_session: req.pixelSession,
    p_action: 'admin.overview', p_payload: { admin_token: readParam(req, 'admin_token', '') }
  });
  return !error && !!data && !data.error;
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
  const requestStarted = process.hrtime.bigint();
  try {
    const user_id = readParam(req, 'user_id');
    const network = String(readParam(req, 'network', 'usdt_bep20')).trim().toLowerCase();

    if (!user_id) {
      return res.status(400).json({ success: false, error: 'User ID is required' });
    }

    if (!allowedNetworks.includes(network)) {
      return res.status(400).json({ success: false, error: 'Unsupported network' });
    }

    console.log(`🔐 [SECURE] Generating ${network} wallet for user: ${user_id}, IP: ${req.ip}`);

    const walletStarted = process.hrtime.bigint();
    const result = await generateWalletSingleFlight(user_id, network);
    const walletMs = Number(process.hrtime.bigint() - walletStarted) / 1e6;

    if (result.exists) {
      runInBackground('deposit_address_sync', () => syncDepositAddress(user_id, result.network, result.address));
    } else {
      await syncDepositAddress(user_id, result.network, result.address);
    }

    const totalMs = Number(process.hrtime.bigint() - requestStarted) / 1e6;
    res.set('Server-Timing', `wallet;dur=${walletMs.toFixed(1)}, total;dur=${totalMs.toFixed(1)}`);
    res.set('X-Response-Time', `${totalMs.toFixed(1)}ms`);
    return res.json({ ...result, min_deposit: MIN_DEPOSIT, timing_ms: Math.round(totalMs) });
  } catch (error) {
    console.error('❌ API Generate wallet error:', error.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// 2. Public/app endpoint
// Requires Bearer auth and resolves user only from the token.
app.post('/public/deposit/generate', async (req, res) => {
  const requestStarted = process.hrtime.bigint();
  try {
    const network = String(readParam(req, 'network', 'usdt_bep20')).trim().toLowerCase();
    const authStarted = process.hrtime.bigint();
    const bearerUser = await getUserFromBearerToken(req);
    const authMs = Number(process.hrtime.bigint() - authStarted) / 1e6;

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

    if (req.pixelState?.config?.deposits_enabled === false) {
      return res.status(403).json({ success: false, error: 'DEPOSITS_PAUSED' });
    }
    const walletStarted = process.hrtime.bigint();
    const result = await generateWalletSingleFlight(user_id, network);
    const walletMs = Number(process.hrtime.bigint() - walletStarted) / 1e6;

    const syncStarted = process.hrtime.bigint();
    if (result.exists) {
      runInBackground('public_deposit_address_sync', () => syncDepositAddress(user_id, result.network, result.address));
    } else {
      await syncDepositAddress(user_id, result.network, result.address);
    }
    const syncMs = result.exists ? 0 : Number(process.hrtime.bigint() - syncStarted) / 1e6;

    runInBackground('public_deposit_generated', () => safeSystemLog('public_deposit_generated', `Public deposit address generated for user ${user_id}`, {
      user_id,
      network,
      address: result.address,
      ip: req.ip,
      bearer_auth: true
    }));

    const totalMs = Number(process.hrtime.bigint() - requestStarted) / 1e6;
    res.set('Cache-Control', 'private, no-store');
    res.set('Server-Timing', `auth;dur=${authMs.toFixed(1)}, wallet;dur=${walletMs.toFixed(1)}, sync;dur=${syncMs.toFixed(1)}, total;dur=${totalMs.toFixed(1)}`);
    res.set('X-Response-Time', `${totalMs.toFixed(1)}ms`);

    return res.json({
      success: true,
      address: result.address,
      wallet: result.wallet,
      network: result.network,
      exists: result.exists,
      min_deposit: MIN_DEPOSIT,
      timing_ms: Math.round(totalMs)
    });
  } catch (error) {
    console.error('❌ [PUBLIC] Error:', error.message);

    runInBackground('public_deposit_error', () => safeSystemLog('public_deposit_error', `Public deposit error: ${error.message}`, {
      error: error.message,
      ip: req.ip,
      body: req.body || null,
      query: req.query || null
    }));

    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});


// 3. Public/app endpoint: user manually checks only their own deposit address.
// Requires Bearer auth and resolves user only from the token.
app.post('/public/deposit/check', userDepositCheckRequestMiddleware, async (req, res) => {
  try {
    const network = String(readParam(req, 'network', '') || '').trim().toLowerCase();
    const asyncValue = readParam(req, 'async', false);
    const asyncMode = asyncValue === true || String(asyncValue).toLowerCase() === 'true';
    const bearerUser = await getUserFromBearerToken(req);

    console.log('🔎 [PUBLIC] User deposit check request:', {
      resolved_user_id: bearerUser?.id || null,
      network,
      async: asyncMode,
      ip: req.ip,
      timestamp: new Date().toISOString(),
      bearer_auth: !!bearerUser
    });

    if (!bearerUser?.id) {
      return res.status(401).json({ success: false, error: 'Auth required' });
    }

    if (network && !allowedNetworks.includes(network)) {
      return res.status(400).json({ success: false, error: 'Unsupported network' });
    }

    const user_id = bearerUser.id;
    if (req.pixelState?.config?.deposits_enabled === false) {
      return res.status(403).json({ success: false, error: 'DEPOSITS_PAUSED' });
    }

    if (asyncMode) {
      if (!network) {
        return res.status(400).json({ success: false, error: 'Network is required' });
      }
      const { job, reused } = startOrReuseDepositCheckJob(user_id, network);
      runInBackground('public_deposit_check_started', () => safeSystemLog('public_deposit_check_started', `User started deposit check for ${user_id}`, {
        user_id,
        network,
        job_id: job.id,
        reused,
        ip: req.ip
      }));
      return res.status(reused ? 200 : 202).json(publicDepositCheckJob(job, reused));
    }

    const result = await checkUserRequestedNetworks(user_id, network);

    await safeSystemLog('public_deposit_check', `User triggered deposit check for ${user_id}`, {
      user_id,
      network,
      result,
      ip: req.ip
    });

    return res.json({
      success: result.success,
      found: Number(result?.deposits || 0) > 0,
      network: network || 'all',
      checked: result.checked,
      deposits: result.deposits,
      errors: result.failures,
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

// Read-only progress endpoint. The job is visible only to the authenticated
// user who started it; no wallet key or provider detail is returned.
app.post('/public/deposit/check/status', async (req, res) => {
  try {
    const bearerUser = await getUserFromBearerToken(req);
    if (!bearerUser?.id) {
      return res.status(401).json({ success: false, error: 'Auth required' });
    }

    cleanupDepositCheckJobs();
    const jobId = String(readParam(req, 'job_id', '') || '').trim();
    const job = /^[0-9a-f-]{36}$/i.test(jobId) ? depositCheckJobs.get(jobId) : null;
    if (!job || job.userId !== bearerUser.id) {
      return res.status(404).json({ success: false, error: 'DEPOSIT_CHECK_JOB_NOT_FOUND' });
    }

    res.set('Cache-Control', 'private, no-store');
    return res.json(publicDepositCheckJob(job));
  } catch (error) {
    console.error('❌ [PUBLIC] Deposit check status error:', error.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});


// 4. Public/app endpoint: returns only the authenticated user's deposits.
app.get('/public/deposit/history', async (req, res) => {
  try {
    const bearerUser = await getUserFromBearerToken(req);
    if (!bearerUser?.id) {
      return res.status(401).json({ success: false, error: 'Auth required' });
    }

    const network = String(readParam(req, 'network', '') || '').trim().toLowerCase();
    let query = supabase
      .from('deposits')
      .select('id, asset, network, tx_hash, address, amount, status, confirmations, created_at, completed_at')
      .eq('user_id', bearerUser.id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (network) query = query.eq('network', network);

    const { data, error } = await query;
    if (error) throw error;

    return res.json({ success: true, deposits: data || [] });
  } catch (error) {
    console.error('❌ Public deposit history error:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch deposit history' });
  }
});

// 4. Public/admin endpoint: existing all-wallet check with PixelNFT admin unlock.
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

    const isAdmin = profile?.status === 'active' && ['admin', 'owner'].includes(profile?.role);

    if (!isAdmin) {
      console.warn('🚫 [ADMIN] Deposit check blocked for non-admin:', bearerUser.id);
      return res.status(403).json({ success: false, error: 'Admin only' });
    }

    if (!await verifyAdminUnlock(req, bearerUser)) {
      return res.status(403).json({ success: false, error: 'ADMIN_UNLOCK_REQUIRED' });
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

// The existing PixelNFT admin panel calls this path for one selected user.
app.post('/admin/deposit/check', adminDepositCheckCooldownMiddleware, async (req, res) => {
  try {
    const user = await getUserFromBearerToken(req);
    if (!user) return res.status(401).json({ success: false, error: 'Auth required' });
    if (!await verifyAdminUnlock(req, user)) {
      return res.status(403).json({ success: false, error: 'ADMIN_UNLOCK_REQUIRED' });
    }
    const userId = String(readParam(req, 'user_id', ''));
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
      return res.status(400).json({ success: false, error: 'USER_NOT_FOUND' });
    }
    const result = await checkUserRequestedNetworks(userId);
    await safeSystemLog('admin_deposit_check', 'Admin checked selected user deposits', {
      admin_id: user.id, user_id: userId, result
    });
    return res.json({ ...result, user_id: userId, errors: result.failures, found: result.deposits > 0 });
  } catch (error) {
    console.error('❌ [ADMIN] Selected user deposit check error:', error.message);
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
      .from('deposits')
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
  console.log(`✅ PUBLIC Endpoint: POST http://0.0.0.0:${PORT}/public/deposit/check/status`);
  console.log(`✅ ADMIN Endpoint:  POST http://0.0.0.0:${PORT}/public/admin/check-deposits`);
  console.log(`✅ SECURE Endpoint: POST http://0.0.0.0:${PORT}/api/deposit/generate (requires API key)`);
  console.log(`✅ SECURE Endpoint: GET  http://0.0.0.0:${PORT}/api/deposit/history (requires API key)`);
  console.log(`✅ SECURE Endpoint: GET  http://0.0.0.0:${PORT}/api/check-deposits (requires API key)`);
  console.log(`✅ RATE LIMIT: 60 requests per 15 minutes per IP`);
  console.log(`✅ SUPABASE DEPOSIT STORAGE: CONFIGURED (connection verified on first request)`);
  console.log(`✅ ALCHEMY ETH RPC: ${ALCHEMY_ETH_RPC_URL ? 'CONFIGURED' : 'MISSING'}`);
  console.log(`✅ ALCHEMY BSC RPC: ${ALCHEMY_BSC_RPC_URL ? 'CONFIGURED' : 'MISSING'}`);
  console.log(`✅ BEP20 USER HISTORY: ALCHEMY-ONLY, NEWEST-FIRST, UP TO ${ALCHEMY_BSC_INITIAL_LOOKBACK_BLOCKS} BLOCKS`);
  console.log(`✅ DEPOSIT CHECK JOBS: BACKGROUND, ${DEPOSIT_CHECK_JOB_CONCURRENCY} CONCURRENT, SINGLE-FLIGHT PER USER`);
  console.log(`✅ ALCHEMY LOG GATE: ONE REQUEST EVERY ${ALCHEMY_LOG_REQUEST_MIN_INTERVAL_MS} ms, AUTOMATIC 429 PAUSE`);
  console.log(`✅ BEP20 (USDT & USDC): Checking every ${BEP20_CHECK_INTERVAL} ms`);
  console.log(`✅ ERC20 (USDT & USDC): Checking every ${ERC20_CHECK_INTERVAL} ms`);
  console.log(`✅ TRC20 (USDT): Checking every ${TRC20_CHECK_INTERVAL} ms`);
  console.log(`✅ MINIMUM DEPOSIT: $${MIN_DEPOSIT}`);
  console.log(`✅ PRIVATE KEY ENCRYPTION: ${ENCRYPTION_KEY ? 'AES-256-GCM ENABLED' : 'DISABLED'}`);
  console.log(`✅ ATOMIC DEPOSITS: ENABLED`);
  console.log(`✅ AUTO-SWEEP BEP20: ${HOT_WALLET_PRIVATE_KEY && ADMIN_SWEEP_ADDRESS ? 'ENABLED' : 'DISABLED'}`);
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
