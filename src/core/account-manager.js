const config = require('config');
const store = require('../utils/memory-store');
const hyperApiClient = require('../hyperliquid/api-client');
const binanceClient = require('../binance/api-client');
const logger = require('../utils/logger');

class AccountManager {
  constructor() {
    this.cacheKey = {
      hlAccount: 'account:hl:',
      binanceAccount: 'account:binance:'
    };
    this.cacheTTL = config.get('trading.accountCacheTTL');
  }

  /**
   * Get Hyperliquid Total Equity (Account Value)
   * @param {string} address 
   * @returns {Promise<number>}
   */
  async getHyperliquidTotalEquity(address) {
    const cacheKey = this.cacheKey.hlAccount + address;
    
    // Check cache first
    try {
      const cached = await store.get(cacheKey);
      if (cached) {
        return parseFloat(cached);
      }
    } catch (err) {
      logger.warn('Memory store get failed in getHyperliquidTotalEquity', err);
    }

    // Call API
    try {
      const accountData = await hyperApiClient.getClearinghouseState(address);
      
      // accountValue is usually in marginSummary
      if (!accountData || !accountData.marginSummary) {
        throw new Error(`Invalid Hyperliquid account data for ${address}`);
      }

      const totalEquity = parseFloat(accountData.marginSummary.accountValue);

      // Cache result with TTL
      try {
        await store.set(cacheKey, totalEquity.toString(), null, 'EX', this.cacheTTL);
      } catch (err) {
        logger.warn('Memory store set failed in getHyperliquidTotalEquity', err);
      }

      logger.info(`Hyperliquid account value: ${totalEquity} for ${address}`);
      return totalEquity;
    } catch (error) {
      logger.error(`Failed to get Hyperliquid equity for ${address}`, error);
      throw error;
    }
  }

  /**
   * Get Binance Total Equity (Wallet Balance + Unrealized PnL)
   * @returns {Promise<number>}
   */
  async getBinanceTotalEquity() {
    const cacheKey = this.cacheKey.binanceAccount;
    
    // Check cache first
    try {
      const cached = await store.get(cacheKey);
      if (cached) {
        return parseFloat(cached);
      }
    } catch (err) {
      logger.warn('Memory store get failed in getBinanceTotalEquity', err);
    }

    try {
      // 1. Get Wallet Balance
      // Note: futuresAccountInfo returns 'totalWalletBalance' which includes realized pnl but excludes unrealized pnl usually, 
      // or 'totalMarginBalance' which includes unrealized pnl.
      // 'totalMarginBalance' is equivalent to Equity.
      const account = await binanceClient.futuresAccountInfo();
      const totalEquity = parseFloat(account.totalMarginBalance);

      // Cache result with TTL
      try {
        await store.set(cacheKey, totalEquity.toString(), null, 'EX', this.cacheTTL);
      } catch (err) {
        logger.warn('Memory store set failed in getBinanceTotalEquity', err);
      }

      logger.info(`Binance total equity: ${totalEquity}`);
      return totalEquity;
    } catch (error) {
      logger.error('Failed to get Binance equity', error);
      throw error;
    }
  }
}

module.exports = new AccountManager();