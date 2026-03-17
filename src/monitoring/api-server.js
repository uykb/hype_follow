const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const helmet = require('helmet');
const config = require('config');
const path = require('path');
const logger = require('../utils/logger');
const dataCollector = require('./data-collector');

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

  // --- Public API Routes (No Auth Required) ---

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

  // --- WebSocket Logic (No Auth) ---

  wss.on('connection', (ws, req) => {
    logger.debug(`WS connection from ${req.socket.remoteAddress}`);
    
    logger.info('Monitoring client connected');
    
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
