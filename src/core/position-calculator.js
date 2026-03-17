const config = require('config');
const accountManager = require('./account-manager');
const logger = require('../utils/logger');

class PositionCalculator {
  constructor() {
    this.mode = config.get('trading.mode');
    this.equalRatio = config.get('trading.equalRatio');
    this.fixedRatio = config.get('trading.fixedRatio');
    this.minOrderSizes = config.get('trading.minOrderSize');
  }

  /**
   * Calculate order quantity based on configured mode
   * @param {string} coin 
   * @param {number} originalQuantity 
   * @param {string} hlAddress 
   * @param {string} actionType 'open' or 'close'
   * @returns {Promise<number|null>} Calculated quantity or null if invalid/too small
   */
  async calculateQuantity(coin, originalQuantity, hlAddress, actionType = 'open') {
    let calculatedQuantity;

    try {
      if (this.mode === 'equal') {
        // Equal ratio follow
        calculatedQuantity = await this.calculateEqualRatio(
          coin,
          originalQuantity,
          hlAddress
        );
      } else if (this.mode === 'fixed') {
        // Fixed ratio follow
        calculatedQuantity = originalQuantity * this.fixedRatio;
      } else {
        throw new Error(`Unknown trading mode: ${this.mode}`);
      }

      // Check min order size
      const minSize = this.minOrderSizes[coin] || 0;

      if (calculatedQuantity < minSize) {
        logger.warn(`Calculated quantity ${calculatedQuantity} for ${coin} (${actionType}) below minimum ${minSize}, forcing minimum size`);
        calculatedQuantity = minSize;
      }

      // Round to precision
      const roundedQuantity = this.roundToPrecision(calculatedQuantity, coin);

      // Final sanity check after rounding (rounding might make it 0)
      if (roundedQuantity <= 0) {
        logger.warn(`Quantity rounded to 0 for ${coin}, skipping`);
        return null;
      }

      logger.info(`Calculated quantity: ${originalQuantity} -> ${roundedQuantity} (mode: ${this.mode})`);
      return roundedQuantity;

    } catch (error) {
      logger.error('Error calculating position size', error);
      return null; // Fail safe
    }
  }

  /**
   * Calculate quantity based on equity ratio
   * @param {string} coin
   * @param {number} originalQuantity 
   * @param {string} hlAddress
   */
  async calculateEqualRatio(coin, originalQuantity, hlAddress) {
    if (!hlAddress) {
      logger.warn('No Hyperliquid address provided for equal ratio calculation, defaulting to 0');
      return 0;
    }

    const hlEquity = await accountManager.getHyperliquidTotalEquity(hlAddress);
    const binanceEquity = await accountManager.getBinanceTotalEquity();

    if (hlEquity === 0) {
      logger.warn('Hyperliquid equity is 0, cannot calculate ratio');
      return 0;
    }

    const ratio = (binanceEquity / hlEquity) * this.equalRatio;
    const calculatedQuantity = originalQuantity * ratio;
    
    logger.debug(`Equal Calc: HL_Eq=${hlEquity}, BN_Eq=${binanceEquity}, Ratio=${ratio}, Res=${calculatedQuantity}`);

    return calculatedQuantity;
  }

  /**
   * Reverse calculation: Convert Follower Size -> Master Size
   * Used for handling Orphan Fills (Binance side) to update Delta (Master side)
   * @param {number} followerQuantity 
   * @param {string} hlAddress 
   * @returns {Promise<number>} Equivalent Master Size
   */
  async getReversedMasterSize(followerQuantity, hlAddress) {
    let ratio = 1.0;

    try {
      if (this.mode === 'fixed') {
        ratio = this.fixedRatio;
      } else if (this.mode === 'equal') {
        if (!hlAddress) return followerQuantity; // Fallback
        
        const hlEquity = await accountManager.getHyperliquidTotalEquity(hlAddress);
        const binanceEquity = await accountManager.getBinanceTotalEquity();
        
        if (hlEquity > 0) {
           ratio = (binanceEquity / hlEquity) * this.equalRatio;
        }
      }
    } catch (err) {
      logger.error('Error calculating reverse ratio', err);
    }

    if (ratio === 0) return 0;
    return followerQuantity / ratio;
  }

  /**
   * Round quantity to specific precision for Binance
   * @param {number} quantity 
   * @param {string} coin 
   */
  roundToPrecision(quantity, coin) {
    // Binance precision configuration for HYPE only
    const decimals = {
      HYPE: 1
    };

    const precision = decimals[coin] || 1;
    const factor = Math.pow(10, precision);
    
    return Math.round(quantity * factor) / factor;
  }
}

module.exports = new PositionCalculator();
