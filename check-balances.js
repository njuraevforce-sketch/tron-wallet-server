#!/usr/bin/env node
const { createClient } = require('@supabase/supabase-js');
const { ethers } = require('ethers');
const WebSocket = require('ws');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fkjwueogfmdolcjtvvme.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TRONGRID_API_KEY = process.env.TRONGRID_API_KEY || '';

const BSC_RPCS = [
  'https://bsc-dataseed.binance.org/',
  'https://binance.llamarpc.com',
  'https://bsc-rpc.publicnode.com'
];

const ETH_RPCS = [
  'https://ethereum-rpc.publicnode.com',
  'https://rpc.ankr.com/eth',
  'https://eth.llamarpc.com'
];

const TRON_RPCS = [
  'https://api.trongrid.io'
];

const TRONSCAN_API = 'https://apilist.tronscanapi.com';

const USDT_BSC = '0x55d398326f99059fF775485246999027B3197955';
const USDC_BSC = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d';
const USDT_ETH = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const USDC_ETH = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

// TRON USDT / Tether USD contract.
const USDT_TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const USDT_TRON_HEX = '41a614f803b6fd780986a42c78ec9c7f77e6ded13c';

const ERC20_ABI = ['function balanceOf(address owner) view returns (uint256)'];
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    hideEmpty: args.includes('--hide-empty'),
    debug: args.includes('--debug')
  };
}

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function formatAmount(value, decimals = 2) {
  const n = asNumber(value, 0);
  return n.toFixed(decimals);
}

function normalizeAddress(value) {
  return String(value || '').trim();
}

function normalizeHex(value) {
  return String(value || '').trim().replace(/^0x/i, '').toLowerCase();
}

function tokenAmount(rawValue, decimals) {
  if (rawValue === null || rawValue === undefined || rawValue === '') return 0;
  const n = Number(rawValue);
  if (!Number.isFinite(n)) return 0;
  return n / Math.pow(10, Number(decimals || 6));
}

function isTronAddress(value) {
  return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(normalizeAddress(value));
}

function isUsdtTronKey(key) {
  const normalized = normalizeAddress(key);
  const hex = normalizeHex(key);

  return (
    normalized === USDT_TRON ||
    hex === normalizeHex(USDT_TRON_HEX) ||
    hex.endsWith(normalizeHex(USDT_TRON_HEX).slice(-40))
  );
}

function tronHeaders() {
  const headers = { Accept: 'application/json' };

  if (TRONGRID_API_KEY) {
    headers['TRON-PRO-API-KEY'] = TRONGRID_API_KEY;
  }

  return headers;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);

  // TRON account can return 404 when the address has no activity yet.
  if (response.status === 404) {
    return { success: true, data: [] };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
  }

  return await response.json();
}

async function fetchEVM(rpcs, chainId, address, usdtAddr, usdcAddr) {
  let lastErr;

  for (const rpc of rpcs) {
    try {
      const provider = new ethers.JsonRpcProvider(rpc, chainId, { staticNetwork: true });
      const [coinWei, usdtWei, usdcWei] = await Promise.all([
        provider.getBalance(address),
        new ethers.Contract(usdtAddr, ERC20_ABI, provider).balanceOf(address),
        new ethers.Contract(usdcAddr, ERC20_ABI, provider).balanceOf(address)
      ]);

      return { coinWei, usdtWei, usdcWei, source: rpc };
    } catch (err) {
      lastErr = err;
      await sleep(200);
    }
  }

  throw lastErr;
}

function parseTronGridAccount(data) {
  let trx = 0;
  let usdt = 0;

  if (!data?.success || !Array.isArray(data.data) || data.data.length === 0) {
    return { trx, usdt };
  }

  const acc = data.data[0] || {};
  trx = tokenAmount(acc.balance || 0, 6);

  const trc20 = acc.trc20;

  if (Array.isArray(trc20)) {
    for (const token of trc20) {
      if (!token || typeof token !== 'object') continue;

      for (const [key, value] of Object.entries(token)) {
        if (isUsdtTronKey(key)) {
          usdt += tokenAmount(value, 6);
        }
      }
    }
  } else if (trc20 && typeof trc20 === 'object') {
    for (const [key, value] of Object.entries(trc20)) {
      if (isUsdtTronKey(key)) {
        usdt += tokenAmount(value, 6);
      }
    }
  }

  return { trx, usdt };
}

function parseTronScanAccountV2(data) {
  let trx = 0;
  let usdt = 0;

  if (!data || typeof data !== 'object') {
    return { trx, usdt };
  }

  trx = tokenAmount(data.balance || 0, 6);

  const possibleTokenArrays = [
    data.trc20token_balances,
    data.trc20tokens,
    data.tokens
  ].filter(Array.isArray);

  for (const arr of possibleTokenArrays) {
    for (const token of arr) {
      if (!token || typeof token !== 'object') continue;

      const tokenId = normalizeAddress(token.tokenId || token.contract_address || token.contractAddress || token.address);
      const symbol = String(token.tokenAbbr || token.tokenSymbol || token.symbol || token.name || '').toUpperCase();
      const decimals = Number(token.tokenDecimal ?? token.decimals ?? 6);
      const rawBalance = token.balance ?? token.amount ?? token.quantity ?? token.value ?? 0;

      if (isUsdtTronKey(tokenId) || symbol === 'USDT') {
        usdt += tokenAmount(rawBalance, decimals);
      }
    }
  }

  return { trx, usdt };
}

function parseTronScanTokens(data) {
  let trx = 0;
  let usdt = 0;
  const tokens = Array.isArray(data?.data) ? data.data : [];

  for (const token of tokens) {
    if (!token || typeof token !== 'object') continue;

    const tokenId = normalizeAddress(token.tokenId || token.contract_address || token.contractAddress || token.address);
    const symbol = String(token.tokenAbbr || token.tokenSymbol || token.symbol || token.name || '').toUpperCase();
    const decimals = Number(token.tokenDecimal ?? token.decimals ?? 6);
    const rawBalance = token.balance ?? token.amount ?? token.quantity ?? token.value ?? 0;

    if (symbol === 'TRX' || tokenId === '_' || token.type === 'trc10') {
      trx = Math.max(trx, tokenAmount(rawBalance, decimals));
    }

    if (isUsdtTronKey(tokenId) || symbol === 'USDT') {
      usdt += tokenAmount(rawBalance, decimals);
    }
  }

  return { trx, usdt };
}

async function fetchTronGridBalance(address) {
  let lastErr;

  for (const rpc of TRON_RPCS) {
    try {
      const url = `${rpc}/v1/accounts/${encodeURIComponent(address)}`;
      const data = await fetchJson(url, { headers: tronHeaders() });
      const parsed = parseTronGridAccount(data);
      return { ...parsed, source: 'trongrid_account' };
    } catch (err) {
      lastErr = err;
      await sleep(250);
    }
  }

  throw lastErr;
}

async function fetchTronScanAccountV2Balance(address) {
  const url = `${TRONSCAN_API}/api/accountv2?address=${encodeURIComponent(address)}`;
  const data = await fetchJson(url, { headers: { Accept: 'application/json' } });
  const parsed = parseTronScanAccountV2(data);
  return { ...parsed, source: 'tronscan_accountv2' };
}

async function fetchTronScanTokensBalance(address) {
  const params = new URLSearchParams({
    address,
    start: '0',
    limit: '200',
    hidden: '0',
    show: '0',
    sortType: '0'
  });

  const url = `${TRONSCAN_API}/api/account/tokens?${params.toString()}`;
  const data = await fetchJson(url, { headers: { Accept: 'application/json' } });
  const parsed = parseTronScanTokens(data);
  return { ...parsed, source: 'tronscan_tokens' };
}

async function fetchTron(address) {
  const attempts = [];
  const errors = [];

  const sources = [
    fetchTronGridBalance,
    fetchTronScanAccountV2Balance,
    fetchTronScanTokensBalance
  ];

  for (const fn of sources) {
    try {
      const result = await fn(address);
      attempts.push(result);
      await sleep(150);
    } catch (err) {
      errors.push(`${fn.name}: ${err.message}`);
      await sleep(250);
    }
  }

  if (attempts.length === 0) {
    throw new Error(errors.join(' | ') || 'All TRON balance sources failed');
  }

  return {
    trx: Math.max(...attempts.map(x => asNumber(x.trx, 0))),
    usdt: Math.max(...attempts.map(x => asNumber(x.usdt, 0))),
    sources: attempts.map(x => `${x.source}:TRX=${formatAmount(x.trx, 6)},USDT=${formatAmount(x.usdt, 6)}`),
    errors
  };
}

function addEvmAddress(map, address, userId) {
  const addr = normalizeAddress(address);
  if (!addr) return;
  if (!ethers.isAddress(addr)) return;
  map.set(ethers.getAddress(addr), userId);
}

function addTronAddress(map, address, userId) {
  const addr = normalizeAddress(address);
  if (!addr) return;
  if (!isTronAddress(addr)) return;
  map.set(addr, userId);
}

async function loadWalletsFromDatabase(supabase) {
  console.log('Loading wallets from DB...');

  const { data: wallets, error } = await supabase.from('user_wallets').select('*');

  if (error) {
    throw new Error(`DB Error user_wallets: ${error.message}`);
  }

  const evmWallets = new Map();
  const tronWallets = new Map();

  for (const w of wallets || []) {
    addEvmAddress(evmWallets, w.usdt_bep20_address, w.user_id);
    addEvmAddress(evmWallets, w.usdc_bep20_address, w.user_id);
    addEvmAddress(evmWallets, w.usdt_erc20_address, w.user_id);
    addEvmAddress(evmWallets, w.usdc_erc20_address, w.user_id);
    addTronAddress(tronWallets, w.usdt_trc20_address, w.user_id);
  }

  // Extra fallback for old rows or rows where user_wallets.usdt_trc20_address is missing,
  // but private_keys still contains a TRON address.
  const { data: privateKeys, error: pkError } = await supabase
    .from('private_keys')
    .select('user_id, network, address')
    .in('network', ['usdt_trc20', 'trx', 'trc_20', 'trc20', 'tron'])
    .not('address', 'is', null);

  if (pkError) {
    console.error(`WARNING: private_keys fallback skipped: ${pkError.message}`);
  } else {
    for (const k of privateKeys || []) {
      addTronAddress(tronWallets, k.address, k.user_id);
    }
  }

  return { evmWallets, tronWallets };
}

async function main() {
  const { hideEmpty, debug } = parseArgs();

  if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.error('ERROR: Missing SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  if (!TRONGRID_API_KEY) {
    console.log('WARNING: TRONGRID_API_KEY is empty. TRON checks may be rate-limited.');
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: WebSocket }
  });

  let evmWallets;
  let tronWallets;

  try {
    const loaded = await loadWalletsFromDatabase(supabase);
    evmWallets = loaded.evmWallets;
    tronWallets = loaded.tronWallets;
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  console.log(`Found EVM addresses: ${evmWallets.size}`);
  console.log(`Found TRON addresses: ${tronWallets.size}`);
  console.log('--------------------------------------------------');

  let totalStuck = 0;

  console.log('\n--- BSC (BEP20) ---');
  for (const [address, userId] of evmWallets.entries()) {
    try {
      const { coinWei, usdtWei, usdcWei } = await fetchEVM(BSC_RPCS, 56, address, USDT_BSC, USDC_BSC);
      const bnb = Number(ethers.formatEther(coinWei));
      const usdt = Number(ethers.formatUnits(usdtWei, 18));
      const usdc = Number(ethers.formatUnits(usdcWei, 18));
      const hasFunds = bnb > 0.0005 || usdt > 0.5 || usdc > 0.5;

      if (!hideEmpty || hasFunds) {
        console.log(`ID: ${userId} | Addr: ${address} | BNB: ${formatAmount(bnb, 4)} | USDT: ${formatAmount(usdt)} | USDC: ${formatAmount(usdc)}`);
        if (usdt > 0 || usdc > 0) totalStuck += (usdt + usdc);
      }

      await sleep(100);
    } catch (err) {
      console.log(`Err BSC ${address}: ${err.message}`);
    }
  }

  console.log('\n--- ETHEREUM (ERC20) ---');
  for (const [address, userId] of evmWallets.entries()) {
    try {
      const { coinWei, usdtWei, usdcWei } = await fetchEVM(ETH_RPCS, 1, address, USDT_ETH, USDC_ETH);
      const eth = Number(ethers.formatEther(coinWei));
      const usdt = Number(ethers.formatUnits(usdtWei, 6));
      const usdc = Number(ethers.formatUnits(usdcWei, 6));
      const hasFunds = eth > 0.0005 || usdt > 0.5 || usdc > 0.5;

      if (!hideEmpty || hasFunds) {
        console.log(`ID: ${userId} | Addr: ${address} | ETH: ${formatAmount(eth, 4)} | USDT: ${formatAmount(usdt)} | USDC: ${formatAmount(usdc)}`);
        if (usdt > 0 || usdc > 0) totalStuck += (usdt + usdc);
      }

      await sleep(100);
    } catch (err) {
      console.log(`Err ETH ${address}: ${err.message}`);
    }
  }

  console.log('\n--- TRON (TRC20) ---');
  for (const [address, userId] of tronWallets.entries()) {
    try {
      const { trx, usdt, sources, errors } = await fetchTron(address);
      const hasFunds = trx > 1 || usdt > 0.5;

      if (!hideEmpty || hasFunds) {
        console.log(`ID: ${userId} | Addr: ${address} | TRX: ${formatAmount(trx)} | USDT: ${formatAmount(usdt)}`);

        if (debug) {
          console.log(`  sources: ${sources.join(' | ')}`);
          if (errors.length) console.log(`  warnings: ${errors.join(' | ')}`);
        }

        if (usdt > 0) totalStuck += usdt;
      } else if (debug) {
        console.log(`EMPTY TRON | ID: ${userId} | Addr: ${address}`);
        console.log(`  sources: ${sources.join(' | ')}`);
        if (errors.length) console.log(`  warnings: ${errors.join(' | ')}`);
      }

      await sleep(300);
    } catch (err) {
      console.log(`Err TRON ${address}: ${err.message}`);
    }
  }

  console.log('\n==================================================');
  console.log(`TOTAL STUCK: ~$${formatAmount(totalStuck)}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
