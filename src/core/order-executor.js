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

      let quantity = await positionCalculator.calculateQuantity(
        coin,
        Math.abs(signedMasterOrderSize), 
        userAddress,
        actionType
      );

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
      }

    } catch (error) {
      logger.error(`Failed to execute limit order ${oid}`, error);
    } finally {
      // Always release the lock
      await consistencyEngine.releaseOrderLock(userAddress, oid);
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

      let quantity = await positionCalculator.calculateQuantity(
        coin,
        absTotalSize,
        userAddress,
        actionType
      );

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

      // 1. Calculate New Quantity
      const masterOrderSize = parseFloat(sz);
      const signedMasterOrderSize = side === 'B' ? masterOrderSize : -masterOrderSize;
      
      let quantity = await positionCalculator.calculateQuantity(
        coin,
        Math.abs(signedMasterOrderSize), 
        userAddress,
        'open' 
      );
      
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
