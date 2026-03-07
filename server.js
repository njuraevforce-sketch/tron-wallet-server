// server.js — Oracle Deposit System (BEP20 + ERC20 USDT/USDC)
// Built from the user's original full server flow.
// Changes vs original:
// - TRC20 removed
// - ERC20 added
// - Existing endpoint structure preserved
// - Existing wallet generation + background check flow preserved
// - Compatible with Supabase RPC public.create_deposit_with_balance

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const ethers = require('ethers');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 8080);

// ========== CONFIGURATION ==========
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fkjwueogfmdolcjtvvme.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MORALIS_API_KEY = process.env.MORALIS_API_KEY || '';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const API_SECRET_KEY = process.env.API_SECRET_KEY;

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

// ========== INITIALIZE SERVICES ==========
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
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

// ========== CONSTANTS ==========
const MIN_DEPOSIT = 20;

// BSC
const USDT_BSC_CONTRACT = '0x55d398326f99059fF775485246999027B3197955';
const USDC_BSC_CONTRACT = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d';

// Ethereum
const USDT_ETH_CONTRACT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const USDC_ETH_CONTRACT = '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

const networkFields = {
  usdt_bep20: {
    addressField: 'usdt_bep20_address',
    privateKeyField: 'usdt_bep20_private_key',
    contractAddress: USDT_BSC_CONTRACT,
    token: 'USDT',
    chain: 'bsc'
  },
  usdc_bep20: {
    addressField: 'usdc_bep20_address',
    privateKeyField: 'usdc_bep20_private_key',
    contractAddress: USDC_BSC_CONTRACT,
    token: 'USDC',
    chain: 'bsc'
  },
  usdt_erc20: {
    addressField: 'usdt_erc20_address',
    privateKeyField: 'usdt_erc20_private_key',
    contractAddress: USDT_ETH_CONTRACT,
    token: 'USDT',
    chain: 'eth'
  },
  usdc_erc20: {
    addressField: 'usdc_erc20_address',
    privateKeyField: 'usdc_erc20_private_key',
    contractAddress: USDC_ETH_CONTRACT,
    token: 'USDC',
    chain: 'eth'
  }
};

const allowedNetworks = Object.keys(networkFields);

// ========== CHECK SETTINGS ==========
const BEP20_CHECK_INTERVAL = Number(process.env.BEP20_CHECK_INTERVAL || 120000);
const ERC20_CHECK_INTERVAL = Number(process.env.ERC20_CHECK_INTERVAL || 150000);
const API_DELAY_MS = Number(process.env.API_DELAY_MS || 400);

// ========== HELPERS ==========
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      // Ignore if table is absent in current schema.
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

    const { addressField } = fields;

    // Check existing wallet row
    const { data: existingWallet, error: walletError } = await supabase
      .from('user_wallets')
      .select('*')
      .eq('user_id', user_id)
      .maybeSingle();

    if (walletError) {
      console.error('❌ Wallet lookup error:', walletError.message);
      throw walletError;
    }

    if (existingWallet && existingWallet[addressField]) {
      console.log(`✅ Wallet already exists: ${existingWallet[addressField]}`);

      return {
        success: true,
        address: existingWallet[addressField],
        exists: true,
        network
      };
    }

    const wallet = await generateEVMWallet();
    const address = wallet.address;
    const privateKey = wallet.privateKey;
    const encryptedPrivateKey = encryptPrivateKey(privateKey);

    console.log(`✅ Generated ${network} wallet: ${address}`);

    const walletData = {
      [addressField]: address,
      updated_at: new Date().toISOString()
    };

    if (existingWallet) {
      const { error } = await supabase
        .from('user_wallets')
        .update(walletData)
        .eq('user_id', user_id);

      if (error) {
        console.error('❌ Database update error:', error.message);
        throw new Error('Failed to update wallet');
      }
    } else {
      const insertPayload = {
        user_id,
        default_network: network,
        created_at: new Date().toISOString(),
        ...walletData
      };

      const { error } = await supabase.from('user_wallets').insert(insertPayload);
      if (error) {
        console.error('❌ Database insert error:', error.message);
        throw new Error('Failed to save wallet');
      }
    }

    const { error: pkError } = await supabase
      .from('private_keys')
      .upsert(
        {
          user_id,
          network,
          address,
          encrypted_private_key: encryptedPrivateKey,
          updated_at: new Date().toISOString()
        },
        { onConflict: 'user_id,network' }
      );

    if (pkError) {
      console.error('❌ Error saving encrypted private key:', pkError.message);
      throw new Error('Failed to save private key');
    }

    await safeSystemLog('deposit_wallet_generated', `Wallet generated for user ${user_id}`, {
      user_id,
      network,
      address
    });

    // Trigger user-specific quick re-check after generation
    setTimeout(() => {
      if (network.endsWith('_bep20')) {
        checkUserBEP20Deposits(user_id).catch((err) => {
          console.error('❌ Deferred BEP20 check error:', err.message);
        });
      } else if (network.endsWith('_erc20')) {
        checkUserERC20Deposits(user_id).catch((err) => {
          console.error('❌ Deferred ERC20 check error:', err.message);
        });
      }
    }, 10000);

    return {
      success: true,
      address,
      exists: false,
      network
    };
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
async function getChainTokenTransfers(address, chain) {
  try {
    if (!address) return [];

    const tokenAddresses = chain === 'bsc'
      ? [USDT_BSC_CONTRACT, USDC_BSC_CONTRACT]
      : [USDT_ETH_CONTRACT, USDC_ETH_CONTRACT];

    const url = `https://deep-index.moralis.io/api/v2/${address}/erc20/transfers?chain=${chain}&token_addresses=${tokenAddresses.join(',')}&limit=20`;

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

    for (const tx of data.result || []) {
      try {
        const toAddress = String(tx.to_address || '').toLowerCase();
        if (toAddress !== String(address).toLowerCase()) continue;

        const tokenSymbol = String(tx.token_symbol || '').toUpperCase();
        if (tokenSymbol !== 'USDT' && tokenSymbol !== 'USDC') continue;

        const decimals = Number(tx.decimals || 18);
        const amount = Number(tx.value) / Math.pow(10, decimals);
        if (!Number.isFinite(amount) || amount < MIN_DEPOSIT) continue;

        const network = chain === 'bsc'
          ? (tokenSymbol === 'USDT' ? 'usdt_bep20' : 'usdc_bep20')
          : (tokenSymbol === 'USDT' ? 'usdt_erc20' : 'usdc_erc20');

        transactions.push({
          transaction_id: tx.transaction_hash,
          to: toAddress,
          from: String(tx.from_address || '').toLowerCase(),
          amount,
          token: tokenSymbol,
          confirmed: true,
          network,
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
    console.error(`❌ ${chain.toUpperCase()} transfer fetch error:`, error.message);
    return [];
  }
}

async function getBEP20Transactions(address) {
  return getChainTokenTransfers(address, 'bsc');
}

async function getERC20Transactions(address) {
  return getChainTokenTransfers(address, 'eth');
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

async function checkUserBEP20Deposits(userId) {
  try {
    const { data: wallet, error } = await supabase
      .from('user_wallets')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw error;
    if (!wallet) return;

    const addresses = Array.from(
      new Set([wallet.usdt_bep20_address, wallet.usdc_bep20_address].filter(Boolean))
    );

    for (const address of addresses) {
      const transactions = await getBEP20Transactions(address);
      for (const tx of transactions) {
        try {
          await processDeposit(userId, tx.amount, tx.transaction_id, tx.network);
        } catch (err) {
          console.error(`❌ Error processing transaction ${tx.transaction_id}:`, err.message);
        }
      }
    }
  } catch (error) {
    console.error('❌ checkUserBEP20Deposits error:', error.message);
  }
}

async function checkUserERC20Deposits(userId) {
  try {
    const { data: wallet, error } = await supabase
      .from('user_wallets')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw error;
    if (!wallet) return;

    const addresses = Array.from(
      new Set([wallet.usdt_erc20_address, wallet.usdc_erc20_address].filter(Boolean))
    );

    for (const address of addresses) {
      const transactions = await getERC20Transactions(address);
      for (const tx of transactions) {
        try {
          await processDeposit(userId, tx.amount, tx.transaction_id, tx.network);
        } catch (err) {
          console.error(`❌ Error processing transaction ${tx.transaction_id}:`, err.message);
        }
      }
    }
  } catch (error) {
    console.error('❌ checkUserERC20Deposits error:', error.message);
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

    const { data: user, error: userError } = await supabase
      .from('profiles')
      .select('user_id')
      .eq('user_id', user_id)
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

    return res.json({
      success: true,
      bep20: bep20Result,
      erc20: erc20Result
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
  console.log(`✅ SECURE Endpoint: POST http://0.0.0.0:${PORT}/api/deposit/generate (requires API key)`);
  console.log(`✅ SECURE Endpoint: GET  http://0.0.0.0:${PORT}/api/deposit/history (requires API key)`);
  console.log(`✅ SECURE Endpoint: GET  http://0.0.0.0:${PORT}/api/check-deposits (requires API key)`);
  console.log(`✅ RATE LIMIT: 60 requests per 15 minutes per IP`);
  console.log(`✅ SUPABASE: CONNECTED`);
  console.log(`✅ MORALIS: ${MORALIS_API_KEY ? 'API KEY SET' : 'API KEY MISSING'}`);
  console.log(`✅ BEP20 (USDT & USDC): Checking every ${BEP20_CHECK_INTERVAL} ms`);
  console.log(`✅ ERC20 (USDT & USDC): Checking every ${ERC20_CHECK_INTERVAL} ms`);
  console.log(`✅ MINIMUM DEPOSIT: $${MIN_DEPOSIT}`);
  console.log(`✅ PRIVATE KEY ENCRYPTION: ${ENCRYPTION_KEY ? 'AES-256-GCM ENABLED' : 'DISABLED'}`);
  console.log(`✅ ATOMIC DEPOSITS: ENABLED`);
  console.log(`✅ SECURITY: Public endpoints DO NOT return private keys`);
  console.log('===================================');
});

// ========== BACKGROUND TASKS ==========
let isCheckingBEP20 = false;
let isCheckingERC20 = false;

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
