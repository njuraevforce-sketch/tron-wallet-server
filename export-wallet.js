#!/usr/bin/env node
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fkjwueogfmdolcjtvvme.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

const ALLOWED_NETWORKS = new Set([
  'usdt_bep20',
  'usdc_bep20',
  'usdt_erc20',
  'usdc_erc20',
  'trx',
  'trc20',
]);

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function maskPrivateKey(key) {
  if (!key || key.length < 16) return key || '';
  return `${key.slice(0, 8)}...${key.slice(-8)}`;
}

function decryptPrivateKey(encryptedText) {
  if (!encryptedText) {
    throw new Error('Empty encrypted_private_key');
  }

  if (!ENCRYPTION_KEY || String(ENCRYPTION_KEY).length < 32) {
    throw new Error('Missing or invalid ENCRYPTION_KEY');
  }

  // Backward compatibility: some old rows may still contain plain text.
  if (!encryptedText.includes(':')) {
    return encryptedText;
  }

  const [ivHex, encryptedHex, authTagHex] = encryptedText.split(':');
  if (!ivHex || !encryptedHex || !authTagHex) {
    throw new Error('Invalid encrypted_private_key format');
  }

  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const key = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
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

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  const { data, error } = await supabase
    .from('private_keys')
    .select('user_id, network, address, encrypted_private_key, created_at')
    .eq('user_id', userId)
    .eq('network', network)
    .maybeSingle();

  if (error) {
    fail(`Supabase error: ${error.message}`);
  }

  if (!data) {
    fail('Wallet not found');
  }

  const privateKey = decryptPrivateKey(data.encrypted_private_key);
  const output = {
    user_id: data.user_id,
    network: data.network,
    address: data.address,
    private_key: masked ? maskPrivateKey(privateKey) : privateKey,
    created_at: data.created_at,
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
