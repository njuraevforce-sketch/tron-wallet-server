#!/usr/bin/env node
const { createClient } = require('@supabase/supabase-js');
const { ethers } = require('ethers');

// Настройки окружения
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fkjwueogfmdolcjtvvme.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// RPC для EVM сетей
const BSC_RPC = 'https://bsc-dataseed.binance.org/';
const ETH_RPC = 'https://eth.llamarpc.com'; // Публичный узел, можно заменить на Infura/Alchemy

// Контракты
const USDT_BSC = '0x55d398326f99059fF775485246999027B3197955';
const USDC_BSC = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d';
const USDT_ETH = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const USDC_ETH = '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const USDT_TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

const ERC20_ABI = ['function balanceOf(address owner) view returns (uint256)'];

// Утилита для паузы (чтобы не словить Rate Limit от публичных RPC)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    hideEmpty: args.includes('--hide-empty'), // Показывать только кошельки с балансом > 0
  };
}

async function main() {
  const { hideEmpty } = parseArgs();

  if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.error('❌ Ошибка: Необходим SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  
  console.log('🔄 Загрузка кошельков из базы данных...');
  const { data: wallets, error } = await supabase.from('user_wallets').select('*');

  if (error) {
    console.error(`❌ Ошибка БД: ${error.message}`);
    process.exit(1);
  }

  // Собираем уникальные адреса
  const evmAddresses = new Set();
  const tronAddresses = new Set();

  for (const w of wallets) {
    if (w.usdt_bep20_address) evmAddresses.add(w.usdt_bep20_address);
    // Так как у вас unified EVM, usdc_bep20 и erc20 адреса те же самые
    if (w.usdt_trc20_address) tronAddresses.add(w.usdt_trc20_address);
  }

  console.log(`✅ Найдено уникальных EVM адресов: ${evmAddresses.size}`);
  console.log(`✅ Найдено уникальных TRON адресов: ${tronAddresses.size}`);
  console.log('--------------------------------------------------');

  const bscProvider = new ethers.JsonRpcProvider(BSC_RPC);
  const ethProvider = new ethers.JsonRpcProvider(ETH_RPC);

  let totalStuck = 0;

  // === ПРОВЕРКА EVM (BSC) ===
  console.log('\n🌐 ПРОВЕРКА СЕТИ BSC (BEP20)...');
  for (const address of evmAddresses) {
    try {
      const bnbBalanceWei = await bscProvider.getBalance(address);
      const usdtContract = new ethers.Contract(USDT_BSC, ERC20_ABI, bscProvider);
      const usdcContract = new ethers.Contract(USDC_BSC, ERC20_ABI, bscProvider);

      const usdtWei = await usdtContract.balanceOf(address);
      const usdcWei = await usdcContract.balanceOf(address);

      const bnb = Number(ethers.formatEther(bnbBalanceWei));
      const usdt = Number(ethers.formatUnits(usdtWei, 18));
      const usdc = Number(ethers.formatUnits(usdcWei, 18));

      const hasFunds = bnb > 0.0005 || usdt > 0.5 || usdc > 0.5;

      if (!hideEmpty || hasFunds) {
        console.log(`Адрес: ${address}`);
        console.log(`  BNB:  ${bnb.toFixed(4)}`);
        console.log(`  USDT: ${usdt.toFixed(2)}$`);
        console.log(`  USDC: ${usdc.toFixed(2)}$`);
        if (usdt > 0 || usdc > 0) totalStuck += (usdt + usdc);
      }
      await sleep(100); // Защита от спама RPC
    } catch (err) {
      console.log(`⚠️ Ошибка при проверке BSC адреса ${address}: ${err.message}`);
    }
  }

  // === ПРОВЕРКА EVM (ETH) ===
  console.log('\n🌐 ПРОВЕРКА СЕТИ ETHEREUM (ERC20)...');
  for (const address of evmAddresses) {
    try {
      const ethBalanceWei = await ethProvider.getBalance(address);
      const usdtContract = new ethers.Contract(USDT_ETH, ERC20_ABI, ethProvider);
      const usdcContract = new ethers.Contract(USDC_ETH, ERC20_ABI, ethProvider);

      const usdtWei = await usdtContract.balanceOf(address);
      const usdcWei = await usdcContract.balanceOf(address);

      const eth = Number(ethers.formatEther(ethBalanceWei));
      const usdt = Number(ethers.formatUnits(usdtWei, 6)); // В ETH 6 нулей
      const usdc = Number(ethers.formatUnits(usdcWei, 6));

      const hasFunds = eth > 0.0005 || usdt > 0.5 || usdc > 0.5;

      if (!hideEmpty || hasFunds) {
        console.log(`Адрес: ${address}`);
        console.log(`  ETH:  ${eth.toFixed(4)}`);
        console.log(`  USDT: ${usdt.toFixed(2)}$`);
        console.log(`  USDC: ${usdc.toFixed(2)}$`);
        if (usdt > 0 || usdc > 0) totalStuck += (usdt + usdc);
      }
      await sleep(100);
    } catch (err) {
      console.log(`⚠️ Ошибка при проверке ETH адреса ${address}: ${err.message}`);
    }
  }

  // === ПРОВЕРКА TRON (TRC20) ===
  console.log('\n🌐 ПРОВЕРКА СЕТИ TRON (TRC20)...');
  for (const address of tronAddresses) {
    try {
      const url = `https://api.trongrid.io/v1/accounts/${address}`;
      const response = await fetch(url);
      const data = await response.json();

      let trx = 0;
      let usdt = 0;

      if (data.success && data.data && data.data.length > 0) {
        const acc = data.data[0];
        trx = (acc.balance || 0) / 1_000_000;
        
        if (acc.trc20) {
          for (const token of acc.trc20) {
            if (token[USDT_TRON]) {
              usdt = Number(token[USDT_TRON]) / 1_000_000;
            }
          }
        }
      }

      const hasFunds = trx > 1 || usdt > 0.5;

      if (!hideEmpty || hasFunds) {
        console.log(`Адрес: ${address}`);
        console.log(`  TRX:  ${trx.toFixed(2)}`);
        console.log(`  USDT: ${usdt.toFixed(2)}$`);
        if (usdt > 0) totalStuck += usdt;
      }
      await sleep(200); // TronGrid API лимиты строже
    } catch (err) {
      console.log(`⚠️ Ошибка при проверке TRON адреса ${address}: ${err.message}`);
    }
  }

  console.log('\n==================================================');
  console.log(`🎯 Общая сумма застрявших стейблкоинов: ~${totalStuck.toFixed(2)}$`);
}

main().catch(console.error);
