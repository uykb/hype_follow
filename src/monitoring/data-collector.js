const config = require('config');
const store = require('../utils/memory-store');
const logger = require('../utils/logger');
const accountManager = require('../core/account-manager');
const binanceClient = require('../binance/api-client');
const exposureManager = require('../core/exposure-manager');
const EventEmitter = require('events');

class DataCollector extends EventEmitter {
  constructor() {
    super();
    this.stats = {
      startTime: Date.now(),
      totalOrders: 0,
      totalFills: 0,
      errors: 0
    };
    this.recentLogs = [];
    this.maxLogs = 100;
    this.followedUsers = config.get('hyperliquid.followedUsers');
    this.refreshInterval = config.get('monitoring.refreshInterval') || 5000;
    this.timer = null;
    
    this.cache = {
      accounts: {
        hyperliquid: {},
        binance: { equity: 0, positions: [] }
      },
      drifts: {},
      orderMappings: [],
      history: {
        equity: [], // [{ timestamp, hlEquity, bnEquity }]
        trades: [], // [{ timestamp, symbol, side, size, price, latency, slippage }]
        latency: [] // [ms, ms, ...] for distribution
      }
    };
  }

  start() {
    this.timer = setInterval(() => this.collectData(), this.refreshInterval);
    // History collection interval (e.g., every 5 minutes for equity)
    this.historyTimer = setInterval(() => this.collectHistorySnapshot(), 60000); // 1 minute resolution for now
    this.collectData(); // Initial collection
    logger.info('Monitoring Data Collector started');
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.historyTimer) clearInterval(this.historyTimer);
  }

  addLog(level, message, meta = {}) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...meta
    };
    this.recentLogs.unshift(logEntry);
    if (this.recentLogs.length > this.maxLogs) {
      this.recentLogs.pop();
    }
    this.emit('log', logEntry);
  }

  // --- New Methods for Enhanced Data ---

  async recordTrade(tradeData) {
    // tradeData: { symbol, side, size, price, timestamp, latency, slippage, type }
    const trade = {
      ...tradeData,
      recordedAt: Date.now()
    };
    
    // Maintain fixed size buffer
    this.cache.history.trades.unshift(trade);
    if (this.cache.history.trades.length > 50) {
      this.cache.history.trades.pop();
    }
    
    // Record Latency
    if (tradeData.latency) {
      this.cache.history.latency.push(tradeData.latency);
      if (this.cache.history.latency.length > 100) {
        this.cache.history.latency.shift();
      }
    }

    this.emit('update', this.getSnapshot());
  }

  async collectHistorySnapshot() {
    try {
      // Create equity snapshot point
      const hlEquity = Object.values(this.cache.accounts.hyperliquid).reduce((a, b) => a + b, 0);
      const bnEquity = this.cache.accounts.binance.equity;
      
      if (hlEquity > 0 && bnEquity > 0) {
        const point = {
          timestamp: Date.now(),
          hlEquity,
          bnEquity
        };
        
        this.cache.history.equity.push(point);
        
        // Keep last 24h data (assuming 1 min interval = 1440 points)
        if (this.cache.history.equity.length > 1440) {
          this.cache.history.equity.shift();
        }
      }
    } catch (e) {
      logger.warn('Failed to collect history snapshot', e);
    }
  }

  async collectData() {
    try {
      // 1. Collect Account Data
      await this.collectAccountData();
      
      // 2. Collect Order Mappings from memory store
      await this.collectOrderMappings();

      this.emit('update', this.getSnapshot());
    } catch (error) {
      logger.error('Data collection failed', error);
      this.stats.errors++;
    }
  }

  async collectAccountData() {
    // Hyperliquid Equity
    for (const address of this.followedUsers) {
      try {
        const equity = await accountManager.getHyperliquidTotalEquity(address);
        this.cache.accounts.hyperliquid[address] = equity;
      } catch (e) {
        logger.warn(`Failed to fetch HL equity for ${address} in collector`);
      }
    }

    // Binance Equity & Positions
    try {
      const equity = await accountManager.getBinanceTotalEquity();
      const positionsRaw = await binanceClient.futuresPositionRisk();
      
      this.cache.accounts.binance = {
        equity,
        positions: positionsRaw.filter(p => parseFloat(p.positionAmt) !== 0).map(p => ({
          symbol: p.symbol,
          amount: p.positionAmt,
          entryPrice: p.entryPrice,
          markPrice: p.markPrice,
          unrealizedProfit: p.unrealizedProfit,
          leverage: p.leverage,
          liquidationPrice: p.liquidationPrice
        }))
      };

      // Drift calculation for the first followed user (main target)
      if (this.followedUsers.length > 0) {
        const drifts = await exposureManager.getDriftSnapshot(this.followedUsers[0]);
        this.cache.drifts = drifts;
      }
    } catch (e) {
      logger.warn('Failed to fetch Binance data in collector', e);
    }
  }

  async collectOrderMappings() {
    try {
      const keys = await store.keys('map:h2b:*');
      const mappings = [];
      for (const key of keys) {
        const val = await store.get(key);
        if (val) {
          const parsed = JSON.parse(val);
          mappings.push({
            hyperOid: key.replace('map:h2b:', ''),
            binanceOrderId: parsed.orderId,
            symbol: parsed.symbol
          });
        }
      }
      this.cache.orderMappings = mappings;
    } catch (e) {
      logger.error('Failed to collect order mappings', e);
    }
  }

  getSnapshot() {
    return {
      stats: {
        ...this.stats,
        uptime: Math.floor((Date.now() - this.stats.startTime) / 1000)
      },
      accounts: this.cache.accounts,
      drifts: this.cache.drifts,
      mappings: this.cache.orderMappings,
      history: this.cache.history, // Expose history
      config: {
        mode: config.get('trading.mode'),
        followedUsers: this.followedUsers,
        supportedCoins: config.get('riskControl.supportedCoins'),
        emergencyStop: config.get('app.emergencyStop')
      }
    };
  }
}

module.exports = new DataCollector();