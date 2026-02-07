const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const helmet = require('helmet');
const config = require('config');
const path = require('path');
const logger = require('../utils/logger');
const dataCollector = require('./data-collector');
const orderValidator = require('../core/order-validator');

const authUtil = require('../utils/auth-util');
const authMiddleware = require('../middleware/auth-middleware');

const PORT = process.env.MONITORING_PORT || 49618;

function startServer() {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server });

  app.use(helmet({
    contentSecurityPolicy: false, // Disable CSP for easier development/local usage
  }));
  app.use(cors());
  app.use(express.json());

  // --- Admin & Auth Routes ---
  
  app.get('/api/admin/status', async (req, res) => {
    const configured = await authUtil.isConfigured();
    res.json({ configured });
  });

  app.get('/api/admin/setup-qr', async (req, res) => {
    const configured = await authUtil.isConfigured();
    if (configured) {
      return res.status(403).json({ error: 'System already configured' });
    }
    const data = await authUtil.generateSetupData();
    res.json(data);
  });

  app.post('/api/admin/setup', async (req, res) => {
    const configured = await authUtil.isConfigured();
    if (configured) {
      return res.status(403).json({ error: 'System already configured' });
    }
    const { token, secret } = req.body;
    if (authUtil.verifyToken(token, secret)) {
      await authUtil.saveSecret(secret);
      const jwt = authUtil.generateJWT();
      res.json({ success: true, token: jwt });
    } else {
      res.status(400).json({ error: 'Invalid token' });
    }
  });

  app.post('/api/admin/login', async (req, res) => {
    const { token } = req.body;
    const secret = await authUtil.getSecret();
    if (!secret) {
      return res.status(403).json({ error: 'System not configured' });
    }
    if (authUtil.verifyToken(token, secret)) {
      const jwt = authUtil.generateJWT();
      res.json({ success: true, token: jwt });
    } else {
      res.status(400).json({ error: 'Invalid token' });
    }
  });

  // --- Protected API Routes ---
  app.use('/api', authMiddleware);

  app.get('/api/snapshot', (req, res) => {
    res.json(dataCollector.getSnapshot());
  });

  app.get('/api/logs', (req, res) => {
    res.json(dataCollector.recentLogs);
  });

  app.get('/api/config', (req, res) => {
    // Return non-sensitive config
    const safeConfig = {
      trading: {
        mode: config.get('trading.mode'),
        fixedRatio: config.get('trading.fixedRatio'),
        equalRatio: config.get('trading.equalRatio'),
        minOrderSize: config.get('trading.minOrderSize')
      },
      riskControl: {
        supportedCoins: config.get('riskControl.supportedCoins'),
        reductionThreshold: config.get('riskControl.reductionThreshold')
      },
      hyperliquid: {
        followedUsers: config.get('hyperliquid.followedUsers')
      }
    };
    res.json(safeConfig);
  });

  // --- Manual Trading Routes ---

  app.get('/api/trade/open-orders', async (req, res) => {
    try {
      const orders = await binanceClient.client.futuresOpenOrders();
      res.json(orders);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/trade/manual', async (req, res) => {
    try {
      const { symbol, side, type, price, quantity } = req.body;
      const coin = symbol.replace('USDT', '');
      
      let result;
      if (type === 'LIMIT') {
        result = await binanceClient.createLimitOrder(coin, side === 'BUY' ? 'B' : 'A', price, quantity, false);
      } else {
        result = await binanceClient.createMarketOrder(coin, side === 'BUY' ? 'B' : 'A', quantity, false);
      }
      
      res.json({ success: true, order: result });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/api/trade/cancel', async (req, res) => {
    try {
      const { symbol, orderId } = req.body;
      await binanceClient.cancelOrder(symbol, orderId);
      res.json({ success: true });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post('/api/config/update', async (req, res) => {
    // In a real scenario, we'd write to a file or Redis.
    // For this MVP, we'll log it and acknowledge.
    // NOTE: In production, you'd want to persist this to config/local.json or Redis.
    logger.info('Config update received (MVP - not yet persisted to disk)', req.body);
    res.json({ success: true, message: 'Settings updated successfully (Note: Changes may require restart)' });
  });

  app.get('/api/orders/validate', async (req, res) => {
    try {
      const report = await orderValidator.getReport();
      res.json(report);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Serve static files from dashboard build (if exists)
  const dashboardPath = path.join(__dirname, '../../dashboard/dist');
  app.use(express.static(dashboardPath));

  // Catch-all for React Router
  app.get(/(.*)/, (req, res) => {
    if (req.path.startsWith('/api')) {
      return res.status(404).json({ error: 'Not Found' });
    }
    res.sendFile(path.join(dashboardPath, 'index.html'), (err) => {
      if (err) {
        res.status(200).send('<h1>HypeFollow Monitor API</h1><p>Dashboard build not found. API is running.</p>');
      }
    });
  });

  // --- WebSocket Logic ---

  wss.on('connection', (ws, req) => {
    logger.debug(`WS connection attempt from ${req.socket.remoteAddress} with URL: ${req.url}`);
    
    // Auth via Query Parameter
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const token = url.searchParams.get('token');

    const decoded = authUtil.verifyJWT(token);
    if (!decoded) {
      logger.warn(`Unauthorized WS connection attempt from ${req.socket.remoteAddress}`, { 
        url: req.url,
        hasToken: !!token 
      });
      ws.close(4001, 'Unauthorized');
      return;
    }

    logger.info('Authenticated monitoring client connected');
    
    // Send initial snapshot
    ws.send(JSON.stringify({ type: 'snapshot', data: dataCollector.getSnapshot() }));
    ws.send(JSON.stringify({ type: 'logs', data: dataCollector.recentLogs }));

    ws.on('close', () => {
      logger.info('Monitoring client disconnected');
    });
  });

  // Broadcast updates from collector
  dataCollector.on('update', (data) => {
    const message = JSON.stringify({ type: 'update', data });
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  });

  dataCollector.on('log', (log) => {
    const message = JSON.stringify({ type: 'log', data: log });
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  });

  server.listen(PORT, '0.0.0.0', () => {
    logger.info(`Monitoring API Server running on http://0.0.0.0:${PORT}`);
  });

  dataCollector.start();
}

if (require.main === module) {
  startServer();
}

module.exports = { startServer };
