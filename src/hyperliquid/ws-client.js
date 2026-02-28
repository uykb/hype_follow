const WebSocket = require('ws');
const config = require('config');
const EventEmitter = require('events');
const logger = require('../utils/logger');
const parsers = require('./parsers');
const axios = require('axios');
const binanceClient = require('../binance/api-client');
const orderMapper = require('../core/order-mapper');
const orderExecutor = require('../core/order-executor');
const consistencyEngine = require('../core/consistency-engine');

class HyperliquidWS extends EventEmitter {
  constructor() {
    super();
    this.wsUrl = config.get('hyperliquid.wsUrl');
    this.followedUsers = config.get('hyperliquid.followedUsers'); // Array of UIDs
    this.ws = null;
    this.pingInterval = null;
    
    // Reconnection settings
    this.reconnectAttempts = 0;
    this.baseReconnectDelay = 1000; // 1 second
    this.maxReconnectDelay = 30000; // 30 seconds
    this.isExplicitClose = false;
    this.reconnectTimer = null;
    this.syncTimer = null;
    this.syncInterval = 5 * 60 * 1000; // 5 minutes
  }

  connect() {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.terminate();
    }

    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      logger.info('Connected to Hyperliquid WebSocket');
      this.reconnectAttempts = 0; // Reset attempts on successful connection
      this.isExplicitClose = false;
      this.subscribe();
      this.startHeartbeat();
      
      // Perform Initial Sync of Open Orders
      this.syncOrders('Initial', () => {
        // After Initial sync, sync orders for all followed users
        const orderExecutor = require('../core/order-executor');
        
        // Sync all followed users (the function will handle address 2 specific logic internally)
        for (const user of this.followedUsers) {
          orderExecutor.syncUserOrders(user);
        }
      });
      
      // Periodic sync disabled as per user request (only reactive mode)
      // this.startPeriodicSync();
    });


    this.ws.on('message', (data) => {
      try {
        const message = JSON.parse(data);
        this.handleMessage(message);
      } catch (error) {
        logger.error('Error parsing WebSocket message', error);
      }
    });

    this.ws.on('close', () => {
      this.stopHeartbeat();
      this.stopPeriodicSync();
      if (this.isExplicitClose) {
         logger.info('Hyperliquid WebSocket closed explicitly.');
         return;
      }

      logger.warn('Hyperliquid WebSocket disconnected');
      this.scheduleReconnect();
    });

    this.ws.on('error', (error) => {
      logger.error('Hyperliquid WebSocket error', error);
      // 'close' event usually follows 'error', so we handle reconnect there
    });
  }

  scheduleReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    // Exponential backoff: base * 2^attempts
    const delay = Math.min(
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay
    );

    logger.info(`Reconnecting in ${delay}ms (Attempt ${this.reconnectAttempts + 1})...`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++;
      this.connect();
    }, delay);
  }

  close() {
    this.isExplicitClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    this.stopPeriodicSync();
    if (this.ws) {
      this.ws.close();
    }
  }

  subscribe() {
    if (this.followedUsers.length === 0) {
      logger.warn('No users to follow configured');
      return;
    }

    this.followedUsers.forEach(user => {
      // 1. Subscribe to Order Updates (Limit Orders)
      const orderMsg = {
        method: "subscribe",
        subscription: {
          type: "orderUpdates",
          user: user
        }
      };
      this.ws.send(JSON.stringify(orderMsg));
      logger.info(`Subscribed to orderUpdates for user: ${user}`);

      // 2. Subscribe to User Fills (Market Trades)
      const fillMsg = {
        method: "subscribe",
        subscription: {
          type: "userFills",
          user: user
        }
      };
      this.ws.send(JSON.stringify(fillMsg));
      logger.info(`Subscribed to userFills for user: ${user}`);
    });
  }

  async syncOrders(type = 'Initial', onComplete) {
    if (this.followedUsers.length === 0) return;

    logger.info(`Starting ${type} sync of open orders...`);

    // 1. Fetch Binance Open Orders (Snapshot)
    let binanceOpenOrders = [];
    const binanceOrdersMap = new Map(); // Symbol -> Array of Orders
    const binanceOrderIdMap = new Set(); // Set of OrderIDs for quick existence check

    try {
      binanceOpenOrders = await binanceClient.client.futuresOpenOrders();
      
      binanceOpenOrders.forEach(bo => {
        // Index by Symbol for Recovery matching
        if (!binanceOrdersMap.has(bo.symbol)) {
          binanceOrdersMap.set(bo.symbol, []);
        }
        binanceOrdersMap.get(bo.symbol).push(bo);
        
        // Index by ID for Sync verification
        binanceOrderIdMap.add(bo.orderId.toString());
      });
      
      logger.info(`Fetched ${binanceOpenOrders.length} active Binance orders for sync reconciliation.`);
    } catch (err) {
      logger.warn('Failed to fetch Binance open orders. Sync/Pruning will be limited.', err);
    }

    // Track ALL HL Open Orders across ALL users to avoid accidental pruning in multi-user setup
    const allHlOpenOrderIds = new Set();
    // We also need an API client for status checks
    const apiClient = require('./api-client'); 

    for (const user of this.followedUsers) {
      try {
        const response = await axios.post('https://api.hyperliquid.xyz/info', {
          type: "openOrders",
          user: user
        });

        const hlOpenOrders = response.data;

        if (Array.isArray(hlOpenOrders)) {
          logger.info(`[${type}] Found ${hlOpenOrders.length} existing open orders for ${user}. Syncing...`);
          
          // Add to global set for pruning phase
          hlOpenOrders.forEach(o => allHlOpenOrderIds.add(o.oid.toString()));

          // --- Phase 1: Sync HL -> Binance (Create / Verify) ---
          for (const order of hlOpenOrders) {
            // Standardize
            const standardizedOrder = {
              type: 'order',
              status: 'open',
              coin: order.coin,
              side: order.side,
              limitPx: order.limitPx,
              sz: order.sz,
              oid: order.oid,
              timestamp: order.timestamp,
              userAddress: user
            };

            // A. Check Existing Mapping
            const existingMapping = await orderMapper.getBinanceOrder(user, order.oid);
            
            if (existingMapping) {
              // We have a mapping. Check if the Binance Order is ACTUALLY active.
              if (binanceOrderIdMap.has(existingMapping.orderId.toString())) {
                // Perfect Sync: Mapped AND Active on Binance.
                // DO NOT EMIT. This prevents duplicates definitively.
                logger.debug(`[${type}] Order ${user}:${order.oid} already synced and active on Binance (${existingMapping.orderId}). Skipping.`);
                continue;
              } else {
                // Mapping exists, but Binance Order is MISSING from OpenOrders.
                // This means it was Filled or Canceled on Binance, but HL still has it Open.
                // We should probably allow re-creation (Emit), or treat as Orphan drift.
                // Given the user wants "Copy", if HL has it open, we should probably have it open.
                // So we fall through to Emit.
                logger.info(`[${type}] Order ${user}:${order.oid} mapped but not found in Binance OpenOrders. Retrying sync (creating new)...`);
                // Clean old mapping to allow new creation logic to run cleanly if needed
                await orderMapper.deleteMapping(user, order.oid); 
              }
            }

            // B. Recovery Check (If no valid mapping)
            const symbol = binanceClient.getBinanceSymbol(order.coin);
            const candidates = binanceOrdersMap.get(symbol) || [];

            if (candidates.length > 0) {
              const hlPriceFormatted = binanceClient.roundPrice(order.coin, order.limitPx);
              const binanceSide = order.side === 'B' ? 'BUY' : 'SELL';

              const matchIndex = candidates.findIndex(bo => {
                const priceDiff = Math.abs(parseFloat(bo.price) - parseFloat(hlPriceFormatted));
                const isPriceMatch = priceDiff < 0.0001 || (parseFloat(bo.price) > 0 && priceDiff / parseFloat(bo.price) < 0.0001);
                
                return bo.side === binanceSide && isPriceMatch;
              });

              if (matchIndex !== -1) {
                const matchedOrder = candidates[matchIndex];
                candidates.splice(matchIndex, 1); // Consume candidate

                logger.info(`[${type}] Recovered mapping: HL ${user}:${order.oid} <-> Binance ${matchedOrder.orderId}`);

                await orderMapper.saveMapping(user, order.oid, matchedOrder.orderId, symbol);
                await consistencyEngine.markOrderProcessed(order.oid, {
                  type: 'limit-recovered',
                  coin: order.coin,
                  restored: true,
                  binanceOrderId: matchedOrder.orderId,
                  recoveredAt: Date.now()
                });

                continue; // Skip Emit
              }
            }
            
            // C. Create New
            logger.info(`[${type}] Processing NEW order for HL ${order.oid}`);
            try {
              await orderExecutor.executeLimitOrder(standardizedOrder, true); // Skip rebalance during sync
            } catch (err) {
              logger.error(`[${type}] Failed to process initial order ${order.oid}`, err);
            }
          } // End Phase 1 Loop

        }
      } catch (err) {
        logger.error(`[${type}] Error syncing orders for user ${user}`, err);
      }
    } // End User Loop

    // --- Phase 2: Prune Binance -> HL (Cancel Zombie Orders) ---
    if (binanceOpenOrders.length > 0) {
      const pruneBatchSize = 5;
      for (let i = 0; i < binanceOpenOrders.length; i += pruneBatchSize) {
        const batch = binanceOpenOrders.slice(i, i + pruneBatchSize);
        await Promise.all(batch.map(async (bOrder) => {
          try {
            // Safety: Skip Reduce-Only orders
            if (bOrder.reduceOnly) return;

            // Check if this Binance Order is a "Follow" order (has mapping)
            const mapping = await orderMapper.getHyperliquidOrder(bOrder.orderId);
            
            if (mapping) {
              const mappedHlOid = mapping.oid;
              const userAddress = mapping.user;
              
              if (!allHlOpenOrderIds.has(mappedHlOid.toString())) {
                let isFilled = false;
                const usersToCheck = userAddress ? [userAddress] : this.followedUsers;
                
                for (const user of usersToCheck) {
                  const statusInfo = await apiClient.getOrderStatus(user, mappedHlOid);
                  if (statusInfo && statusInfo.status === 'order') {
                    const actualStatus = statusInfo.order.status;
                    if (actualStatus === 'filled' || actualStatus === 'triggered') {
                      isFilled = true;
                      logger.warn(`[${type}] Mismatch: HL Order ${user}:${mappedHlOid} is ${actualStatus} but Binance is OPEN. Keeping.`);
                      break; 
                    } else if (actualStatus === 'open') {
                       isFilled = true; 
                       break;
                    }
                  }
                }

                if (isFilled) return;

                logger.info(`[${type}] Pruning Zombie Binance Order ${bOrder.orderId} (HL ${userAddress}:${mappedHlOid} verified closed).`);
                try {
                   await binanceClient.cancelOrder(bOrder.symbol, bOrder.orderId);
                   await orderMapper.deleteMapping(userAddress, mappedHlOid);
                } catch (cancelErr) {
                   logger.warn(`[${type}] Failed to cancel zombie order ${bOrder.orderId}`, cancelErr);
                }
              }
            } else {
              // UNMAPPED ORDER (Manual)
              // We NO LONGER prune unmapped orders to allow manual trading from the dashboard.
              // These orders will stay open until manually canceled or filled.
              logger.debug(`[${type}] Detected manual/unmapped Binance order ${bOrder.symbol} ${bOrder.orderId}. Skipping pruning.`);
            }
          } catch (err) {
            logger.error(`[${type}] Error checking/pruning order ${bOrder.orderId}`, err);
          }
        }));
      }
    }
    
    // Call the completion callback if provided
    if (onComplete && typeof onComplete === 'function') {
      logger.info(`[${type}] Sync completed, calling completion callback...`);
      onComplete();
    }
  }

  startPeriodicSync() {
    if (this.syncTimer) return;
    logger.info(`Starting periodic sync (Interval: ${this.syncInterval}ms)`);
    this.syncTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.syncOrders('Periodic');
      }
    }, this.syncInterval);
  }

  stopPeriodicSync() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  handleMessage(message) {
    const { channel, data } = message;

    if (channel === 'orderUpdates') {
      logger.debug('WS: Received orderUpdates', { data });
      const orders = parsers.parseOrderUpdate(data);
      
      if (orders && orders.length > 0) {
        orders.forEach(order => {
          if (!order.userAddress && this.followedUsers.length > 0) {
            order.userAddress = this.followedUsers[0];
          }
          logger.info(`WS: Parsed order event: ${order.status} ${order.coin} ${order.oid}`);
          this.emit('order', order);
        });
      }
    } else if (channel === 'userFills') {
      const fills = parsers.parseUserFills(data);
      if (fills && fills.length > 0) {
        fills.forEach(fill => {
          this.emit('fill', fill);
        });
      }
    }
  }

  startHeartbeat() {
    this.pingInterval = setInterval(() => {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ method: "ping" }));
      }
    }, 30000);
  }

  stopHeartbeat() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
}

module.exports = new HyperliquidWS();
