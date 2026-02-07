const config = require('config');
const logger = require('../utils/logger');
const redis = require('../utils/redis');
const binanceClient = require('../binance/api-client');
const hyperApiClient = require('../hyperliquid/api-client');

class ExposureManager {
  constructor() {
    // Mode configs
    this.tradingMode = config.get('trading.mode');
    this.fixedRatio = config.get('trading.fixedRatio');
    this.equalRatio = config.get('trading.equalRatio');
    
    // Profit target percent (e.g. 0.0015 for 0.15%)
    this.profitTarget = 0.0015;
    this.driftThreshold = 0.01; // 1% 偏离度阈值
  }

  /**
   * 全量对账逻辑：对比所有支持的币种并修复漂移
   * @param {string} masterAddress 
   */
  async reconcileAll(masterAddress) {
    logger.info(`[Reconciler] 启动全局对账循环...`);
    const supportedCoins = config.get('riskControl.supportedCoins');
    for (const coin of supportedCoins) {
      await this.checkAndRebalance(coin, masterAddress);
    }
    logger.info(`[Reconciler] 全局对账完成。`);
  }

  /**
   * 检查并修复仓位漂移
   * @param {string} coin 
   * @param {string} masterAddress 
   */
  async checkAndRebalance(coin, masterAddress) {
    try {
      // 1. 获取大师仓位
      const masterPositions = await hyperApiClient.getUserPositions(masterAddress);
      const masterPosObj = masterPositions.find(p => p.coin === coin);
      const masterSize = masterPosObj ? parseFloat(masterPosObj.szi) : 0;

      // 2. 获取币安仓位
      const followerPos = await binanceClient.getPositionDetails(coin);
      if (!followerPos) return;
      const followerSize = followerPos.amount;
      const absFollower = Math.abs(followerSize);

      // 4.1 核心风控：硬性阈值强制减半 (Circuit Breaker)
      const reductionThreshold = config.get('riskControl.reductionThreshold')[coin] || 999999;
      if (absFollower >= reductionThreshold) {
        logger.warn(`[Reconciler] ${coin} 触发硬性风控阈值 (${absFollower} >= ${reductionThreshold})，执行强制减半！`);
        await this.fixDrift(coin, followerSize > 0 ? 'A' : 'B', absFollower / 2);
        return; // 强制减半后结束本次对账
      }

      // 4.2 计算目标仓位
      let targetSize = 0;
      if (this.tradingMode === 'fixed') {
        targetSize = masterSize * this.fixedRatio;
      } else if (this.tradingMode === 'equal') {
        const hlEquity = await require('./account-manager').getHyperliquidTotalEquity(masterAddress);
        const bnEquity = await require('./account-manager').getBinanceTotalEquity();
        if (hlEquity > 0) {
          targetSize = masterSize * (bnEquity / hlEquity) * this.equalRatio;
        }
      }

      // 4. 计算漂移量 (Drift)
      // Drift = 目标 - 实际。正数代表需要买入补仓，负数代表需要卖出减仓。
      const drift = targetSize - followerSize;
      const absDrift = Math.abs(drift);
      const minSize = config.get('trading.minOrderSize')[coin] || 0;

      // 5. 判定是否需要修复
      // 策略：如果偏差大于最小下单量，且 (偏差占比 > 1% 或 这是一个新的仓位/平仓动作)
      const shouldFix = absDrift >= minSize && (
        (Math.abs(targetSize) > 0 && absDrift / Math.abs(targetSize) > this.driftThreshold) ||
        (Math.abs(targetSize) === 0 && absDrift >= minSize)
      );

      if (!shouldFix) {
        logger.debug(`[Reconciler] ${coin} 处于平衡状态，无需对账。`);
        return;
      }

      logger.warn(`[Reconciler] 检测到仓位漂移 [${coin}]: 目标=${targetSize}, 实际=${followerSize}, 偏差=${drift}`);

      // 6. 执行修复动作
      if (drift > 0) {
        // 欠仓：补仓 (Buy)
        await this.fixDrift(coin, 'B', absDrift, masterPosObj?.entryPx);
      } else {
        // 超仓：减仓 (Sell)
        await this.fixDrift(coin, 'A', absDrift, masterPosObj?.entryPx);
      }

      // 7. 对账后重置该币种的 Delta 记录，防止与 WS 增量冲突
      await require('./position-tracker').consumePendingDelta(coin, 0); // 清零

    } catch (error) {
      logger.error(`[Reconciler] 对账失败 ${coin}`, error);
    }
  }

  /**
   * 执行对账修复订单
   */
  async fixDrift(coin, side, quantity, refPrice) {
    try {
      const isMarket = config.get('app.env') === 'production'; // 生产环境纠偏用市价单保证对齐
      let order;
      
      if (isMarket) {
        logger.info(`[Reconciler] 执行市价对账订单: ${coin} ${side} ${quantity}`);
        order = await binanceClient.createMarketOrder(coin, side, quantity, false);
      } else {
        // 非生产环境建议先用现价对齐
        const price = refPrice || await binanceClient.getMarkPrice(coin);
        logger.info(`[Reconciler] 执行限价对账订单: ${coin} ${side} ${quantity} @ ${price}`);
        order = await binanceClient.createLimitOrder(coin, side, price, quantity, false);
      }

      if (order && order.orderId) {
        logger.info(`[Reconciler] 对账订单已下单: ${order.orderId}`);
      }
    } catch (e) {
      logger.error(`[Reconciler] 执行修复订单失败: ${e.message}`);
    }
  }

  // Helper from position-calculator logic (simplified)
  roundQuantity(quantity, coin) {
    const decimals = {
      BTC: 3,
      ETH: 3,
      SOL: 1,
      DEFAULT: 3
    };
    const precision = decimals[coin] || decimals.DEFAULT;
    const factor = Math.pow(10, precision);
    return Math.round(quantity * factor) / factor;
  }
}

module.exports = new ExposureManager();
