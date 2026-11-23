#!/usr/bin/env node
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const { Wallet, getAddress } = require('ethers');
const TronWeb = require('tronweb');
const WebSocket = require('ws'); // ИСПРАВЛЕНИЕ: Добавлен пакет ws

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fctwivbwjoslkejtjxhe.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

const ALLOWED_NETWORKS = new Set([
  'usdt_bep20',
  'usdc_bep20',
  'usdt_erc20',
  'usdc_erc20',
  'trx',
  'usdt_trc20',
  'trc_20',
]);
function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function maskPrivateKey(key) {
  if (!key || key.length < 16) return key || '';
  return `${key.slice(0, 8)}...${key.slice(-8)}`;
}

function decryptPrivateKey(serverCipher) {
  if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length < 32) {
    throw new Error('Missing or invalid ENCRYPTION_KEY');
  }

  const parts = typeof serverCipher === 'string' ? serverCipher.split(':') : [];
  const modern = parts.length === 4 && parts[0] === 'v1';
  if (!modern && parts.length !== 3) {
    throw new Error('Invalid server_cipher envelope');
  }

  const [ivHex, cipherHex, tagHex] = modern
    ? [parts[1], parts[3], parts[2]]
    : parts;
  const ivPattern = modern ? /^[a-f0-9]{24}$/ : /^[a-f0-9]{32}$/;
  if (!ivPattern.test(ivHex) || !/^[a-f0-9]{32}$/.test(tagHex) ||
      !/^(?:[a-f0-9]{2})+$/.test(cipherHex)) {
    throw new Error('Invalid server_cipher envelope');
  }

  const aesKey = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const privateKey = decipher.update(cipherHex, 'hex', 'utf8') + decipher.final('utf8');
  if (!/^(?:0x)?[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error('Invalid decrypted private key');
  }
  return privateKey;
}

function verifyWalletAddress(privateKey, address, isTron) {
  const hexKey = privateKey.replace(/^0x/, '');
  if (isTron) {
    const derived = TronWeb.address.fromPrivateKey(hexKey);
    if (!derived || !TronWeb.isAddress(address) ||
        TronWeb.address.toHex(derived).toLowerCase() !== TronWeb.address.toHex(address).toLowerCase()) {
      throw new Error('Private key does not match the registered TRON address');
    }
    return;
  }

  let derived;
  try {
    derived = new Wallet('0x' + hexKey).address;
  } catch {
    throw new Error('Invalid EVM private key');
  }

  if (derived !== getAddress(address.toLowerCase())) {
    throw new Error('Private key does not match the registered EVM address');
  }
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {
    userId: '',
    network: '',
    json: false,
    masked: false,
  };

  for (const arg of args) {
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--masked') {
      options.masked = true;
      continue;
    }
    if (!options.userId) {
      options.userId = arg;
      continue;
    }
    if (!options.network) {
      options.network = arg;
      continue;
    }
  }

  return options;
}

function printUsage() {
  console.log(`Usage:
  node export-wallet.js <user_id> <network> [--json] [--masked]

Examples:
  node export-wallet.js 483251ac-6d97-40c2-ad11-6c74b01ba7af usdc_bep20
  node export-wallet.js 483251ac-6d97-40c2-ad11-6c74b01ba7af usdt_bep20 --json
  node export-wallet.js 483251ac-6d97-40c2-ad11-6c74b01ba7af usdc_bep20 --masked

Notes:
  --json    Print machine-readable JSON
  --masked  Mask private_key output for safer viewing
  For opBNB, use usdt_bep20 only when its registered address matches your opBNB wallet.
`);
}

async function main() {
  const { userId, network, json, masked } = parseArgs(process.argv);

  if (!userId || !network) {
    printUsage();
    process.exit(1);
  }

  if (!SUPABASE_SERVICE_ROLE_KEY) {
    fail('Missing SUPABASE_SERVICE_ROLE_KEY');
  }

  if (!ALLOWED_NETWORKS.has(network)) {
    fail(`Unsupported network: ${network}`);
  }

  // ИСПРАВЛЕНИЕ: Добавлен транспорт realtime
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    realtime: {
      transport: WebSocket
    }
  });

  const isTron = ['trx', 'usdt_trc20', 'trc_20'].includes(network);
  const lookupNetwork = isTron ? 'usdt_trc20' : network;
  const { data, error } = await supabase.rpc('deposit_key_envelope', {
    p_user_id: userId,
    p_network: lookupNetwork,
  });

  if (error) {
    fail(`Supabase error: ${error.message}`);
  }

  if (!data || typeof data.address !== 'string' || typeof data.server_cipher !== 'string') {
    fail('Wallet or encrypted key not found');
  }

  const privateKey = decryptPrivateKey(data.server_cipher);
  verifyWalletAddress(privateKey, data.address, isTron);
  const output = {
    user_id: userId,
    network,
    address: data.address,
    private_key: masked ? maskPrivateKey(privateKey) : privateKey,
    created_at: data.created_at ?? null,
  };

  if (json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log('Wallet export successful');
  console.log('------------------------');
  console.log(`User ID:     ${output.user_id}`);
  console.log(`Network:     ${output.network}`);
  console.log(`Address:     ${output.address}`);
  console.log(`Private Key: ${output.private_key}`);
  console.log(`Created At:  ${output.created_at || 'n/a'}`);
}

main().catch((err) => {
  fail(`Export failed: ${err.message}`);
});
