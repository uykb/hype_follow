const config = require('config');
const logger = require('../utils/logger');
const redis = require('../utils/redis');
const binanceClient = require('../binance/api-client');
const hyperApiClient = require('../hyperliquid/api-client');

class ExposureManager {
  constructor() {
    // Mode configs
    this.tradingMode = config.get('trading.mode');
    this.fixedRatio = config.get('trading.fixedRatio');
    this.equalRatio = config.get('trading.equalRatio');
    
    this.driftThreshold = 0.01; // 1% threshold for display/warning
  }

  /**
   * Get drift snapshot for all supported coins
   * @param {string} masterAddress 
   * @returns {Promise<Object>} Map of coin -> drift info
   */
  async getDriftSnapshot(masterAddress) {
    const supportedCoins = config.get('riskControl.supportedCoins');
    const drifts = {};

    try {
      const masterPositions = await hyperApiClient.getUserPositions(masterAddress);
      
      for (const coin of supportedCoins) {
        const masterPosObj = masterPositions.find(p => p.coin === coin);
        const masterSize = masterPosObj ? parseFloat(masterPosObj.szi) : 0;

        const followerPos = await binanceClient.getPositionDetails(coin);
        const followerSize = followerPos ? followerPos.amount : 0;

        let targetSize = 0;
        if (this.tradingMode === 'fixed') {
          targetSize = masterSize * this.fixedRatio;
        } else if (this.tradingMode === 'equal') {
          const hlEquity = await require('./account-manager').getHyperliquidTotalEquity(masterAddress);
          const bnEquity = await require('./account-manager').getBinanceTotalEquity();
          if (hlEquity > 0) {
            targetSize = masterSize * (bnEquity / hlEquity) * this.equalRatio;
          }
        }

        const drift = targetSize - followerSize;
        const driftPct = targetSize !== 0 ? (Math.abs(drift) / Math.abs(targetSize)) : 0;

        drifts[coin] = {
          masterSize,
          targetSize,
          followerSize,
          drift,
          driftPct,
          shouldRebalance: Math.abs(drift) >= (config.get('trading.minOrderSize')[coin] || 0) && (driftPct > this.driftThreshold || (targetSize === 0 && Math.abs(drift) > 0))
        };
      }
    } catch (error) {
      logger.error('Failed to calculate drift snapshot', error);
    }

    return drifts;
  }

  // Helper from position-calculator logic (simplified)
  roundQuantity(quantity, coin) {
    const decimals = {
      BTC: 3,
      ETH: 3,
      SOL: 1,
      DEFAULT: 3
    };
    const precision = decimals[coin] || decimals.DEFAULT;
    const factor = Math.pow(10, precision);
    return Math.round(quantity * factor) / factor;
  }
}

module.exports = new ExposureManager();
