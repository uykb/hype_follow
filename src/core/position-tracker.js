const redis = require('../utils/redis');
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
        // We use a single 'amount' field for Signed Net Delta
        // targetPosition is just for reference/monitoring mainly in this architecture, 
        // pendingDelta is the operational key.
        // Initially, pendingDelta = size. This means we are "Behind" by 'size' amount.
        // wait... init logic: 
        // If SM has 0.5 BTC. Follower has 0.
        // PendingDelta should be 0.5.
        // When SM adds 0.1. Follower executes 0.1 + 0.5? No.
        // User Requirement 1: "Available positions... wait for next add... add them together"
        // So yes, PendingDelta = 0.5. 
        // Next SM Buy 0.1. Total = 0.6. Follower buys 0.6. Synced. Correct.
        
        const pipeline = redis.pipeline()
          .hset(`targetPosition:${pos.coin}`, {
            amount: size,
            lastUpdate: Date.now()
          })
          .expire(`targetPosition:${pos.coin}`, 2592000) // 30 days
          .set(`pendingDelta:${pos.coin}`, size) // Simple string key for signed float
          .expire(`pendingDelta:${pos.coin}`, 2592000); // 30 days
          
        await pipeline.exec();
          
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
    
    // Redis INCRBYFLOAT is perfect for this
    // It handles the existence check (treating non-existent as 0) and float addition
    const newDelta = await redis.incrbyfloat(key, signedAmount);
    await redis.expire(key, 2592000); // Refresh TTL (30 days)
    
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
    const deltaStr = await redis.get(`pendingDelta:${coin}`);
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
    // Using INCRBYFLOAT with negated amount.
    
    if (signedAmountConsumed === 0) return;
    
    const key = `pendingDelta:${coin}`;
    const newDelta = await redis.incrbyfloat(key, -signedAmountConsumed);
    await redis.expire(key, 2592000); // Refresh TTL (30 days)
    
    logger.info(`Consumed pending delta for ${coin}: consumed ${signedAmountConsumed}, remaining: ${newDelta}`);
  }

  /**
   * Get pending delta for a coin
   * @param {string} coin 
   * @returns {Promise<number>} Pending delta amount
   */
  async getPendingDelta(coin) {
    const key = `pendingDelta:${coin}`;
    const deltaStr = await redis.get(key);
    return parseFloat(deltaStr) || 0;
  }
}

module.exports = new PositionTracker();
