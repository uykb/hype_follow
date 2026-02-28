const logger = require('../utils/logger');
const config = require('config');
const binanceClient = require('../binance/api-client');
const orderMapper = require('./order-mapper');
const positionTracker = require('./position-tracker');
const consistencyEngine = require('./consistency-engine');
const riskControl = require('./risk-control');
const positionCalculator = require('./position-calculator');
const dataCollector = require('../monitoring/data-collector'); // Import DataCollector

class OrderExecutor {
  
  /**
   * Automatically adjusts the Take Profit (closeAllOnSell) order size when position changes
   * This should be called after any successful buy order fill on Binance
   * @param {string} coin 
   * @param {string} userAddress
   */
  async adjustTakeProfitOrder(coin, userAddress) {
    try {
      const redis = require('../utils/redis');
      const tpOrderId = await redis.get(`exposure:tp:${coin}`);
      
      if (!tpOrderId) {
        logger.debug(`[OrderExecutor] No tracked TP order found for ${coin} to adjust.`);
        return;
      }

      logger.info(`[OrderExecutor] Auto-adjusting TP order ${tpOrderId} for ${coin} due to position change...`);

      // 1. Get original HL order mapping to find the original target price
      const mapping = await orderMapper.getHyperliquidOrder(tpOrderId);
      if (!mapping) {
        logger.warn(`[OrderExecutor] Cannot adjust TP order ${tpOrderId}: Mapping lost.`);
        // We might want to remove tracking if mapping is permanently gone, but leave it for now
        return;
      }

      // 2. Get current Binance position
      const currentPos = await binanceClient.getPosition(coin);
      const absPos = Math.abs(currentPos);
      
      if (absPos === 0) {
         logger.info(`[OrderExecutor] Position for ${coin} is 0. TP order adjustment skipped (should be canceled/filled separately).`);
         return;
      }

      // 3. Get the Binance order to find its current price
      const symbol = binanceClient.getBinanceSymbol(coin);
      const binanceOrder = await binanceClient.client.futuresGetOrder({
        symbol: symbol,
        orderId: tpOrderId.toString()
      });
      
      const currentPrice = binanceOrder.price;
      const currentSide = binanceOrder.side;

      // 4. Update the order atomically
      logger.info(`[OrderExecutor] Adjusting ${coin} TP Order ${tpOrderId} to new size ${absPos}`);
      const newBinanceOrder = await binanceClient.cancelReplaceOrder(
        coin,
        tpOrderId,
        currentSide === 'BUY' ? 'B' : 'A', // convert back to standard side format for client
        currentPrice, // keep same price
        absPos,       // NEW QUANTITY: full current position
        true          // ALWAYS reduceOnly for TP
      );

      if (newBinanceOrder && newBinanceOrder.orderId) {
        // Update mappings
        await orderMapper.deleteMapping(userAddress, mapping.oid);
        await orderMapper.saveMapping(userAddress, mapping.oid, newBinanceOrder.orderId, symbol);
        
        // Update Tracking
        await redis.set(`exposure:tp:${coin}`, newBinanceOrder.orderId);
        logger.info(`[OrderExecutor] TP Order successfully auto-adjusted: ${tpOrderId} -> ${newBinanceOrder.orderId}`);
      }
    } catch (error) {
      // If error is unknown order, maybe it just filled. Clean up tracking.
      if (error.code === -2011) {
        logger.info(`[OrderExecutor] TP Order ${coin} no longer active. Removing tracking.`);
        const redis = require('../utils/redis');
        await redis.del(`exposure:tp:${coin}`);
      } else {
        logger.error(`[OrderExecutor] Failed to auto-adjust TP order for ${coin}`, error);
      }
    }
  }

  /**
   * Sync all orders for a specific user (address 2)
   * @param {string} userAddress 
   */
  async syncUserOrders(userAddress) {
    try {
      const redis = require('../utils/redis');
      const apiClient = require('../hyperliquid/api-client');
      
      logger.info(`[OrderExecutor] Starting sync for user ${userAddress}...`);
      
      // 1. Get current Binance position for this user
      let position = await binanceClient.getPositionDetails('HYPE');
      let currentPos = position ? position.amount : 0;
      
      // 2. Get all open orders from Hyperliquid for this user
      let hlOrders = await apiClient.getUserOpenOrders(userAddress, 'HYPE');
      
      // 2.1 Check if there are buy orders (new positions opening)
      const hasBuyOrder = hlOrders && hlOrders.length > 0 && hlOrders.some(o => o.side === 'B');
      
      // 2.2 Get the last known HL orders from Redis to compare (for time difference detection)
      const lastHlOrdersStr = await redis.get(`martingale:last_hl_orders:${userAddress}`);
      const lastHlOrders = lastHlOrdersStr ? JSON.parse(lastHlOrdersStr) : [];
      const lastBuyOrderIds = new Set(lastHlOrders.filter(o => o.side === 'B').map(o => o.oid));
      
      // 2.3 Check if this is a truly NEW buy order (not just a sync delay)
      // A new buy order means the OID is not in the last known orders
      const newBuyOrders = hasBuyOrder ? hlOrders.filter(o => o.side === 'B' && !lastBuyOrderIds.has(o.oid.toString())) : [];
      const isNewPositionCycle = newBuyOrders.length > 0;
      
      if (!hlOrders || hlOrders.length === 0) {
        logger.info(`[OrderExecutor] No open orders found for user ${userAddress}`);
        // No orders in HL - clean up all existing Binance orders for this coin
        await this.cleanupAllBinanceOrders('HYPE', userAddress);
        
        // 2.4 Enter polling loop - wait for new position to appear
        logger.info(`[OrderExecutor] Entering polling loop to wait for new position...`);
        const hasNewPosition = await this.waitForNewPosition(userAddress, 'HYPE');
        
        if (hasNewPosition) {
          logger.info(`[OrderExecutor] New position detected, continuing sync...`);
          // Get fresh data after position appears
          position = await binanceClient.getPositionDetails('HYPE');
          currentPos = position ? position.amount : 0;
          hlOrders = await apiClient.getUserOpenOrders(userAddress, 'HYPE');
        } else {
          logger.info(`[OrderExecutor] No new position after timeout, exiting sync`);
          return;
        }
      }
      
      // 2.5 If there are truly NEW buy orders (new position cycle), clean up old orders first
      if (isNewPositionCycle) {
        logger.info(`[OrderExecutor] Detected NEW buy order (new cycle) - cleaning up old orders first`);
        await this.cleanupAllBinanceOrders('HYPE', userAddress);
      }
      
      // 2.6 Update the last known HL orders in Redis
      if (hlOrders && hlOrders.length > 0) {
        await redis.set(`martingale:last_hl_orders:${userAddress}`, JSON.stringify(hlOrders), 'EX', 86400);
      }
      
      // 3. Process each order
      for (const hlOrder of hlOrders) {
        // Skip if already processed
        if (await consistencyEngine.isOrderProcessed(hlOrder.oid)) {
          continue;
        }
        
        // Standardize order
        const standardizedOrder = {
          type: 'order',
          status: 'open',
          coin: hlOrder.coin,
          side: hlOrder.side,
          limitPx: hlOrder.limitPx,
          sz: hlOrder.sz,
          oid: hlOrder.oid,
          timestamp: hlOrder.timestamp,
          userAddress: userAddress
        };
        
        // For sell orders (reduce-only), calculate quantity based on current position
        if (standardizedOrder.side === 'A') {
          // For sell orders, we use the current position to calculate quantity
          // This ensures we don't sell more than we have
          const sellQuantity = Math.abs(currentPos);
          
          if (sellQuantity > 0) {
            // Create reduce-only sell order
            const binanceOrder = await binanceClient.createLimitOrder(
              hlOrder.coin, 'A', hlOrder.limitPx, sellQuantity, true
            );
            
            if (binanceOrder && binanceOrder.orderId) {
              const symbol = binanceClient.getBinanceSymbol(hlOrder.coin);
              await orderMapper.saveMapping(userAddress, hlOrder.oid, binanceOrder.orderId, symbol);
              await consistencyEngine.markOrderProcessed(hlOrder.oid, {
                type: 'limit',
                coin: hlOrder.coin,
                side: hlOrder.side,
                masterSize: parseFloat(hlOrder.sz),
                totalMasterSize: parseFloat(hlOrder.sz),
                followerSize: sellQuantity,
                price: hlOrder.limitPx,
                binanceOrderId: binanceOrder.orderId
              });
              logger.info(`[OrderExecutor] Synced sell order ${hlOrder.oid} with quantity ${sellQuantity}`);
            }
          }
        } else {
          // For buy orders, use normal calculation
          const result = await this.executeLimitOrder(standardizedOrder);
          
          // After buy order is executed, we need to sync and update take-profit order
          // This ensures the TP order matches the new position after averaging down
          await this.syncAndUpdateTakeProfit(userAddress, 'HYPE');
        }
      }
      
      // 4. Clean up zombie orders (orders on Binance that don't exist on Hyperliquid)
      await this.cleanupZombieOrders(userAddress, 'HYPE');
      
      logger.info(`[OrderExecutor] Sync completed for user ${userAddress}`);
      
    } catch (error) {
      logger.error(`[OrderExecutor] Failed to sync user orders`, error);
    }
  }

  /**
   * Sync and update take-profit order for a specific user and coin
   * This is called after a buy order (add position) to adjust TP accordingly
   * @param {string} userAddress 
   * @param {string} coin 
   */
  async syncAndUpdateTakeProfit(userAddress, coin) {
    try {
      const redis = require('../utils/redis');
      const apiClient = require('../hyperliquid/api-client');
      
      logger.info(`[OrderExecutor] Syncing take-profit orders for ${userAddress} on ${coin}...`);
      
      // 1. Get current Binance position
      const position = await binanceClient.getPositionDetails(coin);
      const currentPos = position ? position.amount : 0;
      
      if (currentPos <= 0) {
        logger.info(`[OrderExecutor] No position for ${coin}, skipping TP sync`);
        return;
      }
      
      // 2. Get all open orders from Hyperliquid for this user and coin
      const hlOrders = await apiClient.getUserOpenOrders(userAddress, coin);
      
      // 2.1 Get the last known TP info from Redis to check if TP changed
      const lastTpInfoStr = await redis.get(`martingale:last_tp:${userAddress}:${coin}`);
      const lastTpInfo = lastTpInfoStr ? JSON.parse(lastTpInfoStr) : null;
      
      // 3. Find the take-profit order (sell order with highest price)
      let tpOrder = null;
      let maxTpPrice = 0;
      
      for (const order of hlOrders) {
        if (order.side === 'A' && order.limitPx > maxTpPrice) {
          maxTpPrice = order.limitPx;
          tpOrder = order;
        }
      }
      
      // 3.1 Check if TP order has changed (price or existence)
      // This avoids sync issues due to time difference between platforms
      const hasTpChanged = !lastTpInfo || 
        (tpOrder && (!lastTpInfo.oid || tpOrder.oid.toString() !== lastTpInfo.oid.toString())) ||
        (!tpOrder && lastTpInfo.oid) ||
        (tpOrder && lastTpInfo.oid && tpOrder.limitPx !== lastTpInfo.price);
      
      if (!hasTpChanged && lastTpInfo && lastTpInfo.orderId) {
        // TP hasn't changed, check if we still have a valid TP order on Binance
        try {
          const binanceOrder = await binanceClient.client.futuresGetOrder({
            symbol: binanceClient.getBinanceSymbol(coin),
            orderId: lastTpInfo.orderId.toString()
          });
          
          if (binanceOrder && binanceOrder.status === 'NEW') {
            logger.info(`[OrderExecutor] TP order ${lastTpInfo.orderId} unchanged and active, skipping update`);
            return;
          }
        } catch (err) {
          // Order not found or not active, need to recreate
          logger.debug(`[OrderExecutor] Existing TP order not active, will recreate`);
        }
      }
      
      // 4. Get existing TP order ID from Redis
      const existingTpOrderId = await redis.get(`exposure:tp:${coin}`);
      
      if (!tpOrder) {
        // No TP order in HL, cancel existing TP if any
        if (existingTpOrderId) {
          try {
            await binanceClient.cancelOrder(binanceClient.getBinanceSymbol(coin), existingTpOrderId);
            await redis.del(`exposure:tp:${coin}`);
            logger.info(`[OrderExecutor] Cancelled TP order ${existingTpOrderId} (no TP in HL)`);
          } catch (err) {
            logger.warn(`[OrderExecutor] Failed to cancel TP order`, err);
          }
        }
        
        // Update last TP info
        await redis.set(`martingale:last_tp:${userAddress}:${coin}`, JSON.stringify({ oid: null, price: null, orderId: null }), 'EX', 86400);
        return;
      }
      
      // 5. Calculate new TP quantity based on current position
      const tpQuantity = Math.abs(currentPos);
      
      // 6. If there's an existing TP order, cancel and replace
      if (existingTpOrderId) {
        try {
          // Try to cancel existing TP order
          await binanceClient.cancelOrder(binanceClient.getBinanceSymbol(coin), existingTpOrderId);
          logger.info(`[OrderExecutor] Cancelled existing TP order ${existingTpOrderId}`);
        } catch (err) {
          // Order might already be filled or cancelled, that's ok
          logger.debug(`[OrderExecutor] Could not cancel existing TP order`, err.message);
        }
      }
      
      // 7. Create new TP order with updated quantity
      const binanceOrder = await binanceClient.createLimitOrder(
        coin, 'A', tpOrder.limitPx, tpQuantity, true // reduceOnly
      );
      
      if (binanceOrder && binanceOrder.orderId) {
        // Update TP tracking
        await redis.set(`exposure:tp:${coin}`, binanceOrder.orderId.toString());
        
        // Update last TP info
        await redis.set(`martingale:last_tp:${userAddress}:${coin}`, JSON.stringify({
          oid: tpOrder.oid.toString(),
          price: tpOrder.limitPx,
          orderId: binanceOrder.orderId.toString()
        }), 'EX', 86400);
        
        // Update mapping
        const symbol = binanceClient.getBinanceSymbol(coin);
        await orderMapper.saveMapping(userAddress, tpOrder.oid, binanceOrder.orderId, symbol);
         
        logger.info(`[OrderExecutor] Updated TP order: ${binanceOrder.orderId} for ${tpQuantity} ${coin} @ ${tpOrder.limitPx}`);
      }
      
    } catch (error) {
      logger.error(`[OrderExecutor] Failed to sync/update take-profit`, error);
    }
  }

  /**
   * Clean up zombie orders for a specific user and coin
   * @param {string} userAddress 
   * @param {string} coin 
   */
  async cleanupZombieOrders(userAddress, coin) {
    try {
      const redis = require('../utils/redis');
      const apiClient = require('../hyperliquid/api-client');
      
      // Get all Binance open orders for this user and coin
      const binanceOrders = await binanceClient.client.futuresOpenOrders();
      const userOrders = binanceOrders.filter(o => 
        o.symbol === binanceClient.getBinanceSymbol(coin) &&
        o.side === 'SELL' // Only check sell orders for zombie cleanup
      );
      
      // Get all open orders from Hyperliquid for this user and coin
      const hlOrders = await apiClient.getUserOpenOrders(userAddress, coin);
      
      // Create a set of HL order IDs
      const hlOrderIds = new Set(hlOrders.map(o => o.oid.toString()));
      
      // Cancel orders that exist on Binance but not on Hyperliquid
      for (const binanceOrder of userOrders) {
        // Check if this order has a mapping
        const mapping = await orderMapper.getHyperliquidOrder(binanceOrder.orderId);
        
        if (mapping) {
          // If it has a mapping but the HL order doesn't exist anymore, cancel it
          if (!hlOrderIds.has(mapping.oid.toString())) {
            logger.info(`[OrderExecutor] Cancelling zombie order ${binanceOrder.orderId} (no corresponding HL order)`);
            try {
              await binanceClient.cancelOrder(binanceOrder.symbol, binanceOrder.orderId);
              await orderMapper.deleteMapping(userAddress, mapping.oid);
            } catch (cancelError) {
              logger.warn(`[OrderExecutor] Failed to cancel zombie order ${binanceOrder.orderId}`, cancelError);
            }
          }
        }
      }
      
    } catch (error) {
      logger.error(`[OrderExecutor] Failed to cleanup zombie orders`, error);
    }
  }

  /**
   * Clean up all Binance orders for a specific coin (when new position cycle starts)
   * This is called when we detect a new buy order, meaning a new martingale cycle
   * @param {string} coin 
   * @param {string} userAddress 
   */
  async cleanupAllBinanceOrders(coin, userAddress) {
    try {
      const redis = require('../utils/redis');
      
      logger.info(`[OrderExecutor] Cleaning up all Binance orders for ${coin}...`);
      
      // Get all open orders from Binance for this coin
      const binanceOrders = await binanceClient.client.futuresOpenOrders();
      const coinOrders = binanceOrders.filter(o => o.symbol === binanceClient.getBinanceSymbol(coin));
      
      if (coinOrders.length === 0) {
        logger.info(`[OrderExecutor] No existing orders to clean up for ${coin}`);
        return;
      }
      
      // Cancel all orders for this coin
      for (const order of coinOrders) {
        try {
          await binanceClient.cancelOrder(order.symbol, order.orderId);
          logger.info(`[OrderExecutor] Cancelled order ${order.orderId} (${order.side} ${order.origQty} @ ${order.price})`);
        } catch (cancelError) {
          logger.warn(`[OrderExecutor] Failed to cancel order ${order.orderId}`, cancelError);
        }
      }
      
      // Clean up Redis mappings for this coin (all mappings with this coin symbol)
      // Get all mapping keys
      const keys = await redis.keys(`map:h2b:${userAddress}:*`);
      for (const key of keys) {
        const val = await redis.get(key);
        if (val) {
          const parsed = JSON.parse(val);
          if (parsed.symbol === binanceClient.getBinanceSymbol(coin)) {
            await redis.del(key);
            logger.debug(`[OrderExecutor] Cleaned up mapping: ${key}`);
          }
        }
      }
      
      // Clean up TP tracking
      await redis.del(`exposure:tp:${coin}`);
      logger.info(`[OrderExecutor] Cleaned up TP tracking for ${coin}`);
      
    } catch (error) {
      logger.error(`[OrderExecutor] Failed to cleanup all Binance orders`, error);
    }
  }

  /**
   * Wait for new position to appear (polling loop)
   * This is called when no HL orders exist and we need to wait for a new position
   * @param {string} userAddress 
   * @param {string} coin 
   * @returns {Promise<boolean>} True if new position detected, false if timeout
   */
  async waitForNewPosition(userAddress, coin) {
    const MAX_WAIT_TIME = 60000; // 60 seconds max wait
    const POLL_INTERVAL = 2000; // 2 seconds between polls
    const apiClient = require('../hyperliquid/api-client');
    
    const startTime = Date.now();
    let lastPosition = 0;
    
    while (Date.now() - startTime < MAX_WAIT_TIME) {
      try {
        // Check Binance position
        const position = await binanceClient.getPositionDetails(coin);
        const currentPos = position ? position.amount : 0;
        
        // Check if position changed (new position opened)
        if (currentPos !== lastPosition && currentPos > 0) {
          logger.info(`[OrderExecutor] New position detected: ${currentPos} ${coin}`);
          return true;
        }
        
        lastPosition = currentPos;
        
        // Also check if HL has new orders
        const hlOrders = await apiClient.getUserOpenOrders(userAddress, coin);
        if (hlOrders && hlOrders.length > 0) {
          logger.info(`[OrderExecutor] New HL orders detected`);
          return true;
        }
        
        logger.debug(`[OrderExecutor] Waiting for new position... (${Math.round((MAX_WAIT_TIME - (Date.now() - startTime)) / 1000)}s remaining)`);
        
      } catch (error) {
        logger.warn(`[OrderExecutor] Error in waitForNewPosition loop`, error);
      }
      
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
    }
    
    logger.info(`[OrderExecutor] Timeout waiting for new position`);
    return false;
  }

  /**
   * Calculate enforced minimum quantity if pending delta exists
   * @param {string} coin 
   * @param {number|null} calculatedQuantity 
   * @param {string} actionType 'open' or 'close'
   */
  async getEnforcedQuantity(coin, calculatedQuantity, actionType) {
    // Only check if calculated quantity is too small (skipped)
    if (calculatedQuantity && calculatedQuantity > 0) return null;

    const pendingDelta = await positionTracker.getPendingDelta(coin);
    
    if (Math.abs(pendingDelta) > 0) {
      const configSize = config.get('trading.minOrderSize')[coin];
      let minSize = 0;
      
      if (typeof configSize === 'object') {
        minSize = configSize[actionType] || 0;
      } else {
        minSize = configSize || 0;
      }

      logger.info(`Enforcing min size ${minSize} for ${coin} due to pending delta ${pendingDelta}`);
      return minSize;
    }
    
    return null;
  }

  /**
   * Execute Limit Order
   * @param {object} orderData 
   * @param {boolean} skipRebalance
   */
  async executeLimitOrder(orderData, skipRebalance = false) {
    const { coin, side, limitPx, oid, sz, userAddress } = orderData;
    
    try {
      // 1. Consistency Check
      if (!await consistencyEngine.shouldProcessHyperOrder(userAddress, oid)) {
        return;
      }

      // 2. Calculate Total Master Size (Signed)
      const masterOrderSize = parseFloat(sz);
      const signedMasterOrderSize = side === 'B' ? masterOrderSize : -masterOrderSize;
      
      // Get Total Signed Execution Size (Master Order + Pending Delta)
      const signedTotalSize = await positionTracker.getTotalExecutionSize(coin, signedMasterOrderSize);
      const absTotalSize = Math.abs(signedTotalSize);

      // 3. Get Current Position & Calculate Follower Quantity
      const currentPos = await binanceClient.getPosition(coin);
      
      // Determine Action Type (for ratio calculation)
      const isClosing = (currentPos > 0 && side === 'A') || (currentPos < 0 && side === 'B');
      const actionType = isClosing ? 'close' : 'open';

      let quantity;
      
      // Check for user-specific strategies
      const userStrategies = config.get('trading.userStrategies') || {};
      const userStrategy = userStrategies[userAddress] && userStrategies[userAddress][coin] ? userStrategies[userAddress][coin].strategy : null;

      if (userStrategy === 'closeAllOnSell' && side === 'A') {
        // Special Martingale strategy: If selling, sell the entire current position
        const absPos = Math.abs(currentPos);
        if (absPos > 0) {
          quantity = absPos;
          logger.info(`[OrderExecutor] Applied 'closeAllOnSell' strategy for ${userAddress} on ${coin}. Selling entire position: ${quantity}`);
          // Force reduce-only to avoid opening a short position
          orderData.reduceOnly = true;
        } else {
          logger.info(`[OrderExecutor] 'closeAllOnSell' strategy skipped for ${userAddress} on ${coin}: No current position to close.`);
          quantity = 0;
        }
      } else {
        // Normal quantity calculation
        quantity = await positionCalculator.calculateQuantity(
          coin,
          Math.abs(signedMasterOrderSize), 
          userAddress,
          actionType
        );
      }

      // 3.5 Cap Quantity ONLY for Reduce-Only orders to avoid Binance -2022 error
      // If HL order is NOT reduceOnly, we allow it to exceed position (flipping)
      if (orderData.reduceOnly && quantity > 0) {
        const binanceSide = side === 'B' ? 'BUY' : 'SELL';
        const openQty = await binanceClient.getOpenOrderQuantity(coin, binanceSide);
        const absPos = Math.abs(currentPos);
        const availableToClose = Math.max(0, absPos - openQty);
        
        if (quantity > availableToClose) {
          if (availableToClose < (config.get('trading.minOrderSize')[coin] || 0)) {
             logger.warn(`[OrderExecutor] Skipping Reduce-Only order for ${coin} as position is already fully covered by open orders. (Available: ${availableToClose}, Needed: ${quantity})`);
             return;
          }
          logger.info(`[OrderExecutor] Capping Reduce-Only order for ${coin} from ${quantity} to ${availableToClose} to fit remaining position.`);
          quantity = availableToClose;
        }
      }

      // Check if we skipped due to min size
      if (!quantity || quantity <= 0) {
        
        // Try Enforced Execution (Scheme: Force Min Size if Lagging)
        const enforcedQuantity = await this.getEnforcedQuantity(coin, quantity, actionType);
        
        if (enforcedQuantity && enforcedQuantity > 0) {
          // Cap enforced quantity too if HL order is reduceOnly
          let finalEnforcedQty = enforcedQuantity;
          if (orderData.reduceOnly) {
            const binanceSide = side === 'B' ? 'BUY' : 'SELL';
            const openQty = await binanceClient.getOpenOrderQuantity(coin, binanceSide);
            const absPos = Math.abs(currentPos);
            const availableToClose = Math.max(0, absPos - openQty);
            if (finalEnforcedQty > availableToClose) {
              finalEnforcedQty = availableToClose;
            }
          }

          if (finalEnforcedQty <= 0) {
            logger.warn(`[OrderExecutor] Cannot enforce min size for ${coin} (reduceOnly) as position is exhausted.`);
          } else if (riskControl.checkPositionLimit(coin, currentPos, finalEnforcedQty)) {
            logger.info(`Force executing min size ${finalEnforcedQty} for ${coin} to clear delta`);
            
            const binanceOrder = await binanceClient.createLimitOrder(
              coin, side, limitPx, finalEnforcedQty, orderData.reduceOnly
            );
            
            if (binanceOrder && binanceOrder.orderId) {
               const symbol = binanceClient.getBinanceSymbol(coin);
               await orderMapper.saveMapping(userAddress, oid, binanceOrder.orderId, symbol);
               
               // Record Trade Stats
               dataCollector.recordTrade({
                 symbol,
                 side,
                 size: finalEnforcedQty,
                 price: limitPx,
                 latency: Date.now() - (orderData.timestamp || Date.now()),
                 type: 'limit-enforced'
               });

               await consistencyEngine.markOrderProcessed(oid, {
                type: 'limit-enforced',
                coin, side,
                masterSize: masterOrderSize,
                totalMasterSize: absTotalSize,
                followerSize: finalEnforcedQty,
                price: limitPx,
                binanceOrderId: binanceOrder.orderId
              });

               // Update Delta
               const deltaCleared = signedTotalSize - signedMasterOrderSize;
               await positionTracker.consumePendingDelta(coin, deltaCleared);

               return;
             }

          }
        }

        // Skipped and not enforced. Accumulate delta for next execution
        await positionTracker.addPendingDelta(coin, signedMasterOrderSize);
        return;
      }

      // 4. Check Risk
      if (!riskControl.checkPositionLimit(coin, currentPos, quantity)) {
        // Blocked by Risk. Target moved, we didn't. Add to Delta.
        await positionTracker.addPendingDelta(coin, signedMasterOrderSize);
        return;
      }

      // 5. Execute Order
      const binanceOrder = await binanceClient.createLimitOrder(
        coin, side, limitPx, quantity, orderData.reduceOnly || false
      );

      // 6. Post-Process
      if (binanceOrder && binanceOrder.orderId) {
        const symbol = binanceClient.getBinanceSymbol(coin);
        await orderMapper.saveMapping(userAddress, oid, binanceOrder.orderId, symbol);
        
        // Track the Take Profit order for closeAllOnSell strategy
        if (userStrategy === 'closeAllOnSell' && side === 'A') {
          const redis = require('../utils/redis');
          await redis.set(`exposure:tp:${coin}`, binanceOrder.orderId);
          logger.info(`[OrderExecutor] Tracked Take Profit order ${binanceOrder.orderId} for ${coin}`);
        }
      
        // Record Trade Stats
        dataCollector.recordTrade({
          symbol,
          side,
          size: quantity,
          price: limitPx,
          latency: Date.now() - (orderData.timestamp || Date.now()),
          type: 'limit'
        });

        await consistencyEngine.markOrderProcessed(oid, {
          type: 'limit',
          coin, side,
          masterSize: masterOrderSize,
          totalMasterSize: absTotalSize,
          followerSize: quantity,
          price: limitPx,
          binanceOrderId: binanceOrder.orderId
        });




        // 7. Update Delta
        const deltaCleared = signedTotalSize - signedMasterOrderSize;
        await positionTracker.consumePendingDelta(coin, deltaCleared);
        
        // 7.1 For address 2 (martingale), after buy order execution, sync TP order
        if (userAddress === '0xdc899ed4a80e7bbe7c86307715507c828901f196' && side === 'B') {
          await this.syncAndUpdateTakeProfit(userAddress, coin);
        }
        
        // 8. Check if we need to re-open position (Martingale strategy)
        if (userStrategy === 'closeAllOnSell' && side === 'A') {
          // After closing all positions, we should re-open with new limit order
          // This simulates the martingale strategy of re-entering at lower price
          try {
            // Get current market price for re-entry
            const ticker = await binanceClient.client.futuresPrice({ symbol: binanceClient.getBinanceSymbol(coin) });
            const currentPrice = parseFloat(ticker.price);
            
            // Calculate new limit price (slightly below current market price for better fill chance)
            const newLimitPrice = currentPrice * 0.99; // 1% below market
            
            // Calculate quantity based on new master order size (we assume HL will send new buy order)
            // For now, we place a small initial order to restart the cycle
            const restartQuantity = await positionCalculator.calculateQuantity(
              coin,
              0.001, // Small initial size to restart
              userAddress,
              'open'
            );
            
            if (restartQuantity && restartQuantity > 0) {
              const restartOrder = await binanceClient.createLimitOrder(
                coin, 'B', newLimitPrice, restartQuantity, false
              );
              
              if (restartOrder && restartOrder.orderId) {
                const symbol = binanceClient.getBinanceSymbol(coin);
                await orderMapper.saveMapping(userAddress, `martingale_restart_${Date.now()}`, restartOrder.orderId, symbol);
                logger.info(`[OrderExecutor] Martingale strategy: Restarted position with ${restartQuantity} ${coin} at ${newLimitPrice}`);
              }
            }
            
            // 9. Check for more orders from the same user (address 2)
            if (userAddress === '0xdc899ed4a80e7bbe7c86307715507c828901f196') {
              await this.syncUserOrders(userAddress);
            }
          } catch (restartError) {
            logger.warn(`[OrderExecutor] Failed to restart martingale position`, restartError);
          }
        }
      }

    } catch (error) {
      logger.error(`Failed to execute market order for ${coin}`, error);
    }
  }

  /**
   * Execute Market Order (from Fills)
   * @param {object} fillData 
   */
  async executeMarketOrder(fillData) {
    const { coin, side, sz, userAddress, px, timestamp } = fillData;
    const fillId = `fill:${coin}:${timestamp}:${sz}`;

    try {
      if (await consistencyEngine.isOrderProcessed(fillId)) {
        return;
      }

      const masterOrderSize = parseFloat(sz);
      const signedMasterOrderSize = side === 'B' ? masterOrderSize : -masterOrderSize;
      const signedTotalSize = await positionTracker.getTotalExecutionSize(coin, signedMasterOrderSize);

      const isDirectionMatch = (side === 'B' && signedTotalSize > 0) || (side === 'A' && signedTotalSize < 0);
      const absTotalSize = Math.abs(signedTotalSize);

      if (absTotalSize < 0.0000001 || !isDirectionMatch) {
        // Skip execution, update delta
        await consistencyEngine.markOrderProcessed(fillId, { status: 'skipped_net_calc' });
        await positionTracker.addPendingDelta(coin, signedMasterOrderSize);
        return;
      }

      const currentPos = await binanceClient.getPosition(coin);
      
      const isClosing = (currentPos > 0 && side === 'A') || (currentPos < 0 && side === 'B');
      const actionType = isClosing ? 'close' : 'open';

      let quantity;

      // Check for user-specific strategies
      const userStrategies = config.get('trading.userStrategies') || {};
      const userStrategy = userStrategies[userAddress] && userStrategies[userAddress][coin] ? userStrategies[userAddress][coin].strategy : null;

      if (userStrategy === 'closeAllOnSell' && side === 'A') {
        const absPos = Math.abs(currentPos);
        if (absPos > 0) {
          quantity = absPos;
          logger.info(`[OrderExecutor] Applied 'closeAllOnSell' strategy for ${userAddress} on ${coin} (Market). Selling entire position: ${quantity}`);
        } else {
          logger.info(`[OrderExecutor] 'closeAllOnSell' strategy skipped for ${userAddress} on ${coin} (Market): No current position to close.`);
          quantity = 0;
        }
      } else {
        quantity = await positionCalculator.calculateQuantity(
          coin,
          absTotalSize,
          userAddress,
          actionType
        );
      }

      if (!quantity || quantity <= 0) {
        
        // Try Enforced Execution (Scheme: Force Min Size if Lagging)
        const enforcedQuantity = await this.getEnforcedQuantity(coin, quantity, actionType);
        
        if (enforcedQuantity && enforcedQuantity > 0) {
          if (riskControl.checkPositionLimit(coin, currentPos, enforcedQuantity)) {
            logger.info(`Force executing min size ${enforcedQuantity} for ${coin} to clear delta (Market)`);
            
            const binanceOrder = await binanceClient.createMarketOrder(coin, side, enforcedQuantity, false);
            
            if (binanceOrder && binanceOrder.orderId) {
              const symbol = binanceClient.getBinanceSymbol(coin);
              await orderMapper.saveMapping(userAddress, fillId, binanceOrder.orderId, symbol);
            }
            
            // Record Trade Stats (Market)
            dataCollector.recordTrade({
                 symbol: binanceClient.getBinanceSymbol(coin),
                 side,
                 size: enforcedQuantity,
                 price: px, 
                 latency: Date.now() - (timestamp || Date.now()),
                 slippage: 0, 
                 type: 'market-enforced'
            });

             await consistencyEngine.markOrderProcessed(fillId, {
              type: 'market-enforced',
              coin, side,
              masterSize: masterOrderSize,
              totalMasterSize: absTotalSize,
              followerSize: enforcedQuantity,
              price: px, 
              binanceOrderId: binanceOrder.orderId
            });

            const deltaCleared = signedTotalSize - signedMasterOrderSize;
            await positionTracker.consumePendingDelta(coin, deltaCleared);
            return;
          }
        }

        await positionTracker.addPendingDelta(coin, signedMasterOrderSize);
        return;
      }

      if (!riskControl.checkPositionLimit(coin, currentPos, quantity)) {
        await positionTracker.addPendingDelta(coin, signedMasterOrderSize);
        return;
      }

      const binanceOrder = await binanceClient.createMarketOrder(coin, side, quantity, false);

      if (binanceOrder && binanceOrder.orderId) {
        const symbol = binanceClient.getBinanceSymbol(coin);
        await orderMapper.saveMapping(userAddress, fillId, binanceOrder.orderId, symbol);
      }

      // Record Trade Stats
      dataCollector.recordTrade({
          symbol: binanceClient.getBinanceSymbol(coin),
          side,
          size: quantity,
          price: px,
          latency: Date.now() - (timestamp || Date.now()),
          type: 'market'
      });

      await consistencyEngine.markOrderProcessed(fillId, {
        type: 'market',
        coin, side,
        masterSize: masterOrderSize,
        totalMasterSize: absTotalSize,
        followerSize: quantity,
        price: px, 
        binanceOrderId: binanceOrder.orderId
      });

      const deltaCleared = signedTotalSize - signedMasterOrderSize;
      await positionTracker.consumePendingDelta(coin, deltaCleared);

    } catch (error) {
      logger.error(`Failed to execute market order for ${coin}`, error);
    }
  }

  /**
   * Update (Modify) Limit Order
   * Uses Cancel-Replace strategy
   * @param {object} orderData 
   */
  async updateLimitOrder(orderData) {
    const { coin, side, limitPx, oid, sz, userAddress } = orderData;
    
    // Acquire lock to prevent race conditions
    const lockKey = `orderLock:${oid}`;
    const acquired = await require('../utils/redis').set(lockKey, 'true', 'NX', 'EX', 10);
    
    if (!acquired) {
      logger.debug(`[OrderExecutor] Order update for ${oid} locked, skipping.`);
      return;
    }

    try {
      const mapping = await orderMapper.getBinanceOrder(userAddress, oid);
      if (!mapping) {
        logger.warn(`[OrderExecutor] Cannot update order ${oid}: No mapping found.`);
        return;
      }

      logger.info(`[OrderExecutor] Updating order ${oid} (Binance ID: ${mapping.orderId})...`);

      // Check for user-specific strategies
      const userStrategies = config.get('trading.userStrategies') || {};
      const userStrategy = userStrategies[userAddress] && userStrategies[userAddress][coin] ? userStrategies[userAddress][coin].strategy : null;

      let quantity;
      
      if (userStrategy === 'closeAllOnSell' && side === 'A') {
         // Re-evaluate entire position for update
         const currentPos = await binanceClient.getPosition(coin);
         const absPos = Math.abs(currentPos);
         if (absPos > 0) {
           quantity = absPos;
           orderData.reduceOnly = true;
           logger.info(`[OrderExecutor] Updating 'closeAllOnSell' TP order for ${coin}. New size: ${quantity}`);
         } else {
           logger.info(`[OrderExecutor] Update 'closeAllOnSell' skipped for ${coin}: No position to close.`);
           quantity = 0;
         }
      } else {
        // 1. Calculate New Quantity
        const masterOrderSize = parseFloat(sz);
        const signedMasterOrderSize = side === 'B' ? masterOrderSize : -masterOrderSize;
        
        quantity = await positionCalculator.calculateQuantity(
          coin,
          Math.abs(signedMasterOrderSize), 
          userAddress,
          'open' 
        );
      }
      
      if (!quantity || quantity <= 0) {
        logger.warn(`[OrderExecutor] Update calculated 0 quantity for ${oid}, aborting update.`);
        return;
      }

      // 2. Perform Atomic Cancel/Replace
      try {
        const newBinanceOrder = await binanceClient.cancelReplaceOrder(
          coin,
          mapping.orderId,
          side,
          limitPx,
          quantity,
          orderData.reduceOnly || false
        );

        // 3. Update Mapping (Only if successful)
        if (newBinanceOrder && newBinanceOrder.orderId) {
          // Cleanup old mapping
          await orderMapper.deleteMapping(userAddress, oid);
          // Save new mapping
          await orderMapper.saveMapping(userAddress, oid, newBinanceOrder.orderId, mapping.symbol);
          
          logger.info(`[OrderExecutor] Order updated (Atomic): HL ${oid} -> Binance ${newBinanceOrder.orderId}`);
          
          // Track the Take Profit order for closeAllOnSell strategy
          if (userStrategy === 'closeAllOnSell' && side === 'A') {
            const redis = require('../utils/redis');
            await redis.set(`exposure:tp:${coin}`, newBinanceOrder.orderId);
            logger.info(`[OrderExecutor] Updated Take Profit tracking to order ${newBinanceOrder.orderId} for ${coin}`);
          }
          
          // Log update in history
          await consistencyEngine.markOrderProcessed(oid, {
             type: 'limit-update',
             coin, side,
             price: limitPx,
             followerSize: quantity,
             binanceOrderId: newBinanceOrder.orderId
          });
        }
      } catch (err) {
        logger.error(`[OrderExecutor] Atomic update failed for ${oid}`, err);
        // If atomic failed, state should be preserved (order not cancelled if STOP_ON_FAILURE)
        // But we need to verify. 
      }

    } catch (error) {
      logger.error(`[OrderExecutor] Failed to update order ${oid}`, error);
    } finally {
      await consistencyEngine.releaseOrderLock(oid);
    }
  }
}

module.exports = new OrderExecutor();
