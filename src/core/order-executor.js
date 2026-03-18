const logger = require('../utils/logger');
const config = require('config');
const binanceClient = require('../binance/api-client');
const orderMapper = require('./order-mapper');
const positionTracker = require('./position-tracker');
const consistencyEngine = require('./consistency-engine');
const riskControl = require('./risk-control');
const positionCalculator = require('./position-calculator');
const dataCollector = require('../monitoring/data-collector'); // Import DataCollector
const store = require('../utils/memory-store');
const apiClient = require('../hyperliquid/api-client');

class OrderExecutor {
  
  constructor() {
    this.positionMonitorActive = false;
    this.positionMonitorTimer = null;
    this.lastKnownPosition = null;
    // Debounce tracking for TP adjustments
    this.tpAdjustmentTimers = new Map();
    this.TP_ADJUSTMENT_DEBOUNCE_MS = 3000; // 3 second debounce
  }

  /**
   * Adjust Take Profit order with debouncing
   * Prevents multiple rapid adjustments when both Binance and HL fill events trigger
   * @param {string} coin 
   * @param {string} userAddress
   */
  async adjustTakeProfitOrderDebounced(coin, userAddress) {
    const key = `${coin}:${userAddress}`;
    
    // Clear existing timer if any
    if (this.tpAdjustmentTimers.has(key)) {
      clearTimeout(this.tpAdjustmentTimers.get(key));
    }
    
    // Set new timer
    return new Promise((resolve, reject) => {
      const timer = setTimeout(async () => {
        this.tpAdjustmentTimers.delete(key);
        try {
          await this.adjustTakeProfitOrder(coin, userAddress);
          resolve();
        } catch (err) {
          reject(err);
        }
      }, this.TP_ADJUSTMENT_DEBOUNCE_MS);
      
      this.tpAdjustmentTimers.set(key, timer);
    });
  }

  /**
   * Automatically adjusts the Take Profit (closeAllOnSell) order size when position changes
   * This should be called after any successful buy order fill on Binance
   * @param {string} coin 
   * @param {string} userAddress
   */
  async adjustTakeProfitOrder(coin, userAddress) {
    const ADDRESS2 = '0xdc899ed4a80e7bbe7c86307715507c828901f196';
    
    try {
      const tpOrderId = await store.get(`exposure:tp:${coin}`);
      
      if (!tpOrderId) {
        logger.debug(`[OrderExecutor] No tracked TP order found for ${coin} to adjust.`);
        return;
      }

      logger.info(`[OrderExecutor] Auto-adjusting TP order ${tpOrderId} for ${coin} due to position change...`);

      // 1. Get current Binance position
      const position = await binanceClient.getPositionDetails(coin);
      const currentPos = position ? position.amount : 0;
      const absPos = Math.abs(currentPos);
      
      if (absPos === 0) {
        // Position is 0, cancel the TP order
        try {
          const symbol = binanceClient.getBinanceSymbol(coin);
          await binanceClient.cancelOrder(symbol, tpOrderId);
          await store.del(`exposure:tp:${coin}`);
          logger.info(`[OrderExecutor] Position is 0. Cancelled TP order ${tpOrderId}`);
        } catch (cancelError) {
          logger.debug(`[OrderExecutor] Could not cancel TP order`, cancelError.message);
        }
        return;
      }

      // 2. Get latest HL open orders and find highest price SELL order
      const hlOrders = await apiClient.getUserOpenOrders(userAddress, coin);
      const sellOrders = hlOrders ? hlOrders.filter(o => o.side === 'A') : [];
      
      // 3. If no SELL orders in HL, cancel our TP order and return
      if (sellOrders.length === 0) {
        logger.info(`[OrderExecutor] No SELL orders in HL for ${coin}. Cancelling our TP order.`);
        try {
          const symbol = binanceClient.getBinanceSymbol(coin);
          await binanceClient.cancelOrder(symbol, tpOrderId);
          await store.del(`exposure:tp:${coin}`);
          logger.info(`[OrderExecutor] Cancelled TP order ${tpOrderId} (no SELL orders in HL)`);
        } catch (cancelError) {
          logger.debug(`[OrderExecutor] Could not cancel TP order`, cancelError.message);
        }
        return;
      }

      // 4. Find the highest price SELL order (TP order)
      sellOrders.sort((a, b) => parseFloat(b.limitPx) - parseFloat(a.limitPx));
      const latestTpOrder = sellOrders[0];
      const latestTpPrice = parseFloat(latestTpOrder.limitPx);
      const latestTpOid = latestTpOrder.oid;

      logger.info(`[OrderExecutor] Latest HL TP order: ${latestTpOid} - SELL @ ${latestTpPrice}`);

      // 5. Get original mapping to clean up
      const mapping = await orderMapper.getHyperliquidOrder(tpOrderId);
      const oldOid = mapping ? mapping.oid : null;

      // 6. Cancel existing TP order on Binance
      const symbol = binanceClient.getBinanceSymbol(coin);
      try {
        await binanceClient.cancelOrder(symbol, tpOrderId);
        logger.info(`[OrderExecutor] Cancelled old TP order ${tpOrderId}`);
      } catch (cancelError) {
        // Order might already be filled, that's ok
        logger.debug(`[OrderExecutor] Could not cancel old TP order`, cancelError.message);
      }

      // 7. Create new TP order with latest HL price and current position
      logger.info(`[OrderExecutor] Creating new TP order: SELL ${absPos} @ ${latestTpPrice}`);
      const newBinanceOrder = await binanceClient.createLimitOrder(
        coin,
        'A', // SELL
        latestTpPrice,
        absPos,
        true // reduceOnly
      );

      if (newBinanceOrder && newBinanceOrder.orderId) {
        // Clean up old mapping if exists
        if (oldOid) {
          await orderMapper.deleteMapping(userAddress, oldOid);
        }
        // Save new mapping
        await orderMapper.saveMapping(userAddress, latestTpOid, newBinanceOrder.orderId, symbol);
        
        // Update Tracking
        await store.set(`exposure:tp:${coin}`, newBinanceOrder.orderId);
        await store.set(`martingale:last_tp:${userAddress}:${coin}`, JSON.stringify({
          oid: latestTpOid.toString(),
          price: latestTpPrice.toString(),
          quantity: absPos,
          orderId: newBinanceOrder.orderId.toString()
        }), 'EX', 86400);
        
        logger.info(`[OrderExecutor] TP Order successfully updated: ${tpOrderId} -> ${newBinanceOrder.orderId} (price: ${latestTpPrice}, size: ${absPos})`);
      }
    } catch (error) {
      // If error is unknown order, maybe it just filled. Clean up tracking.
      if (error.code === -2011) {
        logger.info(`[OrderExecutor] TP Order ${coin} no longer active. Removing tracking.`);
        await store.del(`exposure:tp:${coin}`);
      } else {
        logger.error(`[OrderExecutor] Failed to auto-adjust TP order for ${coin}`, error);
      }
    }
  }

  /**
   * Sync all orders for a specific user (address 2)
   * @param {string} userAddress 
   */
  async syncUserOrders(userAddress, options = {}) {
    const ADDRESS2 = '0xdc899ed4a80e7bbe7c86307715507c828901f196';
    const isAddress2 = (userAddress === ADDRESS2);
    const isInitialSync = options.isInitialSync !== false; // Default to true for backward compatibility
    
    try {
      logger.info(`[OrderExecutor] Starting sync for user ${userAddress}...`);
      
      // 1. Only clean up ALL existing orders on INITIAL startup (not on every position change)
      if (isAddress2 && isInitialSync) {
        logger.info(`[OrderExecutor] Cleaning up all existing HYPE orders for address 2 (initial sync)...`);
        await this.cleanupAllBinanceOrders('HYPE', userAddress);
      } else if (isAddress2 && !isInitialSync) {
        logger.info(`[OrderExecutor] Skipping cleanup (position change sync) for address 2...`);
      }
      
      // 2. Get position
      let position = null;
      let currentPos = 0;
      let positionRetries = 5;
      
      for (let i = 0; i < positionRetries; i++) {
        position = await binanceClient.getPositionDetails('HYPE');
        currentPos = position ? position.amount : 0;
        
        if (currentPos !== 0) {
          break;
        }
        
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      logger.info(`[OrderExecutor] Current Binance position for HYPE: ${currentPos}`);
      
      await store.set(`martingale:last_position:${userAddress}`, currentPos.toString(), 'EX', 86400);
      
      // 3. Get all open orders from Hyperliquid
      let hlOrders = await apiClient.getUserOpenOrders(userAddress, 'HYPE');
      
      const sellOrders = hlOrders ? hlOrders.filter(o => o.side === 'A') : [];
      const buyOrders = hlOrders ? hlOrders.filter(o => o.side === 'B') : [];
      
      if (hlOrders && hlOrders.length > 0) {
        await store.set(`martingale:last_hl_orders:${userAddress}`, JSON.stringify(hlOrders), 'EX', 86400);
      }
      
      // 4. ONLY FOR ADDRESS2: Check HL position status if no position on Binance
      if (isAddress2 && currentPos === 0) {
        logger.info(`[OrderExecutor] Address 2: Binance has NO position, checking HL position status...`);
        
        try {
          const hlPositions = await apiClient.getUserPositions(userAddress);
          const hlPosition = hlPositions.find(p => p.coin === 'HYPE');
          
          if (hlPosition && Math.abs(hlPosition.amount) > 0) {
            let currentPrice = 0;
            try {
              const ticker = await binanceClient.client.futuresPrice({ symbol: binanceClient.getBinanceSymbol('HYPE') });
              currentPrice = parseFloat(ticker.price);
            } catch (priceError) {
              logger.warn(`[OrderExecutor] Failed to get current price`, priceError);
            }
            
            const hlEntryPrice = parseFloat(hlPosition.entryPx) || 0;
            const hlSize = Math.abs(hlPosition.amount);
            
            logger.info(`[OrderExecutor] Address 2 HL Position - Size: ${hlSize}, Entry: ${hlEntryPrice}, Current: ${currentPrice}`);
            
            // Calculate position size based on FIXED RATIO, NOT the exact HL position
            // This prevents excessive position size that could lead to liquidation
            const tradingMode = config.get('trading.mode');
            const fixedRatio = config.get('trading.fixedRatio');
            const equalRatio = config.get('trading.equalRatio');
            
            let followSize;
            if (tradingMode === 'fixed') {
              followSize = hlSize * fixedRatio;
            } else if (tradingMode === 'equal') {
              // For equal mode, calculate based on HL position * equalRatio
              followSize = hlSize * equalRatio;
            } else {
              followSize = hlSize * fixedRatio; // Default to fixed
            }
            
            // Apply maximum position limit to prevent liquidation risk
            const maxPositionSize = config.get('trading.maxPositionSize') || {};
            const maxHypeSize = maxPositionSize.HYPE || 100.0; // Default max 100 HYPE
            if (followSize > maxHypeSize) {
              logger.warn(`[OrderExecutor] Calculated follow size ${followSize} exceeds max ${maxHypeSize}, capping...`);
              followSize = maxHypeSize;
            }
            
            // Round to precision
            followSize = Math.round(followSize * 10000) / 10000;
            
            logger.info(`[OrderExecutor] Calculated follow size using ${tradingMode} ratio: ${followSize} HYPE (HL: ${hlSize}, ratio: ${tradingMode === 'fixed' ? fixedRatio : equalRatio})`);
            
            // Regardless of profit/loss, we need to sync HL's limit orders to Binance
            // Get the lowest BUY order from HL to create matching limit order on Binance
            const hlOpenOrders = await apiClient.getUserOpenOrders(userAddress, 'HYPE');
            const hlBuyOrders = hlOpenOrders ? hlOpenOrders.filter(o => o.side === 'B') : [];
            
            if (hlBuyOrders.length > 0) {
              // Sort by price (ascending) to get the lowest price BUY order
              hlBuyOrders.sort((a, b) => parseFloat(a.limitPx) - parseFloat(b.limitPx));
              const targetOrder = hlBuyOrders[0];
              
              // Calculate follow size based on this order using ratio
              const orderSize = parseFloat(targetOrder.sz);
              let syncSize;
              if (tradingMode === 'fixed') {
                syncSize = orderSize * fixedRatio;
              } else {
                syncSize = orderSize * equalRatio;
              }
              
              // Apply max position limit
              const maxPositionSizeCfg = config.get('trading.maxPositionSize') || {};
              const maxHypeSizeCfg = maxPositionSizeCfg.HYPE || 100.0;
              if (syncSize > maxHypeSizeCfg) {
                syncSize = maxHypeSizeCfg;
              }
              syncSize = Math.round(syncSize * 10000) / 10000;
              
              const limitPrice = parseFloat(targetOrder.limitPx);
              
              logger.info(`[OrderExecutor] Syncing HL order: BUY ${syncSize} @ ${limitPrice} (HL oid: ${targetOrder.oid})`);
              
              try {
                // Create limit order on Binance matching HL's order
                const limitOrder = await binanceClient.createLimitOrder('HYPE', 'B', limitPrice, syncSize, false);
                if (limitOrder && limitOrder.orderId) {
                  const symbol = binanceClient.getBinanceSymbol('HYPE');
                  await orderMapper.saveMapping(userAddress, targetOrder.oid, limitOrder.orderId, symbol);
                  
                  // Track this sync order in Redis for future updates
                  await store.set(`martingale:synced_order:${userAddress}:HYPE`, JSON.stringify({
                    hlOid: targetOrder.oid.toString(),
                    binanceOrderId: limitOrder.orderId.toString(),
                    price: limitPrice,
                    quantity: syncSize,
                    side: 'B',
                    syncedAt: Date.now()
                  }), 'EX', 86400);
                  
                  logger.info(`[OrderExecutor] Created sync limit order: ${limitOrder.orderId} for ${syncSize} @ ${limitPrice}`);
                }
              } catch (limitError) {
                logger.error(`[OrderExecutor] Failed to create sync limit order`, limitError);
              }
            }
            
            // Also handle TP (SELL) orders if position exists
            const hlSellOrders = hlOpenOrders ? hlOpenOrders.filter(o => o.side === 'A') : [];
            if (hlSellOrders.length > 0 && followSize > 0) {
              // Sort by price (descending) to get highest price SELL order (TP)
              hlSellOrders.sort((a, b) => parseFloat(b.limitPx) - parseFloat(a.limitPx));
              const tpOrder = hlSellOrders[0];
              
              // Get actual Binance position for TP quantity (not HL ratio)
              const binancePosition = await binanceClient.getPositionDetails('HYPE');
              const tpQuantity = binancePosition ? Math.abs(binancePosition.amount) : 0;
              
              if (tpQuantity > 0) {
                logger.info(`[OrderExecutor] Creating TP order: SELL ${tpQuantity} @ ${tpOrder.limitPx} (Binance position)`);
                
                try {
                  const tpLimitOrder = await binanceClient.createLimitOrder('HYPE', 'A', parseFloat(tpOrder.limitPx), tpQuantity, true);
                  if (tpLimitOrder && tpLimitOrder.orderId) {
                    const symbol = binanceClient.getBinanceSymbol('HYPE');
                    await orderMapper.saveMapping(userAddress, tpOrder.oid, tpLimitOrder.orderId, symbol);
                    await store.set(`exposure:tp:HYPE`, tpLimitOrder.orderId.toString());
                    await store.set(`martingale:last_tp:${userAddress}:HYPE`, JSON.stringify({
                      oid: tpOrder.oid.toString(),
                      price: tpOrder.limitPx,
                      quantity: tpQuantity,
                      orderId: tpLimitOrder.orderId.toString()
                    }), 'EX', 86400);
                    
                    logger.info(`[OrderExecutor] Created TP order: ${tpLimitOrder.orderId}`);
                  }
                } catch (tpError) {
                  logger.error(`[OrderExecutor] Failed to create TP order`, tpError);
                }
              } else {
                logger.info(`[OrderExecutor] No Binance position, skipping TP order creation`);
              }
            }
          }
        } catch (hlError) {
          logger.warn(`[OrderExecutor] Failed to get HL position`, hlError);
        }
      }
      
      if (!hlOrders || hlOrders.length === 0) {
        logger.info(`[OrderExecutor] No open orders for ${userAddress}`);
        if (isAddress2) {
          await this.cleanupAllBinanceOrders('HYPE', userAddress);
          const hasNewPosition = await this.waitForNewPosition(userAddress, 'HYPE');
          if (hasNewPosition) {
            position = await binanceClient.getPositionDetails('HYPE');
            currentPos = position ? position.amount : 0;
            hlOrders = await apiClient.getUserOpenOrders(userAddress, 'HYPE');
            sellOrders = hlOrders ? hlOrders.filter(o => o.side === 'A') : [];
            buyOrders = hlOrders ? hlOrders.filter(o => o.side === 'B') : [];
          } else {
            return;
          }
        } else {
          return;
        }
      }
      
      // 5. Skip SELL TP order creation here - let syncAndUpdateTakeProfit handle it
      // This ensures proper tracking and avoids duplicate TP creation
      
      // 6. Process BUY orders - for address 2, force resync all orders
      for (const hlOrder of buyOrders) {
        // For address 2, always resync to ensure proper ratio calculation
        if (isAddress2) {
          // Skip if already processed but we want to force recalculate
          // Actually, for address 2 we should force recalculate, so we'll skip the check
        } else {
          if (await consistencyEngine.isOrderProcessed(hlOrder.oid)) {
            continue;
          }
        }
        
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
        
        await this.executeLimitOrder(standardizedOrder);
      }
      
      // 6.1 Sync TP after processing (either BUY orders or just TP update)
      if (isAddress2 && (buyOrders.length > 0 || sellOrders.length > 0)) {
        // Add a small delay to allow position to update in Binance
        await new Promise(resolve => setTimeout(resolve, 1000));
        await this.syncAndUpdateTakeProfit(userAddress, 'HYPE');
      }
      
      // 7. Cleanup zombie orders
      if (isAddress2) {
        await this.cleanupZombieOrders(userAddress, 'HYPE');
      }
      
      logger.info(`[OrderExecutor] Sync completed for ${userAddress}`);
      
      // 8. Start position monitoring only for address 2
      if (isAddress2) {
        this.startPositionMonitoring(userAddress);
      }

    } catch (error) {
      logger.error(`[OrderExecutor] Failed to sync user orders`, error);
    }
  }

  /**
   * Start monitoring position changes for address 2
   * This monitors Binance position and syncs HL orders when position changes significantly
   * @param {string} userAddress 
   */
  startPositionMonitoring(userAddress) {
    const ADDRESS2 = '0xdc899ed4a80e7bbe7c86307715507c828901f196';
    if (userAddress !== ADDRESS2) return;

    const coin = 'HYPE';
    const checkInterval = 5000; // Check every 5 seconds
    const POSITION_CHANGE_THRESHOLD = 0.01; // 0.01 HYPE (increased from 0.001)

    const checkPosition = async () => {
      try {
        const position = await binanceClient.getPositionDetails(coin);
        // Round to 4 decimal places to avoid floating point precision issues
        const currentPos = Math.round((position ? position.amount : 0) * 10000) / 10000;

        if (this.lastKnownPosition === null) {
          this.lastKnownPosition = currentPos;
          logger.info(`[PositionMonitor] Initial position for ${coin}: ${currentPos}`);
          return;
        }

        const positionDiff = Math.abs(currentPos - this.lastKnownPosition);

        if (positionDiff >= POSITION_CHANGE_THRESHOLD) {
          logger.info(`[PositionMonitor] Position changed: ${this.lastKnownPosition} -> ${currentPos} (diff: ${positionDiff}). Triggering order sync...`);
          
          // Check if position went from > 0 to 0 (order filled/closed)
          const wasPositionOpen = this.lastKnownPosition > 0;
          const isPositionClosed = currentPos === 0;
          
          // Check if position went from 0 to > 0 (new position opened)
          const wasNoPosition = this.lastKnownPosition === 0;
          const hasNewPosition = currentPos > 0;
          
          await this.syncUserOrders(userAddress, { isInitialSync: false });
          
          // Update last known position after sync
          this.lastKnownPosition = currentPos;
        }
      } catch (error) {
        logger.error(`[PositionMonitor] Error checking position`, error);
      }
    };

    if (!this.positionMonitorActive) {
      this.positionMonitorActive = true;
      this.positionMonitorTimer = setInterval(checkPosition, checkInterval);
      logger.info(`[PositionMonitor] Started monitoring ${coin} position for ${userAddress}`);
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
      const lastTpInfoStr = await store.get(`martingale:last_tp:${userAddress}:${coin}`);
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
      // Also check if quantity has changed (position might have changed)
      const lastQty = lastTpInfo ? lastTpInfo.quantity : 0;
      const hasTpChanged = !lastTpInfo || 
        (tpOrder && (!lastTpInfo.oid || tpOrder.oid.toString() !== lastTpInfo.oid.toString())) ||
        (!tpOrder && lastTpInfo.oid) ||
        (tpOrder && lastTpInfo.oid && (tpOrder.limitPx !== lastTpInfo.price || Math.abs(currentPos - lastQty) > 0.01));
      
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
      const existingTpOrderId = await store.get(`exposure:tp:${coin}`);
      
      if (!tpOrder) {
        // No TP order in HL, cancel existing TP if any
        if (existingTpOrderId) {
          try {
            await binanceClient.cancelOrder(binanceClient.getBinanceSymbol(coin), existingTpOrderId);
            await store.del(`exposure:tp:${coin}`);
            logger.info(`[OrderExecutor] Cancelled TP order ${existingTpOrderId} (no TP in HL)`);
          } catch (err) {
            logger.warn(`[OrderExecutor] Failed to cancel TP order`, err);
          }
        }
        
        // Update last TP info
        await store.set(`martingale:last_tp:${userAddress}:${coin}`, JSON.stringify({ oid: null, price: null, orderId: null }), 'EX', 86400);
        return;
      }
      
      // 5. Calculate new TP quantity based on current position
      const tpQuantity = Math.abs(currentPos);
      
      // 5.1 Double-check position exists before placing reduceOnly order
      if (tpQuantity <= 0) {
        logger.info(`[OrderExecutor] Position is 0 or negative, skipping TP order creation`);
        if (existingTpOrderId) {
          try {
            await binanceClient.cancelOrder(binanceClient.getBinanceSymbol(coin), existingTpOrderId);
            await store.del(`exposure:tp:${coin}`);
            logger.info(`[OrderExecutor] Cancelled TP order ${existingTpOrderId} (no position)`);
          } catch (err) {
            logger.warn(`[OrderExecutor] Failed to cancel TP order`, err);
          }
        }
        return;
      }
      
      // 6. If there's an existing TP order, check if we need to update it
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
      try {
        const binanceOrder = await binanceClient.createLimitOrder(
          coin, 'A', tpOrder.limitPx, tpQuantity, true // reduceOnly
        );
        
        if (binanceOrder && binanceOrder.orderId) {
          // Update TP tracking
          await store.set(`exposure:tp:${coin}`, binanceOrder.orderId.toString());
          
          // Update last TP info (including quantity)
          await store.set(`martingale:last_tp:${userAddress}:${coin}`, JSON.stringify({
            oid: tpOrder.oid.toString(),
            price: tpOrder.limitPx,
            quantity: currentPos, // Store the position quantity
            orderId: binanceOrder.orderId.toString()
          }), 'EX', 86400);
          
          // Update mapping
          const symbol = binanceClient.getBinanceSymbol(coin);
          await orderMapper.saveMapping(userAddress, tpOrder.oid, binanceOrder.orderId, symbol);
          
          logger.info(`[OrderExecutor] Updated TP order: ${binanceOrder.orderId} for ${tpQuantity} ${coin} @ ${tpOrder.limitPx}`);
        }
      } catch (orderError) {
        // Handle reduceOnly error - TP order likely already exists with same/different quantity
        if (orderError.code === -2022) {
          logger.info(`[OrderExecutor] ReduceOnly rejected, TP order may already exist. Checking existing order...`);
          
          // Check if we already have a TP order in Redis that might work
          const existingTpOrderId = await store.get(`exposure:tp:${coin}`);
          if (existingTpOrderId) {
            try {
              const existingOrder = await binanceClient.client.futuresGetOrder({
                symbol: binanceClient.getBinanceSymbol(coin),
                orderId: existingTpOrderId.toString()
              });
              
              if (existingOrder && existingOrder.status === 'NEW') {
                logger.info(`[OrderExecutor] Existing TP order ${existingTpOrderId} is active, keeping it.`);
                // Update the last tp info to prevent future sync attempts
                await store.set(`martingale:last_tp:${userAddress}:${coin}`, JSON.stringify({
                  oid: tpOrder.oid.toString(),
                  price: tpOrder.limitPx,
                  quantity: currentPos,
                  orderId: existingTpOrderId.toString()
                }), 'EX', 86400);
                return;
              }
            } catch (checkErr) {
              logger.debug(`[OrderExecutor] Could not check existing TP order`, checkErr.message);
            }
          }
          
          // If we get here, we need to cancel the existing order and retry
          logger.info(`[OrderExecutor] Cancelling existing TP and retrying...`);
          if (existingTpOrderId) {
            try {
              await binanceClient.cancelOrder(binanceClient.getBinanceSymbol(coin), existingTpOrderId);
              await store.del(`exposure:tp:${coin}`);
            } catch (cancelErr) {
              logger.debug(`[OrderExecutor] Could not cancel existing TP`, cancelErr.message);
            }
          }
          
          // Retry once after cancel
          const retryOrder = await binanceClient.createLimitOrder(
            coin, 'A', tpOrder.limitPx, tpQuantity, true
          );
          
          if (retryOrder && retryOrder.orderId) {
            await store.set(`exposure:tp:${coin}`, retryOrder.orderId.toString());
            await store.set(`martingale:last_tp:${userAddress}:${coin}`, JSON.stringify({
              oid: tpOrder.oid.toString(),
              price: tpOrder.limitPx,
              quantity: currentPos,
              orderId: retryOrder.orderId.toString()
            }), 'EX', 86400);
            
            const symbol = binanceClient.getBinanceSymbol(coin);
            await orderMapper.saveMapping(userAddress, tpOrder.oid, retryOrder.orderId, symbol);
            
            logger.info(`[OrderExecutor] Created TP order after retry: ${retryOrder.orderId}`);
          }
        } else {
          throw orderError;
        }
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
      const keys = await store.keys(`map:h2b:${userAddress}:*`);
      for (const key of keys) {
        const val = await store.get(key);
        if (val) {
          const parsed = JSON.parse(val);
          if (parsed.symbol === binanceClient.getBinanceSymbol(coin)) {
            await store.del(key);
            logger.debug(`[OrderExecutor] Cleaned up mapping: ${key}`);
          }
        }
      }
      
      // Clean up TP tracking
      await store.del(`exposure:tp:${coin}`);
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
          await store.set(`exposure:tp:${coin}`, binanceOrder.orderId);
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
        
        // 7.1 TP sync is now handled in syncUserOrders after all BUY orders are processed
        // Removed duplicate call here to prevent reduceOnly errors during bulk order processing
        
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
              await this.syncUserOrders(userAddress, { isInitialSync: false });
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
    const acquired = await require('../utils/memory-store').set(lockKey, 'true', 'NX', 'EX', 10);
    
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
            await store.set(`exposure:tp:${coin}`, newBinanceOrder.orderId);
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
