require('dotenv').config();

module.exports = {
  app: {
    name: 'HypeFollow',
    version: '1.0.0',
    env: process.env.NODE_ENV || 'development',
    emergencyStop: false // Global switch to stop all trading
  },
  binance: {
    apiKey: process.env.BINANCE_API_KEY,
    apiSecret: process.env.BINANCE_API_SECRET,
    useTestnet: process.env.BINANCE_TESTNET === 'true',
  },
  hyperliquid: {
    wsUrl: process.env.HYPERLIQUID_WS_URL || 'wss://api.hyperliquid.xyz/ws',
    // List of "Smart Money" UIDs to follow
    followedUsers: [
      '0xdc899ed4a80e7bbe7c86307715507c828901f196'
    ]
  },
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
  },
  riskControl: {
    // Whitelist of supported coins
    supportedCoins: ['HYPE'],
    // Max position size limits (not implemented in MVP but placeholder)
    maxPositionSize: {
      HYPE: 1000.0 // Add max position size for HYPE
    },
    // Threshold for aggressive risk reduction (reduce half)
    reductionThreshold: {
      HYPE: 100.0 // Add threshold for HYPE
    }
  },
  trading: {
    // Follow mode: 'equal' or 'fixed'
    mode: process.env.TRADING_MODE || 'equal',
    
    // Equal ratio multiplier (only for equal mode)
    equalRatio: parseFloat(process.env.EQUAL_RATIO) || 1.0,
    
    // Fixed ratio multiplier (only for fixed mode)
    fixedRatio: parseFloat(process.env.FIXED_RATIO) || 0.1,

    // Maximum position size to prevent liquidation risk
    maxPositionSize: {
      HYPE: 100.0 // Maximum 100 HYPE
    },

    // Account info cache TTL in seconds
    accountCacheTTL: parseInt(process.env.ACCOUNT_CACHE_TTL) || 60,
    
    // Default scale factor (only for scaled mode)
    defaultScale: 1.0,

    // Min order sizes (static config - to be enhanced with API data if needed)
    minOrderSize: {
      HYPE: 1.0 // Minimum order size for HYPE
    },

    // User-specific strategies
    userStrategies: {
      '0xdc899ed4a80e7bbe7c86307715507c828901f196': {
        HYPE: {
          strategy: 'closeAllOnSell'
        }
      }
    }
  },
  monitoring: {
    enabled: true,
    port: parseInt(process.env.MONITORING_PORT) || 49618,
    refreshInterval: 5000
  }
};
