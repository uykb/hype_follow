const store = require('../utils/memory-store');
const logger = require('../utils/logger');
const config = require('config');
const orderMapper = require('./order-mapper');
const binanceClient = require('../binance/api-client');
const positionTracker = require('./position-tracker');
const positionCalculator = require('./position-calculator');

class ConsistencyEngine {
  constructor() {
    // MVP assumes single user tracking for address-dependent logic
    const followedUsers = config.get('hyperliquid.followedUsers');
    this.primaryTargetAddress = followedUsers && followedUsers.length > 0 ? followedUsers[0] : null;
  }
  
  /**
   * Check if Hyperliquid order has already been processed
   * @param {string} oid 
   */
  async isOrderProcessed(oid) {
    const processed = await store.hget(`orderHistory:${oid}`, 'processed');
    return processed === 'true';
  }

  /**
   * Mark Hyperliquid order as processed
   * @param {string} oid 
   * @param {object} details 
   */
  async markOrderProcessed(oid, details) {
    try {
      await store.hset(`orderHistory:${oid}`, {
        ...details,
        processed: 'true',
        processedAt: Date.now()
      });
    } catch (error) {
      logger.error(`Failed to mark order ${oid} as processed`, error);
    }
  }

  /**
   * Check if we should process this Hyperliquid order
   * Checks for duplicates and existing active Binance orders
   * @param {string} userAddress
   * @param {string} oid 
   */
  async shouldProcessHyperOrder(userAddress, oid) {
    // 1. Atomic check-and-set to prevent race conditions (Duplicate Orders)
    // We use a temporary "processing" flag in memory store
    const lockKey = `orderLock:${userAddress}:${oid}`;
    const acquired = await store.set(lockKey, 'true', 'NX', 'EX', 30); // 30s lock
    
    if (!acquired) {
      logger.debug(`Order ${userAddress}:${oid} is already being processed or locked, skipping`);
      return false;
    }

    if (await this.isOrderProcessed(oid)) {
      logger.debug(`Order ${oid} already processed, skipping`);
      // Keep lock for a bit to be safe, or delete if we are sure
      return false;
    }

    const mapping = await orderMapper.getBinanceOrder(userAddress, oid);
    if (mapping) {
      try {
        const status = await binanceClient.getOrderStatus(mapping.symbol, mapping.orderId);
        if (['NEW', 'PARTIALLY_FILLED'].includes(status)) {
          logger.info(`Active Binance order exists for ${userAddress}:${oid} (${mapping.orderId}), skipping`);
          return false;
        }
        // If it's not active, we might want to allow re-processing if it's a sync
        // But usually, we don't want to double-process.
        return false;
      } catch (error) {
        logger.warn(`Mapping exists for ${userAddress}:${oid} but Binance check failed, skipping safety`, error);
        return false;
      }
    }

    return true;
  }

  /**
   * Release the processing lock for an order
   * @param {string} userAddress
   * @param {string} oid 
   */
  async releaseOrderLock(userAddress, oid) {
    await store.del(`orderLock:${userAddress}:${oid}`);
  }

  /**
   * Record an Orphan Fill (Binance filled, Hyperliquid didn't)
   * This updates the Pending Delta to reflect that we are "Ahead" of the target.
   * 
   * @param {string} hyperOid 
   * @param {object} fillDetails { coin, side: 'B'/'A', size: string/number, userAddress, ... }
   */
  async recordOrphanFill(hyperOid, fillDetails) {
    const userAddress = fillDetails.userAddress;
    const key = `orphanFill:${userAddress}:${hyperOid}`;
    
    // Check if already recorded to avoid double-counting
    const exists = await store.exists(key);
    if (exists) return;

    // Calculate Master Equivalent Size
    const followerSize = parseFloat(fillDetails.size);
    const masterSize = await positionCalculator.getReversedMasterSize(
      followerSize, 
      userAddress
    );

    await store.hset(key, {
      coin: fillDetails.coin,
      side: fillDetails.side,
      size: fillDetails.size,
      price: fillDetails.price,
      binanceOrderId: fillDetails.binanceOrderId,
      occurredAt: Date.now(),
      masterSize: masterSize
    });

    // Calculate Signed Size based on Master Size
    const signedChange = fillDetails.side === 'B' ? -masterSize : masterSize;

    await positionTracker.addPendingDelta(fillDetails.coin, signedChange);
    
    logger.warn(`Orphan fill recorded: Hype OID ${hyperOid}, Delta adjusted by ${signedChange} (Master Units)`);
  }

  /**
   * Handle Hyperliquid Fill Event
   * Checks if this fill resolves a previous orphan state
   * @param {string} userAddress
   * @param {string} oid 
   */
  async handleHyperliquidFill(userAddress, oid) {
    const orphanKey = `orphanFill:${userAddress}:${oid}`;
    const orphan = await store.hgetall(orphanKey);
    
    if (orphan && orphan.coin) {
      // HL finally filled. 
      // We previously adjusted delta by (-SignedMasterSize).
      // Now we need to Reverse this adjustment because the Target has now moved.
      // (Target increase = +MasterSize. Actual unchanged now. Net Delta increase = +MasterSize).
      
      // Use the stored masterSize if available, otherwise reverse calc again (might have ratio drift but ok)
      let masterSize = orphan.masterSize ? parseFloat(orphan.masterSize) : 0;
      
      if (!masterSize) {
         masterSize = await positionCalculator.getReversedMasterSize(
           parseFloat(orphan.size),
           userAddress
         );
      }

      const signedChange = orphan.side === 'B' ? masterSize : -masterSize;

      await positionTracker.addPendingDelta(orphan.coin, signedChange);
      
      await store.del(orphanKey);
      logger.info(`Orphan fill resolved (Hype Caught Up): Hype OID ${oid}, Delta adjusted by ${signedChange}`);
    }
  }

  /**
   * Clear all order history and locks (used for take-profit cleanup)
   */
  async clearAllHistory() {
    try {
      const historyKeys = await store.keys('orderHistory:*');
      const lockKeys = await store.keys('orderLock:*');
      const orphanKeys = await store.keys('orphanFill:*');
      
      for (const key of [...historyKeys, ...lockKeys, ...orphanKeys]) {
        await store.del(key);
      }
      
      logger.info('[ConsistencyEngine] Cleared all order history and locks');
    } catch (error) {
      logger.error('Failed to clear all history', error);
    }
  }
}

module.exports = new ConsistencyEngine();