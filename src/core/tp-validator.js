/**
 * TP Validator
 * 
 * 专门用于验证和同步止盈单
 * 确保：
 * 1. 有持仓就有对应数量的止盈单
 * 2. 止盈单价格与HL同步
 * 3. 无持仓时清除所有止盈单
 * 4. 定期检查和修复
 */

const logger = require('../utils/logger');
const config = require('config');
const store = require('../utils/memory-store');
const binanceClient = require('../binance/api-client');
const orderMapper = require('./order-mapper');

class TPValidator {
  constructor() {
    this.martingaleAddress = '0xdc899ed4a80e7bbe7c86307715507c828901f196';
    this.validationInterval = null;
    this.isRunning = false;
  }

  /**
   * 启动定期验证
   */
  start() {
    if (this.isRunning) return;
    
    const interval = config.get('trading.tpValidationIntervalMs') || 10000; // 默认10秒
    logger.info(`[TPValidator] Starting TP validation (interval: ${interval}ms)`);
    
    this.isRunning = true;
    this.validationInterval = setInterval(async () => {
      try {
        await this.validateAllCoins();
      } catch (error) {
        logger.error('[TPValidator] Error in validation cycle', error);
      }
    }, interval);
  }

  /**
   * 停止定期验证
   */
  stop() {
    if (this.validationInterval) {
      clearInterval(this.validationInterval);
      this.validationInterval = null;
      this.isRunning = false;
      logger.info('[TPValidator] Stopped');
    }
  }

  /**
   * 验证所有币种
   */
  async validateAllCoins() {
    const supportedCoins = config.get('riskControl.supportedCoins') || ['HYPE'];
    
    for (const coin of supportedCoins) {
      await this.validateTakeProfitForCoin(coin);
    }
  }

  /**
   * 验证特定币种的止盈单
   * 核心逻辑：
   * - 有持仓 -> 必须有等量的止盈单
   * - 无持仓 -> 必须无止盈单
   * - 价格必须与HL最高卖单同步
   */
  async validateTakeProfitForCoin(coin) {
    try {
      const userAddress = this.martingaleAddress;
      
      // 1. 获取Binance持仓
      const position = await binanceClient.getPositionDetails(coin);
      const currentPos = position ? Math.abs(position.amount) : 0;
      
      // 2. 获取当前Binance止盈单
      const symbol = binanceClient.getBinanceSymbol(coin);
      const openOrders = await binanceClient.client.futuresOpenOrders({ symbol });
      const tpOrders = openOrders.filter(o => o.side === 'SELL' && o.reduceOnly === true);
      
      // 3. 计算当前止盈单总数量
      const currentTpQuantity = tpOrders.reduce((sum, o) => sum + parseFloat(o.origQty), 0);
      
      // 4. 从store获取跟踪的TP订单ID
      const trackedTpId = await store.get(`exposure:tp:${coin}`);
      
      logger.debug(`[TPValidator] ${coin}: Position=${currentPos.toFixed(4)}, TPQty=${currentTpQuantity.toFixed(4)}, TrackedTP=${trackedTpId || 'none'}`);
      
      // 情况1：无持仓但存在止盈单 -> 清除所有止盈单
      if (currentPos < 0.01 && tpOrders.length > 0) {
        logger.info(`[TPValidator] ${coin}: No position but ${tpOrders.length} TP orders exist. Cancelling all...`);
        for (const order of tpOrders) {
          try {
            await binanceClient.cancelOrder(symbol, order.orderId);
            logger.info(`[TPValidator] Cancelled TP order ${order.orderId}`);
          } catch (err) {
            logger.warn(`[TPValidator] Failed to cancel TP order ${order.orderId}: ${err.message}`);
          }
        }
        await store.del(`exposure:tp:${coin}`);
        await store.del(`martingale:last_tp:${userAddress}:${coin}`);
        return;
      }
      
      // 情况2：有持仓但无止盈单 -> 从HL创建
      if (currentPos >= 0.01 && tpOrders.length === 0) {
        logger.info(`[TPValidator] ${coin}: Position=${currentPos} but no TP orders. Creating from HL...`);
        await this.createTPFromHL(coin, userAddress, currentPos);
        return;
      }
      
      // 情况3：有持仓但止盈单数量不匹配 -> 重新同步
      if (currentPos >= 0.01 && tpOrders.length > 0) {
        const quantityDiff = Math.abs(currentPos - currentTpQuantity);
        if (quantityDiff > 0.01) {
          logger.info(`[TPValidator] ${coin}: Quantity mismatch. Position=${currentPos.toFixed(4)}, TPQty=${currentTpQuantity.toFixed(4)}. Resyncing...`);
          await this.resyncTPOrder(coin, userAddress, currentPos, tpOrders);
          return;
        }
      }
      
      // 情况4：验证价格是否与HL同步
      if (currentPos >= 0.01 && tpOrders.length > 0) {
        await this.validateTPPrice(coin, userAddress, tpOrders);
      }
      
    } catch (error) {
      logger.error(`[TPValidator] Error validating ${coin}`, error);
    }
  }

  /**
   * 从HL创建止盈单
   */
  async createTPFromHL(coin, userAddress, positionSize) {
    try {
      const apiClient = require('../hyperliquid/api-client');
      const symbol = binanceClient.getBinanceSymbol(coin);
      
      // 获取HL最高价格卖单（止盈单）
      let retries = 3;
      let tpOrder = null;
      
      while (retries > 0 && !tpOrder) {
        const hlOrders = await apiClient.getUserOpenOrders(userAddress, coin);
        const sellOrders = hlOrders ? hlOrders.filter(o => o.side === 'A') : [];
        
        if (sellOrders.length > 0) {
          // 按价格降序排列，取最高价（止盈单）
          sellOrders.sort((a, b) => parseFloat(b.limitPx) - parseFloat(a.limitPx));
          tpOrder = sellOrders[0];
          break;
        }
        
        retries--;
        if (retries > 0) {
          logger.info(`[TPValidator] ${coin}: No HL sell orders found, retrying in 2s... (${retries} retries left)`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
      
      if (!tpOrder) {
        logger.warn(`[TPValidator] ${coin}: No HL sell orders found after retries. Cannot create TP.`);
        return;
      }
      
      const tpPrice = parseFloat(tpOrder.limitPx);
      
      logger.info(`[TPValidator] Creating TP order: SELL ${positionSize} @ ${tpPrice} (from HL oid: ${tpOrder.oid})`);
      
      const newOrder = await binanceClient.createLimitOrder(
        coin, 'A', tpPrice, positionSize, true // reduceOnly
      );
      
      if (newOrder && newOrder.orderId) {
        await orderMapper.saveMapping(userAddress, tpOrder.oid, newOrder.orderId, symbol);
        await store.set(`exposure:tp:${coin}`, newOrder.orderId.toString());
        await store.set(`martingale:last_tp:${userAddress}:${coin}`, JSON.stringify({
          oid: tpOrder.oid.toString(),
          price: tpPrice.toString(),
          quantity: positionSize,
          orderId: newOrder.orderId.toString()
        }), 'EX', 86400);
        
        logger.info(`[TPValidator] Created TP order: ${newOrder.orderId}`);
      }
      
    } catch (error) {
      logger.error(`[TPValidator] Failed to create TP from HL for ${coin}`, error);
    }
  }

  /**
   * 重新同步止盈单（数量和价格）
   */
  async resyncTPOrder(coin, userAddress, positionSize, existingTpOrders) {
    try {
      const apiClient = require('../hyperliquid/api-client');
      const symbol = binanceClient.getBinanceSymbol(coin);
      
      // 取消所有现有止盈单
      for (const order of existingTpOrders) {
        try {
          await binanceClient.cancelOrder(symbol, order.orderId);
          logger.info(`[TPValidator] Cancelled existing TP order ${order.orderId} for resync`);
        } catch (err) {
          logger.warn(`[TPValidator] Failed to cancel TP order ${order.orderId}: ${err.message}`);
        }
      }
      
      // 等待取消完成
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // 重新创建
      await this.createTPFromHL(coin, userAddress, positionSize);
      
    } catch (error) {
      logger.error(`[TPValidator] Failed to resync TP for ${coin}`, error);
    }
  }

  /**
   * 验证止盈单价格是否与HL同步
   */
  async validateTPPrice(coin, userAddress, existingTpOrders) {
    try {
      const apiClient = require('../hyperliquid/api-client');
      
      // 获取HL最高卖单价格
      const hlOrders = await apiClient.getUserOpenOrders(userAddress, coin);
      const sellOrders = hlOrders ? hlOrders.filter(o => o.side === 'A') : [];
      
      if (sellOrders.length === 0) {
        // HL没有卖单，但Binance有止盈单 -> 可能是HL止盈已触发
        logger.info(`[TPValidator] ${coin}: No HL sell orders but Binance has TP. HL TP might be filled.`);
        return;
      }
      
      // 按价格降序排列
      sellOrders.sort((a, b) => parseFloat(b.limitPx) - parseFloat(a.limitPx));
      const hlTpPrice = parseFloat(sellOrders[0].limitPx);
      const hlTpOid = sellOrders[0].oid;
      
      // 检查Binance TP价格是否匹配
      for (const tpOrder of existingTpOrders) {
        const binancePrice = parseFloat(tpOrder.price);
        const priceDiff = Math.abs(binancePrice - hlTpPrice);
        const priceDiffPercent = priceDiff / hlTpPrice;
        
        // 如果价格差异超过0.1%，需要更新
        if (priceDiffPercent > 0.001) {
          logger.info(`[TPValidator] ${coin}: Price mismatch. Binance=${binancePrice}, HL=${hlTpPrice}. Updating...`);
          
          const position = await binanceClient.getPositionDetails(coin);
          const positionSize = position ? Math.abs(position.amount) : 0;
          
          if (positionSize > 0) {
            await this.resyncTPOrder(coin, userAddress, positionSize, existingTpOrders);
          }
          return;
        }
      }
      
    } catch (error) {
      logger.error(`[TPValidator] Error validating TP price for ${coin}`, error);
    }
  }

  /**
   * 强制同步TP（供外部调用）
   */
  async forceSyncTP(coin) {
    logger.info(`[TPValidator] Force syncing TP for ${coin}`);
    await this.validateTakeProfitForCoin(coin);
  }
}

module.exports = new TPValidator();
