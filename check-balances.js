#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { ethers } = require('ethers');
const WebSocket = require('ws');

const SUPABASE_URL =
  process.env.SUPABASE_URL || 'https://fkjwueogfmdolcjtvvme.supabase.co';
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

const OPBNB_RPCS = [
  'https://opbnb-mainnet-rpc.bnbchain.org',
  'https://opbnb.publicnode.com'
];

const TRON_RPCS = [
  'https://api.trongrid.io'
];

const USDT_BSC = '0x55d398326f99059fF775485246999027B3197955';
const USDC_BSC = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d';

const USDT_ETH = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const USDC_ETH = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

const USDT_OPBNB = '0x9e5aac1ba1a2e6aed6b32689dfcf62a509ca96f3';

// Official USDT contract on TRON mainnet.
const USDT_TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const TRON_BASE58 =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const ERC20_ABI = ['function balanceOf(address owner) view returns (uint256)'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function tokenAmount(rawValue, decimals) {
  if (rawValue === null || rawValue === undefined || rawValue === '') return 0;

  try {
    return Number(
      ethers.formatUnits(BigInt(String(rawValue)), Number(decimals || 6))
    );
  } catch {
    return 0;
  }
}

function isTronAddress(value) {
  return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(normalizeAddress(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest();
}

/**
 * Decode a Base58Check TRON address and return its 21-byte hex payload.
 * The payload includes the TRON mainnet prefix byte 0x41.
 */
function tronAddressToHex(address) {
  const normalized = normalizeAddress(address);

  if (!isTronAddress(normalized)) {
    throw new Error(`Invalid TRON address format: ${normalized}`);
  }

  let value = 0n;

  for (const char of normalized) {
    const index = TRON_BASE58.indexOf(char);

    if (index === -1) {
      throw new Error(`Invalid TRON Base58 character in address: ${normalized}`);
    }

    value = value * 58n + BigInt(index);
  }

  // A TRON Base58Check address is 21 payload bytes plus a 4-byte checksum.
  const rawHex = value.toString(16).padStart(50, '0');

  if (rawHex.length !== 50) {
    throw new Error(`Invalid TRON address length: ${normalized}`);
  }

  const raw = Buffer.from(rawHex, 'hex');
  const payload = raw.subarray(0, 21);
  const checksum = raw.subarray(21, 25);
  const expectedChecksum = sha256(sha256(payload)).subarray(0, 4);

  if (!checksum.equals(expectedChecksum)) {
    throw new Error(`Invalid TRON address checksum: ${normalized}`);
  }

  if (payload[0] !== 0x41) {
    throw new Error(`Address is not a TRON mainnet address: ${normalized}`);
  }

  return payload.toString('hex');
}

function tronHeaders(extraHeaders = {}) {
  const headers = {
    Accept: 'application/json',
    ...extraHeaders
  };

  if (TRONGRID_API_KEY) {
    headers['TRON-PRO-API-KEY'] = TRONGRID_API_KEY;
  }

  return headers;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const method = String(options.method || 'GET').toUpperCase();

  // TronGrid can return 404 for an account that has no activity yet.
  // Only treat a GET account lookup this way; never hide POST/API failures.
  if (response.status === 404 && method === 'GET') {
    return { success: true, data: [] };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`
    );
  }

  return await response.json();
}

async function fetchEVM(rpcs, chainId, address, usdtAddr, usdcAddr) {
  let lastErr;

  for (const rpc of rpcs) {
    try {
      const provider = new ethers.JsonRpcProvider(rpc, chainId, {
        staticNetwork: true
      });

      const [coinWei, usdtWei, usdcWei] = await Promise.all([
        provider.getBalance(address),
        new ethers.Contract(usdtAddr, ERC20_ABI, provider).balanceOf(address),
        usdcAddr
          ? new ethers.Contract(usdcAddr, ERC20_ABI, provider).balanceOf(address)
          : Promise.resolve(0n)
      ]);

      return {
        coinWei,
        usdtWei,
        usdcWei,
        source: rpc
      };
    } catch (err) {
      lastErr = err;
      await sleep(200);
    }
  }

  throw lastErr || new Error(`No EVM RPC available for chain ${chainId}`);
}

async function selectEvmProvider(rpcs, chainId, requiredContracts = []) {
  const errors = [];

  for (const rpc of rpcs) {
    try {
      const provider = new ethers.JsonRpcProvider(rpc, chainId, {
        staticNetwork: true
      });

      const reportedChainId = BigInt(
        await provider.send('eth_chainId', [])
      );

      if (reportedChainId !== BigInt(chainId)) {
        throw new Error(
          `wrong chain ID ${reportedChainId}; expected ${chainId}`
        );
      }

      const contractCodes = await Promise.all(
        requiredContracts.map((contractAddress) =>
          provider.getCode(contractAddress)
        )
      );

      for (let index = 0; index < contractCodes.length; index += 1) {
        if (!contractCodes[index] || contractCodes[index] === '0x') {
          throw new Error(
            `no contract code at ${requiredContracts[index]}`
          );
        }
      }

      // Confirm that the RPC can execute ERC20 read calls, not only return
      // contract bytecode. Some public endpoints return an empty "0x" result
      // for eth_call even though eth_getCode succeeds.
      await Promise.all(
        requiredContracts.map((contractAddress) =>
          new ethers.Contract(
            contractAddress,
            ERC20_ABI,
            provider
          ).balanceOf(ethers.ZeroAddress)
        )
      );

      return {
        provider,
        source: rpc
      };
    } catch (err) {
      errors.push(`${rpc}: ${err.shortMessage || err.message}`);
      await sleep(200);
    }
  }

  throw new Error(errors.join(' | ') || `No RPC available for chain ${chainId}`);
}

/**
 * Read USDT directly from the TRC20 contract with balanceOf(address).
 * This avoids depending on the optional/variable trc20 field returned by the
 * general TronGrid account endpoint.
 */
async function fetchTronUsdtBalance(rpc, address) {
  const addressHex = tronAddressToHex(address);
  const parameter = addressHex.padStart(64, '0');

  const data = await fetchJson(`${rpc}/wallet/triggerconstantcontract`, {
    method: 'POST',
    headers: tronHeaders({
      'Content-Type': 'application/json'
    }),
    body: JSON.stringify({
      contract_address: USDT_TRON,
      function_selector: 'balanceOf(address)',
      parameter,
      owner_address: address,
      visible: true
    })
  });

  if (data?.result?.result !== true) {
    let message =
      data?.result?.message ||
      data?.message ||
      'TronGrid did not return a successful contract result';

    // TronGrid sometimes returns error messages as Base64.
    try {
      const decoded = Buffer.from(String(message), 'base64').toString('utf8');
      if (decoded && /^[\x09\x0A\x0D\x20-\x7E]+$/.test(decoded)) {
        message = decoded;
      }
    } catch {
      // Keep the original message.
    }

    throw new Error(`USDT balanceOf failed: ${message}`);
  }

  const resultHex = data?.constant_result?.[0];

  if (!resultHex || !/^[0-9a-fA-F]+$/.test(resultHex)) {
    throw new Error('USDT balanceOf returned no valid constant_result');
  }

  const rawBalance = BigInt(`0x${resultHex}`);
  return Number(ethers.formatUnits(rawBalance, 6));
}

async function fetchTronGridBalance(address) {
  let lastErr;

  for (const rpc of TRON_RPCS) {
    try {
      const accountUrl =
        `${rpc}/v1/accounts/${encodeURIComponent(address)}?only_confirmed=true`;

      const [accountData, usdt] = await Promise.all([
        fetchJson(accountUrl, {
          headers: tronHeaders()
        }),
        fetchTronUsdtBalance(rpc, address)
      ]);

      const account =
        accountData?.success &&
        Array.isArray(accountData.data) &&
        accountData.data.length > 0
          ? accountData.data[0]
          : null;

      const trx = account ? tokenAmount(account.balance || 0, 6) : 0;

      return {
        trx,
        usdt,
        source: `${rpc}:account+USDT_balanceOf`
      };
    } catch (err) {
      lastErr = err;
      await sleep(250);
    }
  }

  throw lastErr || new Error(`No TRON RPC available for ${address}`);
}

async function fetchTron(address) {
  try {
    const result = await fetchTronGridBalance(address);

    return {
      trx: result.trx,
      usdt: result.usdt,
      sources: [
        `${result.source}:TRX=${formatAmount(result.trx, 6)},` +
          `USDT=${formatAmount(result.usdt, 6)}`
      ],
      errors: []
    };
  } catch (err) {
    throw new Error(`TronGrid error for ${address}: ${err.message}`);
  }
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

  try {
    tronAddressToHex(addr);
    map.set(addr, userId);
  } catch (err) {
    console.error(
      `WARNING: skipped invalid TRON address for user ${userId}: ${err.message}`
    );
  }
}

async function loadWalletsFromDatabase(supabase) {
  console.log('Loading wallets from DB...');

  const { data: wallets, error } = await supabase
    .from('user_wallets')
    .select('*');

  if (error) {
    throw new Error(`DB Error user_wallets: ${error.message}`);
  }

  const evmWallets = new Map();
  const tronWallets = new Map();

  for (const wallet of wallets || []) {
    addEvmAddress(
      evmWallets,
      wallet.usdt_bep20_address,
      wallet.user_id
    );
    addEvmAddress(
      evmWallets,
      wallet.usdc_bep20_address,
      wallet.user_id
    );
    addEvmAddress(
      evmWallets,
      wallet.usdt_erc20_address,
      wallet.user_id
    );
    addEvmAddress(
      evmWallets,
      wallet.usdc_erc20_address,
      wallet.user_id
    );
    addTronAddress(
      tronWallets,
      wallet.usdt_trc20_address,
      wallet.user_id
    );
  }

  // Fallback for old rows or rows where user_wallets.usdt_trc20_address is
  // missing, but private_keys still contains the public TRON address.
  const { data: privateKeys, error: pkError } = await supabase
    .from('private_keys')
    .select('user_id, network, address')
    .in('network', ['usdt_trc20', 'trx', 'trc_20', 'trc20', 'tron'])
    .not('address', 'is', null);

  if (pkError) {
    console.error(
      `WARNING: private_keys fallback skipped: ${pkError.message}`
    );
  } else {
    for (const keyRow of privateKeys || []) {
      addTronAddress(tronWallets, keyRow.address, keyRow.user_id);
    }
  }

  return {
    evmWallets,
    tronWallets
  };
}

async function main() {
  const { hideEmpty, debug } = parseArgs();

  if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.error('ERROR: Missing SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  if (!TRONGRID_API_KEY) {
    console.log(
      'WARNING: TRONGRID_API_KEY is empty. TRON checks may be rate-limited.'
    );
  }

  const supabase = createClient(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      },
      realtime: {
        transport: WebSocket
      }
    }
  );

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
      const { coinWei, usdtWei, usdcWei } = await fetchEVM(
        BSC_RPCS,
        56,
        address,
        USDT_BSC,
        USDC_BSC
      );

      const bnb = Number(ethers.formatEther(coinWei));
      const usdt = Number(ethers.formatUnits(usdtWei, 18));
      const usdc = Number(ethers.formatUnits(usdcWei, 18));
      const hasFunds = bnb > 0.0005 || usdt > 0.5 || usdc > 0.5;

      if (!hideEmpty || hasFunds) {
        console.log(
          `ID: ${userId} | Addr: ${address} | ` +
            `BNB: ${formatAmount(bnb, 4)} | ` +
            `USDT: ${formatAmount(usdt)} | ` +
            `USDC: ${formatAmount(usdc)}`
        );

        if (usdt > 0 || usdc > 0) {
          totalStuck += usdt + usdc;
        }
      }

      await sleep(100);
    } catch (err) {
      console.log(`Err BSC ${address}: ${err.message}`);
    }
  }

  console.log('\n--- ETHEREUM (ERC20) ---');

  for (const [address, userId] of evmWallets.entries()) {
    try {
      const { coinWei, usdtWei, usdcWei } = await fetchEVM(
        ETH_RPCS,
        1,
        address,
        USDT_ETH,
        USDC_ETH
      );

      const eth = Number(ethers.formatEther(coinWei));
      const usdt = Number(ethers.formatUnits(usdtWei, 6));
      const usdc = Number(ethers.formatUnits(usdcWei, 6));
      const hasFunds = eth > 0.0005 || usdt > 0.5 || usdc > 0.5;

      if (!hideEmpty || hasFunds) {
        console.log(
          `ID: ${userId} | Addr: ${address} | ` +
            `ETH: ${formatAmount(eth, 4)} | ` +
            `USDT: ${formatAmount(usdt)} | ` +
            `USDC: ${formatAmount(usdc)}`
        );

        if (usdt > 0 || usdc > 0) {
          totalStuck += usdt + usdc;
        }
      }

      await sleep(100);
    } catch (err) {
      console.log(`Err ETH ${address}: ${err.message}`);
    }
  }

  console.log('\n--- opBNB (L2) ---');

  let opBnbConnection = null;

  try {
    opBnbConnection = await selectEvmProvider(
      OPBNB_RPCS,
      204,
      [USDT_OPBNB]
    );

    if (debug) {
      console.log(`opBNB RPC: ${opBnbConnection.source}`);
    }
  } catch (err) {
    console.log(`WARNING: opBNB skipped: ${err.message}`);
  }

  if (opBnbConnection) {
    const usdtContract = new ethers.Contract(
      USDT_OPBNB,
      ERC20_ABI,
      opBnbConnection.provider
    );

    for (const [address, userId] of evmWallets.entries()) {
      try {
        const [coinWei, usdtWei] = await Promise.all([
          opBnbConnection.provider.getBalance(address),
          usdtContract.balanceOf(address)
        ]);

        const bnb = Number(ethers.formatEther(coinWei));
        const usdt = Number(ethers.formatUnits(usdtWei, 18));
        const hasFunds = bnb > 0.0005 || usdt > 0.5;

        if (!hideEmpty || hasFunds) {
          console.log(
            `ID: ${userId} | Addr: ${address} | ` +
              `BNB: ${formatAmount(bnb, 4)} | ` +
              `USDT: ${formatAmount(usdt)}`
          );

          if (usdt > 0) {
            totalStuck += usdt;
          }
        }

        await sleep(100);
      } catch (err) {
        console.log(`Err opBNB ${address}: ${err.message}`);
      }
    }
  }

  console.log('\n--- TRON (TRC20) ---');

  for (const [address, userId] of tronWallets.entries()) {
    try {
      const { trx, usdt, sources } = await fetchTron(address);
      const hasFunds = trx > 1 || usdt > 0.5;

      if (!hideEmpty || hasFunds) {
        console.log(
          `ID: ${userId} | Addr: ${address} | ` +
            `TRX: ${formatAmount(trx)} | ` +
            `USDT: ${formatAmount(usdt)}`
        );

        if (debug) {
          console.log(`  sources: ${sources.join(' | ')}`);
        }

        if (usdt > 0) {
          totalStuck += usdt;
        }
      } else if (debug) {
        console.log(
          `EMPTY TRON | ID: ${userId} | Addr: ${address}`
        );
        console.log(`  sources: ${sources.join(' | ')}`);
      }

      await sleep(200);
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
