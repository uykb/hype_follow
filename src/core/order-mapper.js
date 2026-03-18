const store = require('../utils/memory-store');
const logger = require('../utils/logger');

// Key prefixes (now using in-memory store, but keeping prefix convention for clarity)
const HYPER_TO_BINANCE = 'map:h2b:';
const BINANCE_TO_HYPER = 'map:b2h:';
const ORDER_TIMESTAMP = 'timestamp:order:';

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
      const hKey = `${userAddress}:${hyperOid}`;
      
      // Store bi-directional mapping (no TTL needed for in-memory, cleared on restart)
      await store.set(`${HYPER_TO_BINANCE}${hKey}`, JSON.stringify({ orderId: binanceOrderId, symbol, user: userAddress }));
      await store.set(`${BINANCE_TO_HYPER}${binanceOrderId}`, JSON.stringify({ oid: hyperOid, symbol, user: userAddress }));
      
      // Store timestamp for timeout/validation tracking
      await store.set(`${ORDER_TIMESTAMP}${hKey}`, Date.now().toString());
      
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
      const data = await store.get(`${HYPER_TO_BINANCE}${hKey}`);
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
      const data = await store.get(`${BINANCE_TO_HYPER}${binanceOrderId}`);
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
      const ts = await store.get(`${ORDER_TIMESTAMP}${hKey}`);
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
      
      await store.del(`${HYPER_TO_BINANCE}${hKey}`);
      await store.del(`${ORDER_TIMESTAMP}${hKey}`);
      
      if (mappedOrder && mappedOrder.orderId) {
        await store.del(`${BINANCE_TO_HYPER}${mappedOrder.orderId}`);
      }
      
      logger.debug(`Deleted mapping for Hyperliquid OID ${hKey}`);
    } catch (error) {
      logger.error('Failed to delete order mapping', error);
    }
  }

  /**
   * Clear all mappings (used for take-profit cleanup)
   */
  async clearAllMappings() {
    try {
      const h2bKeys = await store.keys('map:h2b:*');
      const b2hKeys = await store.keys('map:b2h:*');
      const tsKeys = await store.keys('timestamp:order:*');
      
      for (const key of [...h2bKeys, ...b2hKeys, ...tsKeys]) {
        await store.del(key);
      }
      
      logger.info('[OrderMapper] Cleared all order mappings');
    } catch (error) {
      logger.error('Failed to clear all mappings', error);
    }
  }
}

module.exports = new OrderMapper();