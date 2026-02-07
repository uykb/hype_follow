const binanceClient = require('../binance/api-client');
const orderMapper = require('./order-mapper');
const redis = require('../utils/redis');
const logger = require('../utils/logger');
const config = require('config');

class OrderValidator {
  constructor() {
    this.checkInterval = 60000; // 1 minute
    this.timer = null;
    this.isChecking = false;
    
    // MVP: Assume first followed user for reconciliation
    const followedUsers = config.get('hyperliquid.followedUsers');
    this.masterAddress = followedUsers && followedUsers.length > 0 ? followedUsers[0] : null;
  }

  start() {
    if (this.timer) return;
    this.cleanupStaleMappings().catch(err => logger.error('Startup cleanup failed', err));
    this.timer = setInterval(() => this.validateAll(), this.checkInterval);
    logger.info('Order status validator started');
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async cleanupStaleMappings() {
    logger.info('Running startup cleanup for stale order mappings...');
    try {
      let cursor = '0';
      let cleaned = 0;
      
      do {
        const result = await redis.scan(cursor, 'MATCH', 'map:h2b:*', 'COUNT', 100);
        cursor = result[0];
        const keys = result[1];
        
        for (const key of keys) {
          const fullKey = key.replace('map:h2b:', '');
          const [userAddress, hyperOid] = fullKey.split(':');
          
          if (!userAddress || !hyperOid) {
             // Legacy key or corrupted?
             const mapping = await orderMapper.getBinanceOrder(null, fullKey); // Try legacy
             if (!mapping) {
                await redis.del(key);
                continue;
             }
          }

          const mapping = await orderMapper.getBinanceOrder(userAddress, hyperOid);
          if (!mapping) continue;

          try {
            await binanceClient.client.futuresGetOrder({
              symbol: mapping.symbol,
              orderId: mapping.orderId.toString()
            });
          } catch (error) {
            // -2011: Unknown order
            if (error.code === -2011) {
              await orderMapper.deleteMapping(userAddress, hyperOid);
              cleaned++;
            }
          }
        }
      } while (cursor !== '0');

      if (cleaned > 0) {
        logger.info(`Startup cleanup removed ${cleaned} stale mappings`);
      }
    } catch (error) {
      logger.error('Error during startup cleanup', error);
    }
  }

  async validateAll() {
    if (this.isChecking) return;
    this.isChecking = true;

    try {
      // 1. Validate Order Statuses (Current logic)
      let cursor = '0';
      let totalChecked = 0;

      do {
        const result = await redis.scan(cursor, 'MATCH', 'map:h2b:*', 'COUNT', 100);
        cursor = result[0];
        const keys = result[1];

        if (keys.length > 0) {
          for (const key of keys) {
            const fullKey = key.replace('map:h2b:', '');
            const [userAddress, hyperOid] = fullKey.split(':');
            if (userAddress && hyperOid) {
              await this.validateOrder(userAddress, hyperOid);
            }
          }
          totalChecked += keys.length;
        }
      } while (cursor !== '0');

    } catch (error) {
      logger.error('Error in order validation loop', error);
    } finally {
      this.isChecking = false;
    }
  }

  async validateOrder(userAddress, hyperOid) {
    const mapping = await orderMapper.getBinanceOrder(userAddress, hyperOid);
    if (!mapping) return;

    const fullKey = `${userAddress}:${hyperOid}`;

    try {
      // Query Binance for real-time status
      const binanceOrder = await binanceClient.client.futuresGetOrder({
        symbol: mapping.symbol,
        orderId: mapping.orderId.toString()
      });

      const finalStatuses = ['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED'];
      
      if (finalStatuses.includes(binanceOrder.status)) {
        logger.info(`Cleaning up finished order: ${mapping.symbol} ${mapping.orderId} (Status: ${binanceOrder.status})`);
        await orderMapper.deleteMapping(userAddress, hyperOid);
      } else {
        await redis.del(`validate:fail:${fullKey}`);
      }
      
      // Additional check: Timeout for stuck open orders (e.g., 24h)
      const timestamp = await orderMapper.getOrderTimestamp(userAddress, hyperOid);
      const oneDay = 24 * 60 * 60 * 1000;
      if (timestamp && (Date.now() - timestamp > oneDay)) {
        logger.warn(`Stuck order detected (over 24h): ${mapping.symbol} ${mapping.orderId}. Cleaning up mapping.`);
        await orderMapper.deleteMapping(userAddress, hyperOid);
      }

    } catch (error) {
      const failKey = `validate:fail:${fullKey}`;
      const fails = await redis.incr(failKey);
      await redis.expire(failKey, 3600);

      if (error.code === -2011) { // Unknown order
        logger.warn(`Binance order ${mapping.orderId} not found for HL OID ${hyperOid} (${userAddress}). Cleaning up mapping.`);
        await orderMapper.deleteMapping(userAddress, hyperOid);
        await redis.del(failKey);
      } else {
        // Only log network/other errors, do not force delete mapping to avoid losing valid orders
        logger.error(`Failed to validate order ${fullKey} (Attempt ${fails})`, {
          message: error.message,
          code: error.code,
          fullError: error
        });
      }
    }
  }

  async getReport() {
    const details = [];
    let cursor = '0';
    let totalActive = 0;

    try {
      do {
        const result = await redis.scan(cursor, 'MATCH', 'map:h2b:*', 'COUNT', 100);
        cursor = result[0];
        const keys = result[1];
        
        for (const key of keys) {
          const fullKey = key.replace('map:h2b:', '');
          const [userAddress, hyperOid] = fullKey.split(':');
          if (userAddress && hyperOid) {
            const mapping = await orderMapper.getBinanceOrder(userAddress, hyperOid);
            if (mapping) {
              details.push({ hyperOid, userAddress, ...mapping });
            }
          }
        }
        totalActive += keys.length;
      } while (cursor !== '0');
    } catch (err) {
      logger.error('Error generating report', err);
    }

    return {
      activeCount: totalActive,
      orders: details
    };
  }
}

module.exports = new OrderValidator();
