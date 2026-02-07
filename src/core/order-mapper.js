const redis = require('../utils/redis');
const logger = require('../utils/logger');

// Key prefixes
const HYPER_TO_BINANCE = 'map:h2b:';
const BINANCE_TO_HYPER = 'map:b2h:';
const ORDER_TIMESTAMP = 'timestamp:order:';
const EXPIRY = 60 * 60 * 24 * 7; // 7 days retention

class OrderMapper {
  /**
   * Map a Hyperliquid OID to a Binance OrderId
   * @param {string} userAddress
   * @param {string} hyperOid 
   * @param {string} binanceOrderId 
   * @param {string} symbol 
   */
  async saveMapping(userAddress, hyperOid, binanceOrderId, symbol) {
    try {
      const pipeline = redis.pipeline();
      const hKey = `${userAddress}:${hyperOid}`;
      
      // Store bi-directional mapping
      pipeline.set(`${HYPER_TO_BINANCE}${hKey}`, JSON.stringify({ orderId: binanceOrderId, symbol, user: userAddress }), 'EX', EXPIRY);
      pipeline.set(`${BINANCE_TO_HYPER}${binanceOrderId}`, JSON.stringify({ oid: hyperOid, symbol, user: userAddress }), 'EX', EXPIRY);
      
      // Store timestamp for timeout/validation tracking
      pipeline.set(`${ORDER_TIMESTAMP}${hKey}`, Date.now().toString(), 'EX', EXPIRY);
      
      await pipeline.exec();
      logger.debug(`Mapped Hyperliquid OID ${hKey} to Binance OrderID ${binanceOrderId} with timestamp`);
    } catch (error) {
      logger.error('Failed to save order mapping', error);
    }
  }

  /**
   * Get Binance OrderId from Hyperliquid OID
   * @param {string} userAddress
   * @param {string} hyperOid 
   * @returns {Promise<{orderId: string, symbol: string, user: string}|null>}
   */
  async getBinanceOrder(userAddress, hyperOid) {
    try {
      const hKey = `${userAddress}:${hyperOid}`;
      const data = await redis.get(`${HYPER_TO_BINANCE}${hKey}`);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      logger.error('Failed to get Binance order', error);
      return null;
    }
  }

  /**
   * Get Hyperliquid OID and User from Binance OrderId
   * @param {string} binanceOrderId 
   * @returns {Promise<{oid: string, user: string, symbol: string}|null>} Hyperliquid info
   */
  async getHyperliquidOrder(binanceOrderId) {
    try {
      const data = await redis.get(`${BINANCE_TO_HYPER}${binanceOrderId}`);
      if (!data) return null;
      return JSON.parse(data);
    } catch (error) {
      logger.error('Failed to get Hyperliquid order', error);
      return null;
    }
  }

  /**
   * Get Order timestamp
   * @param {string} userAddress
   * @param {string} hyperOid 
   */
  async getOrderTimestamp(userAddress, hyperOid) {
    try {
      const hKey = `${userAddress}:${hyperOid}`;
      const ts = await redis.get(`${ORDER_TIMESTAMP}${hKey}`);
      return ts ? parseInt(ts) : null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Delete mapping for a Hyperliquid OID
   * @param {string} userAddress
   * @param {string} hyperOid 
   */
  async deleteMapping(userAddress, hyperOid) {
    try {
      const mappedOrder = await this.getBinanceOrder(userAddress, hyperOid);
      const hKey = `${userAddress}:${hyperOid}`;
      
      const pipeline = redis.pipeline();
      pipeline.del(`${HYPER_TO_BINANCE}${hKey}`);
      pipeline.del(`${ORDER_TIMESTAMP}${hKey}`);
      
      if (mappedOrder && mappedOrder.orderId) {
        pipeline.del(`${BINANCE_TO_HYPER}${mappedOrder.orderId}`);
      }
      
      await pipeline.exec();
      logger.debug(`Deleted mapping for Hyperliquid OID ${hKey}`);
    } catch (error) {
      logger.error('Failed to delete order mapping', error);
    }
  }
}

module.exports = new OrderMapper();
