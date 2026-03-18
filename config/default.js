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
  riskControl: {
    // Only HYPE trading pair is supported
    supportedCoins: ['HYPE'],
    // Max position size limits (reduced to prevent liquidation risk)
    maxPositionSize: {
      HYPE: 100.0
    },
    // Threshold for aggressive risk reduction (reduce half)
    reductionThreshold: {
      HYPE: 100.0
    }
  },
  trading: {
    // Follow mode: 'equal' or 'fixed'
    mode: process.env.TRADING_MODE || 'equal',
    
    // Equal ratio multiplier (only for equal mode)
    equalRatio: parseFloat(process.env.EQUAL_RATIO) || 1.0,
    
    // Fixed ratio multiplier (only for fixed mode)
    fixedRatio: parseFloat(process.env.FIXED_RATIO) || 0.1,

    // Maximum position size to prevent liquidation risk (HYPE only)
    maxPositionSize: {
      HYPE: 100.0
    },

    // Account info cache TTL in seconds
    accountCacheTTL: parseInt(process.env.ACCOUNT_CACHE_TTL) || 60,
    
    // Default scale factor (only for scaled mode)
    defaultScale: 1.0,

    // Min order size for HYPE
    minOrderSize: {
      HYPE: 1.0
    },

    // User-specific strategies
    userStrategies: {
      '0xdc899ed4a80e7bbe7c86307715507c828901f196': {
        HYPE: {
          strategy: 'closeAllOnSell'
        }
      }
    },

    // Take-profit restart configuration
    // When TP is triggered, clean up all orders and restart the process
    takeProfitRestart: {
      // Enable/disable TP restart feature
      enabled: process.env.TP_RESTART_ENABLED !== 'false', // Default: true
      // Position threshold to consider as "zero" (in coin units)
      positionZeroThreshold: parseFloat(process.env.TP_POSITION_THRESHOLD) || 0.01,
      // How often to check for TP trigger (in milliseconds)
      checkIntervalMs: parseInt(process.env.TP_CHECK_INTERVAL) || 3000
    },
    
    // TP Validator configuration
    // Ensures take-profit orders are always in sync with position
    tpValidationIntervalMs: parseInt(process.env.TP_VALIDATION_INTERVAL) || 10000 // 10 seconds
  },
  monitoring: {
    enabled: true,
    port: parseInt(process.env.MONITORING_PORT) || 49618,
    refreshInterval: 5000
  }
};
