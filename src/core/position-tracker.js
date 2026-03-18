const store = require('../utils/memory-store');
const logger = require('../utils/logger');
const hyperApiClient = require('../hyperliquid/api-client');

class PositionTracker {
  /**
   * Initialize positions from Smart Money target
   * @param {string} targetAddress 
   */
  async init(targetAddress) {
    try {
      logger.info(`Initializing Position Tracker for ${targetAddress}...`);
      const positions = await hyperApiClient.getUserPositions(targetAddress);
      
      for (const pos of positions) {
        // szi is signed size (positive = long, negative = short)
        const size = parseFloat(pos.szi); 
        
        // Save target position and initialize pending delta
        await store.hset(`targetPosition:${pos.coin}`, {
          amount: size,
          lastUpdate: Date.now()
        });
        
        // Initialize pending delta
        await store.set(`pendingDelta:${pos.coin}`, size);
          
        logger.info(`Tracked initial position for ${pos.coin}: ${size} (Pending Sync)`);
      }
    } catch (error) {
      logger.error('Failed to initialize PositionTracker', error);
    }
  }

  /**
   * Add to pending delta (Signed)
   * @param {string} coin 
   * @param {number} signedAmount Change in delta (Positive or Negative)
   */
  async addPendingDelta(coin, signedAmount) {
    const key = `pendingDelta:${coin}`;
    
    // Increment the delta
    const newDelta = await store.incrbyfloat(key, signedAmount);
    
    logger.info(`Updated pending delta for ${coin}: added ${signedAmount}, new total: ${newDelta}`);
    return parseFloat(newDelta);
  }

  /**
   * Get total execution size including pending delta
   * Returns Signed Total Size
   * @param {string} coin 
   * @param {number} signedOrderSize Smart Money's Order Size (Signed: + for Buy, - for Sell)
   */
  async getTotalExecutionSize(coin, signedOrderSize) {
    const deltaStr = await store.get(`pendingDelta:${coin}`);
    const pending = parseFloat(deltaStr) || 0;
    
    // Logic: We want to execute (SM_Action + Catch_Up)
    return signedOrderSize + pending;
  }

  /**
   * Consume pending delta after execution
   * @param {string} coin 
   * @param {number} signedAmountConsumed The amount of *delta* that was consumed.
   * Note: This is usually (TotalExecuted - OriginalOrder).
   */
  async consumePendingDelta(coin, signedAmountConsumed) {
    // We subtract the consumed amount from delta
    // If we consumed positive delta (bought more), we subtract positive.
    // If we consumed negative delta (sold more), we subtract negative (add).
    
    if (signedAmountConsumed === 0) return;
    
    const key = `pendingDelta:${coin}`;
    const newDelta = await store.incrbyfloat(key, -signedAmountConsumed);
    
    logger.info(`Consumed pending delta for ${coin}: consumed ${signedAmountConsumed}, remaining: ${newDelta}`);
  }

  /**
   * Get pending delta for a coin
   * @param {string} coin 
   * @returns {Promise<number>} Pending delta amount
   */
  async getPendingDelta(coin) {
    const key = `pendingDelta:${coin}`;
    const deltaStr = await store.get(key);
    return parseFloat(deltaStr) || 0;
  }

  /**
   * Clear all pending deltas (used for take-profit cleanup)
   */
  async clearAllDeltas() {
    try {
      const keys = await store.keys('pendingDelta:*');
      for (const key of keys) {
        await store.del(key);
      }
      logger.info('[PositionTracker] Cleared all pending deltas');
    } catch (error) {
      logger.error('Failed to clear all deltas', error);
    }
  }
}

module.exports = new PositionTracker();