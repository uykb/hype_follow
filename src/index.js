const config = require('config');
const logger = require('./utils/logger');
const redis = require('./utils/redis');
const hyperWs = require('./hyperliquid/ws-client');
const binanceClient = require('./binance/api-client');
const orderMapper = require('./core/order-mapper');
const orderValidator = require('./core/order-validator');
const apiValidator = require('./utils/api-validator');
const { startServer } = require('./monitoring/api-server');
const dataCollector = require('./monitoring/data-collector');

// New Core Modules
const positionTracker = require('./core/position-tracker');
const consistencyEngine = require('./core/consistency-engine');
const orderExecutor = require('./core/order-executor');
const takeProfitHandler = require('./core/take-profit-handler');

// Event Serialization (Prevent Race Conditions)
const orderQueues = new Map();

async function processOrderEvent(orderData) {
  const key = `${orderData.userAddress}:${orderData.oid}`;
  
  if (!orderQueues.has(key)) {
    orderQueues.set(key, Promise.resolve());
  }

  const task = async () => {
    try {
      if (orderData.status === 'open' || orderData.status === 'triggered') {
        // Check if this is an Update (Mapping exists)
        const existingMapping = await orderMapper.getBinanceOrder(orderData.userAddress, orderData.oid);
        
        if (existingMapping) {
           await orderExecutor.updateLimitOrder(orderData);
        } else {
           // Handle New Limit Order
           await orderExecutor.executeLimitOrder(orderData);
        }
      
      } else if (orderData.status === 'canceled') {
        // Handle Cancel
        const mappedOrder = await orderMapper.getBinanceOrder(orderData.userAddress, orderData.oid);
        if (mappedOrder) {
          await binanceClient.cancelOrder(mappedOrder.symbol, mappedOrder.orderId);
          await orderMapper.deleteMapping(orderData.userAddress, orderData.oid);
        } else {
           // If cancel event arrives but no mapping yet, we might have a race where Add is still processing.
           // However, since we serialize by key, the Add event should have finished or be ahead of us in the queue.
           // If we are here and mapping is STILL null, it means we don't know about this order (maybe placed before bot started).
           logger.debug(`Cancel event for unmapped order ${key}, ignoring.`);
        }

      } else if (orderData.status === 'filled') {
        // Handle Fill (Cleanup)
        await consistencyEngine.handleHyperliquidFill(orderData.userAddress, orderData.oid);
        
        const mapping = await orderMapper.getBinanceOrder(orderData.userAddress, orderData.oid);
        if (mapping) {
          try {
             const bOrder = await binanceClient.client.futuresOrder({
               symbol: mapping.symbol,
               orderId: mapping.orderId
             });
             
             if (['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED'].includes(bOrder.status)) {
               await orderMapper.deleteMapping(orderData.userAddress, orderData.oid);
             }
          } catch (err) {
            logger.warn(`Failed to check Binance status for cleanup ${orderData.oid}`, err);
          }
        }
      }
    } catch (err) {
      logger.error(`Error processing order task for ${key}`, err);
    }
  };

  const nextPromise = orderQueues.get(key).then(task);
  orderQueues.set(key, nextPromise);

  // Cleanup queue after idle
  nextPromise.then(() => {
    if (orderQueues.get(key) === nextPromise) {
      orderQueues.delete(key);
    }
  });

  return nextPromise;
}

// Global Error Handlers (Critical for stability)
process.on('uncaughtException', (error) => {
  logger.error('FATAL: Uncaught Exception', error);
  // Optional: graceful shutdown logic here if needed
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('FATAL: Unhandled Promise Rejection', reason);
});

async function main() {
  logger.info('Starting HypeFollow System (Enhanced)...');

  // 1. API Security Validation
  try {
    apiValidator.validateAPIConfig();
    apiValidator.checkIPWhitelist();
    await apiValidator.validateAPIPermissions(binanceClient);
    
    // Ensure One-Way Mode (Best effort - warn if fails but don't crash if user manually set it)
    try {
      await binanceClient.ensureOneWayMode();
    } catch (modeError) {
      logger.warn('Failed to automatically verify/set One-Way Mode. Please ensure your Binance Futures account is in "One-Way Mode" manually.', { error: modeError.message });
    }
    
    logger.info('🚀 API security validation passed');
  } catch (error) {
    logger.error('❌ API security validation failed - CANNOT START', { error: error.message });
    process.exit(1);
  }

  // Start Monitoring Server
  if (config.get('monitoring.enabled')) {
    startServer();
  }

  // 2. Initialize Position Tracker
  // We initialize based on the first followed user (MVP limitation: single user tracking mostly)
  const followedUsers = config.get('hyperliquid.followedUsers');
  if (followedUsers && followedUsers.length > 0) {
    await positionTracker.init(followedUsers[0]);
  }

  // 2b. Initial sync for address 2 (Martingale strategy)
  const ADDRESS2 = '0xdc899ed4a80e7bbe7c86307715507c828901f196';
  if (followedUsers && followedUsers.includes(ADDRESS2)) {
    logger.info('[Main] Starting initial sync for address 2 (Martingale)...');
    await orderExecutor.syncUserOrders(ADDRESS2);
  }

  // 2c. Initialize take-profit position tracking and start monitoring
  await takeProfitHandler.initializePositionTracking();
  takeProfitHandler.startPositionMonitoring();
  logger.info('[Main] Take-profit monitoring started');

  // 3. Start Order Validator (Cleanups)
  orderValidator.start();

  // 4. Connect Hyperliquid WS
  hyperWs.connect();

  // 5. Handle Hyperliquid Order Events (Limit Orders)
  hyperWs.on('order', async (orderData) => {
    dataCollector.stats.totalOrders++;
    processOrderEvent(orderData); // Run serialized
  });

  // 6. Handle Hyperliquid Fill Events (Market Trades)
  hyperWs.on('fill', async (fillData) => {
    dataCollector.stats.totalFills++;
    
    try {
      if (fillData.isSnapshot) return;

      // Only follow Taker trades (active moves)
      if (fillData.crossed) {
        await orderExecutor.executeMarketOrder(fillData);
      }

      // 6b. Trigger TP adjustment after HL buy fill for Martingale strategy
      // This ensures TP syncs even when HL fills after Binance
      const ADDRESS2 = '0xdc899ed4a80e7bbe7c86307715507c828901f196';
      if (fillData.side === 'B' && fillData.userAddress === ADDRESS2) {
        const userStrategies = config.get('trading.userStrategies') || {};
        const userStrategy = userStrategies[ADDRESS2] && userStrategies[ADDRESS2][fillData.coin] 
          ? userStrategies[ADDRESS2][fillData.coin].strategy : null;
        
        if (userStrategy === 'closeAllOnSell') {
          // Delay to allow HL to update TP price after position change
          // HL may adjust TP after buy fill, we need to wait for that
          setTimeout(() => {
            orderExecutor.adjustTakeProfitOrderDebounced(fillData.coin, ADDRESS2).catch(err => {
              logger.error(`[HL-Fill] Error adjusting TP order for ${fillData.coin}`, err);
            });
          }, 2000); // 2 second delay for HL to process position change
        }
      }
    } catch (error) {
      logger.error('Failed to process fill event', error);
    }
  });

  // 7. Subscribe to Binance User Data Stream (For Orphan Fill Detection)
  try {
    binanceClient.subscribeUserStream(async (data) => {
      // data event type: 'ORDER_TRADE_UPDATE' usually implies execution
      // We look for Execution Report with status FILLED or PARTIALLY_FILLED
      // binance-api-node unifies this, but let's check the raw event or unified struct.
      // Usually: data.eventType === 'ORDER_TRADE_UPDATE' or 'executionReport'
      
      if (data.eventType === 'ORDER_TRADE_UPDATE' || data.e === 'ORDER_TRADE_UPDATE') {
        const order = data.order || data.o;
        if (!order) return;

        const status = order.orderStatus || order.X;
        const executionType = order.executionType || order.x;

        if (status === 'FILLED' || status === 'PARTIALLY_FILLED') {
           // We have a fill on Binance.
           const binanceOrderId = order.orderId || order.i;
           const coin = order.symbol.replace('USDT', '');
           const side = order.side || order.S;
           
// 1. Check for specific Martingale Take Profit Adjustment
             // If we just successfully BOUGHT (added to position), we need to update our total TP sell order
             // NOTE: Binance may fill before HL due to price differences
             // We trigger TP adjustment here, and also trigger again when HL fills
             // This dual-trigger ensures TP stays in sync regardless of which fills first
             if (side === 'BUY') {
               // For safety, we check if this user has the strategy enabled
               // Since this is a global Binance event, we find the mapping to know which user triggered this
               const mapping = await orderMapper.getHyperliquidOrder(binanceOrderId);
               if (mapping) {
                 const userStrategies = config.get('trading.userStrategies') || {};
                 const userStrategy = userStrategies[mapping.user] && userStrategies[mapping.user][coin] ? userStrategies[mapping.user][coin].strategy : null;
                 
                 if (userStrategy === 'closeAllOnSell') {
                   // Trigger the TP adjustment routine asynchronously
                   // Use longer delay to allow HL to potentially fill and update TP
                   setTimeout(() => {
                     orderExecutor.adjustTakeProfitOrderDebounced(coin, mapping.user).catch(err => {
                       logger.error(`Error auto-adjusting TP order for ${coin}`, err);
                     });
                   }, 1500); // 1.5s delay - HL may fill after Binance
                 }
               }
             }

            // 1b. Handle SELL fills (Take Profit / Position Close) for address 2
            // When position is closed, we need to sync HL orders to get new orders
            if (side === 'SELL') {
              const mapping = await orderMapper.getHyperliquidOrder(binanceOrderId);
              if (mapping && mapping.user === '0xdc899ed4a80e7bbe7c86307715507c828901f196') {
                // Check if this is a take-profit (position going to zero)
                try {
                  const position = await binanceClient.getPositionDetails(coin);
                  const currentPos = position ? Math.abs(position.amount) : 0;
                  
                  // If position is near zero after SELL, this is likely a TP trigger
                  const tpThreshold = config.get('trading.takeProfitRestart.positionZeroThreshold') || 0.01;
                  if (currentPos < tpThreshold) {
                    logger.info(`[Index] Take-profit detected! Position: ${currentPos} ${coin} (below threshold ${tpThreshold})`);
                    
                    // Check if TP restart is enabled
                    const tpRestartEnabled = config.get('trading.takeProfitRestart.enabled') !== false;
                    if (tpRestartEnabled && !takeProfitHandler.isInShutdown()) {
                      // Trigger TP handler - will clean up and restart
                      await takeProfitHandler.handleTakeProfitTriggered(coin);
                      return; // Exit early, process will restart
                    }
                  }
                } catch (posError) {
                  logger.warn(`[Index] Could not check position after SELL fill`, posError);
                }
                
                // If not TP or TP restart disabled, do normal sync
                logger.info(`[Index] SELL fill detected for address 2, triggering order sync...`);
                setTimeout(() => {
                  orderExecutor.syncUserOrders(mapping.user, { isInitialSync: false }).catch(err => {
                    logger.error(`Error syncing orders after SELL fill for ${coin}`, err);
                  });
                }, 1000);
              }
            }

           // 2. Original Orphan Fill Detection
           const mapping = await orderMapper.getHyperliquidOrder(binanceOrderId);
            
            if (mapping) {
              // It is a mapped order.
              // Record it as Orphan (initially) - assuming Hype hasn't filled yet.
              
              await consistencyEngine.recordOrphanFill(mapping.oid, {
                coin: coin, // Remove USDT suffix
                side: side === 'BUY' ? 'B' : 'A',
                sz: order.lastTradeQuantity || order.l,
                price: order.lastTradePrice || order.L,
                binanceOrderId: binanceOrderId,
                userAddress: mapping.user
              });
            }

        }
      }
    });
    logger.info('Subscribed to Binance User Data Stream');
  } catch (error) {
    logger.warn('Failed to subscribe to Binance User Data Stream - Orphan detection disabled', error);
  }

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    logger.info('Shutting down...');
    orderValidator.stop();
    takeProfitHandler.stopPositionMonitoring();
    hyperWs.close();
    redis.disconnect();
    process.exit(0);
  });
}

if (require.main === module) {
  main().catch(error => {
    logger.error('Fatal error during startup', error);
    process.exit(1);
  });
}

module.exports = {
  processOrderEvent,
  orderQueues
};

