#!/usr/bin/env node
const { createClient } = require('@supabase/supabase-js');
const { ethers } = require('ethers');
const WebSocket = require('ws');

// Настройки окружения
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fkjwueogfmdolcjtvvme.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Самые стабильные публичные RPC без лимитов на ключи
const BSC_RPC = 'https://bsc-rpc.publicnode.com';
const ETH_RPC = 'https://ethereum-rpc.publicnode.com'; 

const USDT_BSC = '0x55d398326f99059fF775485246999027B3197955';
const USDC_BSC = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d';
const USDT_ETH = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const USDC_ETH = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'; 
const USDT_TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

const ERC20_ABI = ['function balanceOf(address owner) view returns (uint256)'];
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function parseArgs() {
  const args = process.argv.slice(2);
  return { hideEmpty: args.includes('--hide-empty') };
}

async function main() {
  const { hideEmpty } = parseArgs();

  if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.error('❌ Ошибка: Необходим SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: WebSocket }
  });
  
  console.log('🔄 Загрузка кошельков из БД...');
  const { data: wallets, error } = await supabase.from('user_wallets').select('*');

  if (error) {
    console.error(`❌ Ошибка БД: ${error.message}`);
    process.exit(1);
  }

  const evmWallets = new Map();
  const tronWallets = new Map();

  for (const w of wallets || []) {
    if (w.usdt_bep20_address) evmWallets.set(w.usdt_bep20_address, w.user_id);
    if (w.usdt_trc20_address) tronWallets.set(w.usdt_trc20_address, w.user_id);
  }

  console.log(`✅ Найдено уникальных EVM адресов: ${evmWallets.size}`);
  console.log(`✅ Найдено уникальных TRON адресов: ${tronWallets.size}`);
  console.log('--------------------------------------------------');

  const bscProvider = new ethers.JsonRpcProvider(BSC_RPC, 56, { staticNetwork: true });
  const ethProvider = new ethers.JsonRpcProvider(ETH_RPC, 1, { staticNetwork: true });

  let totalStuck = 0;

  console.log('\n🌐 ПРОВЕРКА СЕТИ BSC (BEP20)...');
  for (const [address, userId] of evmWallets.entries()) {
    try {
      const [bnbWei, usdtWei, usdcWei] = await Promise.all([
        bscProvider.getBalance(address),
        new ethers.Contract(USDT_BSC, ERC20_ABI, bscProvider).balanceOf(address),
        new ethers.Contract(USDC_BSC, ERC20_ABI, bscProvider).balanceOf(address)
      ]);

      const bnb = Number(ethers.formatEther(bnbWei));
      const usdt = Number(ethers.formatUnits(usdtWei, 18));
      const usdc = Number(ethers.formatUnits(usdcWei, 18));
      const hasFunds = bnb > 0.0005 || usdt > 0.5 || usdc > 0.5;

      if (!hideEmpty || hasFunds) {
        console.log(`👤 User ID: ${userId}`);
        console.log(`📍 Адрес:   ${address}`);
        console.log(`   BNB:     ${bnb.toFixed(4)}`);
        console.log(`   USDT:    ${usdt.toFixed(2)}$`);
        console.log(`   USDC:    ${usdc.toFixed(2)}$`);
        console.log('---');
        if (usdt > 0 || usdc > 0) totalStuck += (usdt + usdc);
      }
      await sleep(200); 
    } catch (err) {
      console.log(`⚠️ Ошибка BSC ${address}: ${err.message}`);
    }
  }

  console.log('\n🌐 ПРОВЕРКА СЕТИ ETHEREUM (ERC20)...');
  for (const [address, userId] of evmWallets.entries()) {
    try {
      const [ethWei, usdtWei, usdcWei] = await Promise.all([
        ethProvider.getBalance(address),
        new ethers.Contract(USDT_ETH, ERC20_ABI, ethProvider).balanceOf(address),
        new ethers.Contract(USDC_ETH, ERC20_ABI, ethProvider).balanceOf(address)
      ]);

      const eth = Number(ethers.formatEther(ethWei));
      const usdt = Number(ethers.formatUnits(usdtWei, 6)); 
      const usdc = Number(ethers.formatUnits(usdcWei, 6));
      const hasFunds = eth > 0.0005 || usdt > 0.5 || usdc > 0.5;

      if (!hideEmpty || hasFunds) {
        console.log(`👤 User ID: ${userId}`);
        console.log(`📍 Адрес:   ${address}`);
        console.log(`   ETH:     ${eth.toFixed(4)}`);
        console.log(`   USDT:    ${usdt.toFixed(2)}$`);
        console.log(`   USDC:    ${usdc.toFixed(2)}$`);
        console.log('---');
        if (usdt > 0 || usdc > 0) totalStuck += (usdt + usdc);
      }
      await sleep(200); 
    } catch (err) {
      console.log(`⚠️ Ошибка ETH ${address}: ${err.message}`);
    }
  }

  console.log('\n🌐 ПРОВЕРКА СЕТИ TRON (TRC20)...');
  for (const [address, userId] of tronWallets.entries()) {
    try {
      const response = await fetch(`https://api.trongrid.io/v1/accounts/${address}`);
      const data = await response.json();
      let trx = 0, usdt = 0;

      if (data.success && data.data && data.data.length > 0) {
        const acc = data.data[0];
        trx = (acc.balance || 0) / 1_000_000;
        if (acc.trc20) {
          for (const token of acc.trc20) {
            if (token[USDT_TRON]) usdt = Number(token[USDT_TRON]) / 1_000_000;
          }
        }
      }

      const hasFunds = trx > 1 || usdt > 0.5;
      if (!hideEmpty || hasFunds) {
        console.log(`👤 User ID: ${userId}`);
        console.log(`📍 Адрес:   ${address}`);
        console.log(`   TRX:     ${trx.toFixed(2)}`);
        console.log(`   USDT:    ${usdt.toFixed(2)}$`);
        console.log('---');
        if (usdt > 0) totalStuck += usdt;
      }
      await sleep(250); 
    } catch (err) {
      console.log(`⚠️ Ошибка TRON ${address}: ${err.message}`);
    }
  }

  console.log('\n==================================================');
  console.log(`🎯 Общая сумма застрявших стейблкоинов: ~${totalStuck.toFixed(2)}$`);
}

main().catch(console.error);
