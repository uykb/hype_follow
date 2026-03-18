/**
 * Take Profit Handler
 * 
 * Handles the detection and cleanup when take-profit is triggered.
 * When TP is hit, this module:
 * 1. Cleans up all Binance pending orders
 * 2. Clears all in-memory mappings
 * 3. Exits the process (Docker restart policy will restart container)
 * 
 * Docker restart policy required:
 *   docker run --restart=always ...
 *   or in docker-compose:
 *   restart: always
 * 
 * This ensures a clean state for the next trading cycle.
 */

const logger = require('../utils/logger');
const config = require('config');
const store = require('../utils/memory-store');
const binanceClient = require('../binance/api-client');
const orderMapper = require('./order-mapper');
const positionTracker = require('./position-tracker');
const consistencyEngine = require('./consistency-engine');

class TakeProfitHandler {
  constructor() {
    this.isShuttingDown = false;
    this.lastPositionCheck = null;
    this.positionCheckInterval = null;
    
    // Address 2 is the Martingale strategy address
    this.martingaleAddress = '0xdc899ed4a80e7bbe7c86307715507c828901f196';
    
    // Config
    this.enabled = config.get('trading.takeProfitRestart.enabled') !== false;
    this.positionZeroThreshold = config.get('trading.takeProfitRestart.positionZeroThreshold') || 0.01;
  }

  /**
   * Start monitoring for take-profit events
   * This monitors Binance position changes to detect when position goes to zero
   */
  startPositionMonitoring() {
    if (!this.enabled) {
      logger.info('[TPHandler] Take-profit restart monitoring is disabled');
      return;
    }

    const checkInterval = config.get('trading.takeProfitRestart.checkIntervalMs') || 3000;
    
    logger.info(`[TPHandler] Starting position monitoring (interval: ${checkInterval}ms)`);

    this.positionCheckInterval = setInterval(async () => {
      if (this.isShuttingDown) return;
      
      try {
        await this.checkForTakeProfit();
      } catch (error) {
        logger.error('[TPHandler] Error in position check', error);
      }
    }, checkInterval);
  }

  /**
   * Stop position monitoring
   */
  stopPositionMonitoring() {
    if (this.positionCheckInterval) {
      clearInterval(this.positionCheckInterval);
      this.positionCheckInterval = null;
    }
  }

  /**
   * Check if take-profit has been triggered
   * TP is triggered when:
   * 1. Previous position was > 0 (long)
   * 2. Current position is ~0 (closed)
   * 3. We have tracked TP orders
   */
  async checkForTakeProfit() {
    const supportedCoins = config.get('riskControl.supportedCoins') || ['HYPE'];
    
    for (const coin of supportedCoins) {
      try {
        // Get current position
        const position = await binanceClient.getPositionDetails(coin);
        const currentPos = position ? Math.abs(position.amount) : 0;
        
        // Get last known position from memory store
        const lastPosKey = `tp:lastPosition:${coin}`;
        const lastPosStr = await store.get(lastPosKey);
        const lastPos = lastPosStr ? parseFloat(lastPosStr) : null;
        
        // Get tracked TP order
        const tpOrderId = await store.get(`exposure:tp:${coin}`);
        
        // Check if position went from > threshold to ~0
        if (lastPos !== null && lastPos > this.positionZeroThreshold && currentPos < this.positionZeroThreshold) {
          // Position closed - likely TP hit
          logger.info(`[TPHandler] Position closed detected for ${coin}: ${lastPos} -> ${currentPos}`);
          
          // Check if we had a TP order tracked
          if (tpOrderId) {
            logger.info(`[TPHandler] Take-profit triggered for ${coin}! Initiating cleanup and restart...`);
            await this.handleTakeProfitTriggered(coin);
            return; // Exit after handling
          }
        }
        
        // Update last known position
        if (currentPos >= this.positionZeroThreshold) {
          await store.set(lastPosKey, currentPos.toString());
        }
        
      } catch (error) {
        logger.error(`[TPHandler] Error checking ${coin} position`, error);
      }
    }
  }

  /**
   * Handle take-profit triggered event
   * @param {string} coin 
   */
  async handleTakeProfitTriggered(coin) {
    if (this.isShuttingDown) {
      logger.info('[TPHandler] Already shutting down, skipping duplicate trigger');
      return;
    }
    
    this.isShuttingDown = true;
    
    logger.info(`[TPHandler] ========== TAKE-PROFIT TRIGGERED FOR ${coin} ==========`);
    logger.info('[TPHandler] Starting cleanup process...');
    
    try {
      // 1. Cancel all Binance orders for this coin
      await this.cancelAllBinanceOrders(coin);
      
      // 2. Clear all in-memory mappings
      await this.clearAllMemoryMappings(coin);
      
      // 3. Clear TP tracking
      await store.del(`exposure:tp:${coin}`);
      await store.del(`tp:lastPosition:${coin}`);
      
      // 4. Clear martingale tracking
      const userStrategies = config.get('trading.userStrategies') || {};
      for (const userAddress of Object.keys(userStrategies)) {
        await store.del(`martingale:last_position:${userAddress}`);
        await store.del(`martingale:last_tp:${userAddress}:${coin}`);
        await store.del(`martingale:last_hl_orders:${userAddress}`);
        await store.del(`martingale:synced_order:${userAddress}:${coin}`);
      }
      
      // 5. Clear pending deltas
      await positionTracker.clearAllDeltas();
      
      // 6. Clear order history and locks
      await consistencyEngine.clearAllHistory();
      
      // 7. Clear order mappings
      await orderMapper.clearAllMappings();
      
      logger.info('[TPHandler] Cleanup completed successfully');
      logger.info('[TPHandler] Exiting process for clean restart...');
      logger.info('[TPHandler] Docker will restart this container (ensure restart policy is set)');
      
      // Exit process - Docker restart policy (always/unless-stopped) will restart container
      process.exit(0);
      
    } catch (error) {
      logger.error('[TPHandler] Error during cleanup', error);
      // Still exit to allow restart
      process.exit(1);
    }
  }

  /**
   * Cancel all Binance orders for a coin
   * @param {string} coin 
   */
  async cancelAllBinanceOrders(coin) {
    try {
      const symbol = binanceClient.getBinanceSymbol(coin);
      const openOrders = await binanceClient.client.futuresOpenOrders({ symbol });
      
      logger.info(`[TPHandler] Cancelling ${openOrders.length} open orders for ${symbol}`);
      
      for (const order of openOrders) {
        try {
          await binanceClient.cancelOrder(symbol, order.orderId);
          logger.info(`[TPHandler] Cancelled order ${order.orderId} (${order.side} ${order.origQty} @ ${order.price})`);
        } catch (cancelError) {
          // Order might already be filled/cancelled
          logger.warn(`[TPHandler] Could not cancel order ${order.orderId}: ${cancelError.message}`);
        }
      }
      
      logger.info(`[TPHandler] All Binance orders cancelled for ${coin}`);
    } catch (error) {
      logger.error(`[TPHandler] Error cancelling Binance orders for ${coin}`, error);
      throw error;
    }
  }

  /**
   * Clear all in-memory mappings
   * @param {string} coin 
   */
  async clearAllMemoryMappings(coin) {
    try {
      const symbol = binanceClient.getBinanceSymbol(coin);
      
      // Get all mapping keys
      const h2bKeys = await store.keys('map:h2b:*');
      const b2hKeys = await store.keys('map:b2h:*');
      const timestampKeys = await store.keys('timestamp:order:*');
      const historyKeys = await store.keys('orderHistory:*');
      const lockKeys = await store.keys('orderLock:*');
      
      let deletedCount = 0;
      
      // Delete all mappings
      for (const key of [...h2bKeys, ...b2hKeys, ...timestampKeys, ...historyKeys, ...lockKeys]) {
        try {
          // Check if it's for this coin
          const value = await store.get(key);
          if (value) {
            const parsed = JSON.parse(value);
            if (parsed.symbol === symbol || !parsed.symbol) {
              await store.del(key);
              deletedCount++;
            }
          } else {
            // Key without value (like lock keys), delete anyway
            await store.del(key);
            deletedCount++;
          }
        } catch (parseError) {
          // Delete anyway
          await store.del(key);
          deletedCount++;
        }
      }
      
      logger.info(`[TPHandler] Cleared ${deletedCount} in-memory mappings`);
    } catch (error) {
      logger.error('[TPHandler] Error clearing in-memory mappings', error);
      throw error;
    }
  }

  /**
   * Initialize position tracking on startup
   * Call this after syncUserOrders to set initial position
   */
  async initializePositionTracking() {
    const supportedCoins = config.get('riskControl.supportedCoins') || ['HYPE'];
    
    for (const coin of supportedCoins) {
      try {
        const position = await binanceClient.getPositionDetails(coin);
        const currentPos = position ? Math.abs(position.amount) : 0;
        
        const lastPosKey = `tp:lastPosition:${coin}`;
        await store.set(lastPosKey, currentPos.toString());
        
        logger.info(`[TPHandler] Initialized position tracking for ${coin}: ${currentPos}`);
      } catch (error) {
        logger.error(`[TPHandler] Error initializing position for ${coin}`, error);
      }
    }
  }

  /**
   * Check if we're in shutdown state
   */
  isInShutdown() {
    return this.isShuttingDown;
  }
}

module.exports = new TakeProfitHandler();