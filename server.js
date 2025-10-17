const express = require('express');
const TronWeb = require('tronweb');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// Приватный ключ будет из переменных окружения
const MASTER_WALLET = {
  address: 'TBwcRtgvbwFicGWtX4PvwWpw5EGMmAiaNS',
  privateKey: process.env.MASTER_PRIVATE_KEY || 'ЗАМЕНИ_НА_СВОЙ_ПРИВАТНЫЙ_КЛЮЧ'
};

const userWallets = new Map();

app.post('/generate-wallet', async (req, res) => {
  try {
    const { userId } = req.body;
    
    console.log('🔄 Generating wallet for user:', userId);
    
    if (!userId) {
      return res.json({ success: false, error: 'User ID required' });
    }

    if (userWallets.has(userId)) {
      const wallet = userWallets.get(userId);
      return res.json({ success: true, address: wallet.address });
    }

    const tronWeb = new TronWeb({
      fullHost: 'https://api.trongrid.io',
      privateKey: MASTER_WALLET.privateKey
    });

    const account = tronWeb.createAccount();
    
    userWallets.set(userId, {
      address: account.address.base58,
      privateKey: account.privateKey
    });

    console.log('✅ Generated wallet:', account.address.base58);
    
    res.json({ success: true, address: account.address.base58 });

  } catch (error) {
    console.error('❌ Error:', error);
    res.json({ success: false, error: 'Failed to generate wallet' });
  }
});

app.get('/', (req, res) => {
  res.json({ 
    status: 'OK', 
    service: 'TRON Wallet Server - BitFarm',
    wallets: userWallets.size,
    message: 'Server is running!'
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('🚀 TRON Wallet Server started on port', PORT);
});
