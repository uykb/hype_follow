const axios = require('axios');
const logger = require('../utils/logger');

class HyperliquidAPIClient {
  constructor() {
    this.baseUrl = 'https://api.hyperliquid.xyz/info';
  }

  /**
   * Get Clearinghouse State (Account Info)
   * @param {string} address User address
   * @returns {Promise<object>} Account state including margin summary
   */
  async getClearinghouseState(address) {
    try {
      const response = await axios.post(this.baseUrl, {
        type: 'clearinghouseState',
        user: address
      });

      return response.data;
    } catch (error) {
      logger.error('Failed to get Hyperliquid clearinghouse state', error);
      throw error;
    }
  }
  /**
   * Get User Positions
   * @param {string} address User address
   * @returns {Promise<Array>} List of positions
   */
  async getUserPositions(address) {
    try {
      const state = await this.getClearinghouseState(address);
      if (!state || !state.assetPositions) return [];
      
      // Parse positions
      return state.assetPositions.map(p => ({
        coin: p.position.coin,
        amount: parseFloat(p.position.szi), // szi is size index? No, usually 'szi' is signed size in some contexts or 'sz' in others. 
        // In clearninghouseState: assetPositions: [{ position: { coin: "BTC", szi: "1.0", ... } }]
        // Let's assume 'szi' or 'sz'.
        // Checking HL docs/common patterns: assetPositions have 'position' object which has 'szi' (signed size).
        entryPx: parseFloat(p.position.entryPx),
        szi: parseFloat(p.position.szi)
      })).filter(p => p.szi !== 0);
    } catch (error) {
      logger.error('Failed to get user positions', error);
      return [];
    }
  }

  /**
   * Get user open orders for a specific coin
   * @param {string} address User address
   * @param {string} coin Coin symbol (e.g., 'HYPE')
   * @returns {Promise<Array>} List of open orders
   */
  async getUserOpenOrders(address, coin) {
    try {
      const response = await axios.post(this.baseUrl, {
        type: 'openOrders',
        user: address,
        coin: coin
      });
      
      // The response should be an array of orders
      if (Array.isArray(response.data)) {
        return response.data;
      }
      
      return [];
    } catch (error) {
      logger.warn(`Failed to get open orders for ${coin}`, error.message);
      return [];
    }
  }

  /**
   * Get specific order status
   * @param {string} address User address
   * @param {number|string} oid Order ID
   * @returns {Promise<object|null>} Order status info or null
   */
  async getOrderStatus(address, oid) {
    try {
      const response = await axios.post(this.baseUrl, {
        type: 'orderStatus',
        user: address,
        oid: parseInt(oid)
      });
      return response.data;
    } catch (error) {
      logger.warn(`Failed to get order status for ${oid}`, error.message);
      return null;
    }
  }
}

module.exports = new HyperliquidAPIClient();
