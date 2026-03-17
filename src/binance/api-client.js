const Binance = require('binance-api-node').default;
const config = require('config');
const logger = require('../utils/logger');

class BinanceClient {
  constructor() {
    const binanceConfig = config.get('binance');
    this.client = Binance({
      apiKey: binanceConfig.apiKey,
      apiSecret: binanceConfig.apiSecret,
      httpBase: binanceConfig.useTestnet ? 'https://testnet.binancefuture.com' : undefined,
    });
    this.isTestnet = binanceConfig.useTestnet;
  }

  /**
   * Ensure the account is in One-Way Mode (required for this bot)
   */
  async ensureOneWayMode() {
    try {
      // Check current mode
      const result = await this.client.futuresPositionMode();
      // Result format: { dualSidePosition: true/false }
      
      if (result.dualSidePosition) {
        logger.info('Account is in Hedge Mode. Switching to One-Way Mode...');
        await this.client.futuresPositionModeChange({ dualSidePosition: 'false' });
        logger.info('Successfully switched to One-Way Mode.');
      } else {
        logger.info('Account is already in One-Way Mode.');
      }
    } catch (error) {
      // If error is "No need to change", it's fine. 
      // But typically checking first avoids that.
      // Code -4059: "No need to change position side."
      if (error.code === -4059) {
        logger.info('Account mode check: Already correct.');
        return;
      }
      logger.error('Failed to ensure One-Way Mode', { error: error.message, code: error.code });
      throw error; // This is critical, we should probably throw
    }
  }

  /**
   * Convert Hyperliquid coin symbol to Binance Futures symbol
   * @param {string} coin e.g., "BTC"
   * @returns {string} e.g., "BTCUSDT"
   */
  getBinanceSymbol(coin) {
    // MVP assumption: All pairs are USDT perpetuals
    return `${coin}USDT`;
  }

  /**
   * Round price to tick size
   * @param {string} coin 
   * @param {number|string} price 
   */
  roundPrice(coin, price) {
    // Basic tick size implementation for HYPE
    const tickSizes = {
      HYPE: 0.001
    };
    
    const tickSize = tickSizes[coin] || 0.001;
    // Round to nearest tick
    const p = parseFloat(price);
    const rounded = Math.round(p / tickSize) * tickSize;
    
    // Convert to fixed string to avoid 94352.00000001
    // Count decimals in tickSize
    const decimals = (tickSize.toString().split('.')[1] || '').length;
    return rounded.toFixed(decimals);
  }

  /**
   * Create a limit order
   * @param {string} coin 
   * @param {string} side 'B' or 'A' (BUY or SELL)
   * @param {number|string} price 
   * @param {number|string} quantity 
   * @param {boolean} reduceOnly
   */
  async createLimitOrder(coin, side, price, quantity, reduceOnly = false) {
    const symbol = this.getBinanceSymbol(coin);
    const binanceSide = side === 'B' ? 'BUY' : 'SELL';
    
    // Ensure Price Precision
    const formattedPrice = this.roundPrice(coin, price);
    
    logger.info(`Placing LIMIT order on Binance: ${symbol} ${binanceSide} ${quantity} @ ${formattedPrice} (Orig: ${price}) ${reduceOnly ? '[REDUCE-ONLY]' : ''}`);

    try {
      const params = {
        symbol: symbol,
        side: binanceSide,
        type: 'LIMIT',
        timeInForce: 'GTC', // Good Till Cancelled
        quantity: quantity.toString(),
        price: formattedPrice,
      };

      if (reduceOnly) {
        params.reduceOnly = true;
      }

      const order = await this.client.futuresOrder(params);
      
      logger.info(`Binance LIMIT Order Placed: ${order.orderId}`);
      return order;
    } catch (error) {
      const errorMsg = `Binance Limit Order Failed: ${error.message} (Code: ${error.code})`;
      logger.error(errorMsg, {
        message: error.message,
        code: error.code,
        response: error.response?.data,
        params: { symbol, side: binanceSide, price, quantity }
      });
      throw error;
    }
  }

  /**
   * Create a market order
   * @param {string} coin 
   * @param {string} side 'B' or 'A'
   * @param {number|string} quantity 
   * @param {boolean} reduceOnly
   */
  async createMarketOrder(coin, side, quantity, reduceOnly = false) {
    const symbol = this.getBinanceSymbol(coin);
    const binanceSide = side === 'B' ? 'BUY' : 'SELL';

    logger.info(`Placing MARKET order on Binance: ${symbol} ${binanceSide} ${quantity} ${reduceOnly ? '[REDUCE-ONLY]' : ''}`);

    try {
      const params = {
        symbol: symbol,
        side: binanceSide,
        type: 'MARKET',
        quantity: quantity.toString(),
      };

      if (reduceOnly) {
        params.reduceOnly = true;
      }

      const order = await this.client.futuresOrder(params);

      logger.info(`Binance MARKET Order Placed: ${order.orderId}`);
      return order;
    } catch (error) {
      const errorMsg = `Binance Market Order Failed: ${error.message} (Code: ${error.code})`;
      logger.error(errorMsg, {
        message: error.message,
        code: error.code,
        response: error.response?.data,
        params: { symbol, side: binanceSide, quantity }
      });
      throw error;
    }
  }

  /**
   * Cancel an order
   * @param {string} symbol 
   * @param {string|number} orderId 
   */
  async cancelOrder(symbol, orderId) {
    logger.info(`Cancelling order on Binance: ${symbol} ID: ${orderId}`);
    try {
      const result = await this.client.futuresCancelOrder({
        symbol: symbol,
        orderId: orderId.toString()
      });
      logger.info(`Binance Order Cancelled: ${orderId}`);
      return result;
    } catch (error) {
      // If error is "Unknown Order" (code -2011), it might already be filled or cancelled.
      // We log it but don't necessarily crash the app.
      logger.warn('Binance Cancel Order Failed', { error: error.message, symbol, orderId });
      throw error;
    }
  }

  /**
   * Subscribe to User Data Stream (Fills, Order Updates)
   * @param {function} callback 
   * @returns {function} Unsubscribe function
   */
  subscribeUserStream(callback) {
    try {
      // client.ws.user returns a clean callback
      return this.client.ws.futuresUser(callback); 
      // Note: For Futures it is usually futuresUser, or user with specific config. 
      // binance-api-node distinguishes user() for spot and futuresUser() for futures?
      // Checking standard library usage: usually client.ws.futuresUser(callback) for futures.
    } catch (error) {
      logger.error('Failed to subscribe to Binance User Stream', error);
      throw error;
    }
  }

  /**
   * Get Order Status
   * @param {string} symbol 
   * @param {string} orderId 
   * @returns {Promise<string>} Order status
   */
  async getOrderStatus(symbol, orderId) {
    try {
      const order = await this.client.futuresGetOrder({
        symbol: symbol,
        orderId: orderId.toString()
      });
      return order.status;
    } catch (error) {
      // If order not found (e.g. -2013), throw or return null
      throw error;
    }
  }

  /**
   * Get Futures Account Info (V2)
   * @returns {Promise<object>} Account information including balances
   */
  async futuresAccountInfo() {
    try {
      // Use V2 endpoint typically
      return await this.client.futuresAccountInfo();
    } catch (error) {
      logger.error('Binance Account Info Failed', error);
      throw error;
    }
  }

  /**
   * Get Futures Position Risk (V2)
   * @returns {Promise<Array>} Position risk information
   */
  async futuresPositionRisk() {
    try {
      return await this.client.futuresPositionRisk();
    } catch (error) {
      logger.error('Binance Position Risk Failed', error);
      throw error;
    }
  }


  /**
   * Get detailed position info (amount, entry price, unrealized profit)
   * @param {string} coin 
   * @returns {Promise<object|null>} Position details or null
   */
  async getPositionDetails(coin) {
    try {
      const symbol = this.getBinanceSymbol(coin);
      const positions = await this.futuresPositionRisk();
      const position = positions.find(p => p.symbol === symbol);
      
      if (!position) return null;
      
      return {
        amount: parseFloat(position.positionAmt),
        entryPrice: parseFloat(position.entryPrice),
        unRealizedProfit: parseFloat(position.unRealizedProfit),
        leverage: parseInt(position.leverage),
        liquidationPrice: parseFloat(position.liquidationPrice)
      };
    } catch (error) {
      logger.error(`Failed to get position details for ${coin}`, error);
      return null;
    }
  }

  /**
   * Create a Reduce-Only limit order (for Take Profit)
   * @param {string} coin 
   * @param {string} side 'B' or 'A' (BUY or SELL)
   * @param {number|string} price 
   * @param {number|string} quantity 
   */
  async createReduceOnlyOrder(coin, side, price, quantity) {
    const symbol = this.getBinanceSymbol(coin);
    const binanceSide = side === 'B' ? 'BUY' : 'SELL';
    
    // Ensure Price Precision
    const formattedPrice = this.roundPrice(coin, price);
    
    logger.info(`Placing REDUCE-ONLY order on Binance: ${symbol} ${binanceSide} ${quantity} @ ${formattedPrice}`);

    try {
      const order = await this.client.futuresOrder({
        symbol: symbol,
        side: binanceSide,
        type: 'LIMIT',
        timeInForce: 'GTC', 
        quantity: quantity.toString(),
        price: formattedPrice,
        reduceOnly: true // Vital for TP
      });
      
      logger.info(`Binance REDUCE-ONLY Order Placed: ${order.orderId}`);
      return order;
    } catch (error) {
      const errorMsg = `Binance Reduce-Only Order Failed: ${error.message} (Code: ${error.code})`;
      logger.error(errorMsg, {
        message: error.message,
        code: error.code,
        response: error.response?.data,
        params: { symbol, side: binanceSide, price, quantity }
      });
      throw error;
    }
  }

  /**
   * Cancel and Replace order (Atomic)
   * @param {string} coin 
   * @param {string} cancelOrderId 
   * @param {string} side 
   * @param {number|string} price 
   * @param {number|string} quantity 
   * @param {boolean} reduceOnly 
   */
  async cancelReplaceOrder(coin, cancelOrderId, side, price, quantity, reduceOnly = false) {
    const symbol = this.getBinanceSymbol(coin);
    const binanceSide = side === 'B' ? 'BUY' : 'SELL';
    const formattedPrice = this.roundPrice(coin, price);

    logger.info(`Atomic Cancel/Replace for ${coin}: Cancel ${cancelOrderId}, Place ${binanceSide} ${quantity} @ ${formattedPrice}`);

    const params = {
      symbol: symbol,
      side: binanceSide,
      type: 'LIMIT',
      timeInForce: 'GTC',
      quantity: quantity.toString(),
      price: formattedPrice,
      cancelOrderId: cancelOrderId.toString(),
      cancelReplaceMode: 'ALLOW_FAILURE' // If cancel fails, still try to place? Or STOP_ON_FAILURE? usually STOP_ON_FAILURE is safer to avoid over-position
    };

    if (reduceOnly) {
      params.reduceOnly = true;
    }

    try {
      // Check if library supports it
      if (typeof this.client.futuresCancelReplace === 'function') {
        const result = await this.client.futuresCancelReplace(params);
        logger.info(`Binance Cancel/Replace Success. New Order: ${result.newOrderResponse.orderId}`);
        return result.newOrderResponse; // Return the new order structure
      } else {
        // Fallback for older library versions: Manual sequence
        logger.warn('Library does not support futuresCancelReplace. Using sequential fallback.');
        await this.cancelOrder(symbol, cancelOrderId);
        return await this.createLimitOrder(coin, side, price, quantity, reduceOnly);
      }
    } catch (error) {
       // If standard error, log it
       logger.error(`Cancel/Replace Failed: ${error.message}`, {
         code: error.code,
         params
       });
       throw error;
    }
  }

  /**
   * Get current signed position amount for a coin
   * @param {string} coin 
   * @returns {Promise<number>} Signed position amount (Positive=Long, Negative=Short)
   */
  async getPosition(coin) {
    try {
      const symbol = this.getBinanceSymbol(coin);
      const positions = await this.futuresPositionRisk();
      const position = positions.find(p => p.symbol === symbol);
      return position ? parseFloat(position.positionAmt) : 0;
    } catch (error) {
      logger.error(`Failed to get position for ${coin}`, error);
      return 0; // Default to 0 (no position) on error to be safe
    }
  }

  /**
   * Get total quantity of open orders on a specific side
   * @param {string} coin 
   * @param {string} side 'BUY' or 'SELL'
   * @returns {Promise<number>}
   */
  async getOpenOrderQuantity(coin, side) {
    try {
      const symbol = this.getBinanceSymbol(coin);
      const openOrders = await this.client.futuresOpenOrders({ symbol });
      return openOrders
        .filter(o => o.side === side)
        .reduce((sum, o) => sum + parseFloat(o.origQty), 0);
    } catch (error) {
      logger.error(`Failed to get open order quantity for ${coin}`, error);
      return 0;
    }
  }
}

module.exports = new BinanceClient();
