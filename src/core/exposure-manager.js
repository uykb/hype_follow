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
    
    // Profit target percent (e.g. 0.0001 for 0.01%)
    this.profitTarget = 0.0015;
  }

  /**
   * Check and rebalance exposure for a specific coin
   * @param {string} coin 
   * @param {string} masterAddress 
   */
  async checkAndRebalance(coin, masterAddress) {
    logger.info(`[ExposureManager] Checking exposure for ${coin}...`);
    
    try {
      // 1. Get Master Position
      const masterPositions = await hyperApiClient.getUserPositions(masterAddress);
      const masterPosObj = masterPositions.find(p => p.coin === coin);
      const masterSize = masterPosObj ? parseFloat(masterPosObj.szi) : 0;

      // 2. Get Follower Position (Binance)
      const followerPos = await binanceClient.getPositionDetails(coin);
      if (!followerPos) {
        logger.warn(`[ExposureManager] Could not fetch follower position for ${coin}`);
        return;
      }
      const followerSize = followerPos.amount;

      // 3. Calculate Target Size
      let targetSize = 0;
      if (this.tradingMode === 'fixed') {
        targetSize = masterSize * this.fixedRatio;
      } else if (this.tradingMode === 'equal') {
        logger.debug('[ExposureManager] Equal mode rebalancing not fully implemented yet. Skipping.');
        return;
      }

      // 4. Calculate Excess (Over-exposure)
      const absMaster = Math.abs(masterSize);
      const absFollower = Math.abs(followerSize);
      const absTarget = Math.abs(targetSize);
      
      const excess = absFollower - absTarget;

      // 4.2 Calculate Uncovered Position (to avoid fighting with HL synced orders)
      const binanceSide = followerSize > 0 ? 'SELL' : 'BUY';
      const openReduceOnlyQty = await binanceClient.getOpenOrderQuantity(coin, binanceSide);
      const uncoveredPosition = Math.max(0, absFollower - openReduceOnlyQty);

      logger.info(`[ExposureManager] ${coin}: Master=${masterSize}, Target=${targetSize}, Follower=${followerSize}, Uncovered=${uncoveredPosition}, Excess=${excess}`);

      // 4.5 Determine Reduction Quantity
      let quantityToReduce = 0;
      const threshold = config.get('riskControl.reductionThreshold')[coin] || 999999;

      if (absFollower >= threshold) {
        // Aggressive Risk Reduction: Reduce Half of TOTAL position
        // We ignore uncoveredPosition here because we want this to be a priority safety net
        const decimals = { BTC: 3, ETH: 3, SOL: 1, DEFAULT: 3 };
        const precision = decimals[coin] || decimals.DEFAULT;
        const factor = Math.pow(10, precision);
        
        quantityToReduce = Math.floor((absFollower / 2) * factor) / factor;
        logger.info(`[ExposureManager] ${coin} total position ${absFollower} >= threshold ${threshold}. Reducing HALF: ${quantityToReduce}`);
      } else if (excess > 0.00001 && uncoveredPosition > 0.00001) {
        // Normal Excess Reduction (only if there's uncovered position)
        const potentialReduction = Math.min(excess, uncoveredPosition);
        quantityToReduce = this.roundQuantity(potentialReduction, coin);
        logger.info(`[ExposureManager] ${coin} reducing excess: ${quantityToReduce}`);
      }


      if (quantityToReduce <= 0) {
        logger.info(`[ExposureManager] No reduction needed for ${coin}.`);
        return;
      }

      // 5. Determine TP Direction
      const tpSide = followerSize > 0 ? 'A' : 'B';
      
      // 6. Determine TP Price
      const entryPrice = followerPos.entryPrice;
      if (!entryPrice || entryPrice <= 0) {
        logger.warn('[ExposureManager] Invalid entry price, cannot calculate TP.');
        return;
      }

      const priceMultiplier = tpSide === 'A' ? (1 + this.profitTarget) : (1 - this.profitTarget);
      const tpPrice = entryPrice * priceMultiplier;

      // 7. Manage TP Order
      const redisKey = `exposure:tp:${coin}`;
      const oldTpOrderId = await redis.get(redisKey);
      
      if (oldTpOrderId) {
        logger.info(`[ExposureManager] Cancelling old TP order ${oldTpOrderId}`);
        try {
          await binanceClient.cancelOrder(binanceClient.getBinanceSymbol(coin), oldTpOrderId);
        } catch (e) {
          logger.warn(`[ExposureManager] Failed to cancel old TP order (might be filled): ${e.message}`);
        }
        await redis.del(redisKey);
      }

      // 8. Place New TP Order
      logger.info(`[ExposureManager] Placing Reduce-Only TP: ${coin} ${tpSide} ${quantityToReduce} @ ${tpPrice}`);
      
      try {
        const order = await binanceClient.createReduceOnlyOrder(coin, tpSide, tpPrice, quantityToReduce);
        if (order && order.orderId) {
          await redis.set(redisKey, order.orderId);
          logger.info(`[ExposureManager] TP Order placed: ${order.orderId}`);
        }
      } catch (e) {
        logger.error(`[ExposureManager] Failed to place TP order: ${e.message}`);
      }

    } catch (error) {
      logger.error(`[ExposureManager] Error in checkAndRebalance for ${coin}`, error);
    }
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
