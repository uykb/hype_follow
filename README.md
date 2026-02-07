# HypeFollow 🚀

![Version](https://img.shields.io/badge/version-1.2.0-blue.svg?style=for-the-badge)
![License](https://img.shields.io/badge/license-MIT-green.svg?style=for-the-badge)
![Status](https://img.shields.io/badge/status-active-success.svg?style=for-the-badge)

**HypeFollow** is an advanced, automated copy-trading system that synchronizes "Smart Money" movements from **Hyperliquid** (DEX) directly to your **Binance Futures** (CEX) account in real-time.

Designed for high-performance and reliability, HypeFollow bridges the gap between on-chain transparency and CEX liquidity with a focus on security and precise monitoring.

---

## ✨ Key Features

### 🔄 Dual-Channel Synchronization
*   **Limit Order Sync**: Real-time tracking of `orderUpdates`. Creates, modifies, and cancels limit orders instantly to match the master.
*   **Market Execution Sync**: Listens to `userFills` to capture aggressive market entries/exits.
*   **Event Serialization**: Per-order task queues prevent race conditions during rapid "Cancel + Add" sequences.

### ⚖️ Smart Position Management
*   **Multiple Modes**:
    *   **Equal Mode**: Scales position size based on the equity ratio between Master (HL) and Follower (Binance).
    *   **Fixed Mode**: Follows using a fixed multiplier ratio.
*   **Pending Delta Tracking**: Automatically accumulates small adjustments that fall below Binance's minimum order size and executes them once the threshold is met.

### 🛡️ Secure Administration
*   **TOTP Authentication**: Secured by Google Authenticator / 2FA. No hardcoded passwords.
*   **JWT Authorization**: All API and WebSocket connections are protected by short-lived, secure tokens.
*   **Auto-Logout**: Session-based storage ensures you are logged out when the browser tab is closed.

### 📊 Real-time Monitoring & Control
*   **Drift Detection**: Real-time calculation of "Target vs Actual" position drift. Highlighting discrepancies for manual review.
*   **Dynamic Configuration**: Modify trading modes and multipliers directly from the dashboard without restarting the service.
*   **Live Metrics**: Integrated PnL tracking, equity charts, and streaming system logs.

---

## 🚀 Quick Start

### Prerequisites
*   **Binance Futures Account**: API Key & Secret (Enable Futures, Disable Withdrawals).
*   **Hyperliquid Address**: The public wallet address of the trader(s) you want to follow.
*   **Authenticator App**: Google Authenticator, 1Password, or similar for 2FA setup.

### Deployment (Docker Compose)

1. Create a `docker-compose.yml`:
```yaml
version: '3.8'
services:
  hypefollow:
    image: ghcr.io/uykb/hypefollow:main
    container_name: hypefollow
    ports:
      - "49618:49618"
    environment:
      - BINANCE_API_KEY=your_key
      - BINANCE_API_SECRET=your_secret
      - TRADING_MODE=fixed
      - FIXED_RATIO=0.1
      - JWT_SECRET=your_random_secret_string
    volumes:
      - ./data:/root/HypeFollow/data
    restart: unless-stopped
```

2. Start the system:
```bash
docker-compose up -d
```

3. **Initial Setup**:
   - Access `http://your-server-ip:49618`.
   - On first run, you will see a **Setup QR Code**.
   - Scan it with your Authenticator app and enter the 6-digit code to bind your device.

---

## ⚙️ Configuration

### Environment Variables
| Variable | Description | Default |
| :--- | :--- | :--- |
| `BINANCE_API_KEY` | Binance API Key | **Required** |
| `BINANCE_API_SECRET` | Binance API Secret | **Required** |
| `TRADING_MODE` | `equal` or `fixed` | `fixed` |
| `FIXED_RATIO` | Multiplier for Fixed mode | `0.1` |
| `JWT_SECRET` | Secret key for auth tokens | `random-string` |
| `MONITORING_PORT` | Dashboard Port | `49618` |

### Manual Auth Reset
If you lose your Authenticator device, you can reset the security configuration by running:
```bash
# Inside the container
npm run reset-auth
```

---

## 📉 Position Drift Monitoring

HypeFollow tracks the difference between your **Actual Position** and the **Target Position** (Master Position * Ratio).

*   **Why Drift Happens**: Binance's minimum order requirements ($5-$20) or network latency can cause small deviations.
*   **Monitoring**: The dashboard highlights any drift > 1% in yellow.
*   **Action**: HypeFollow **does not** automatically execute corrective trades to avoid "fighting" with active orders. It is recommended to review large drifts manually.

---

## 🖥️ Dashboard Overview

- **Equity Chart**: Visualizes your performance relative to the Master.
- **Positions**: Live view of Binance positions with real-time Drift metrics.
- **System Config**: UI for adjusting trading parameters on the fly.
- **Log Panel**: High-verbosity streaming logs for full transparency of execution logic.

---

## ⚠️ Disclaimer

**Trading cryptocurrencies involves significant risk.**

*   **HypeFollow** is experimental software provided "as is".
*   The developers are not responsible for any financial losses.
*   Always test with small amounts or on **Binance Testnet** first.
*   Ensure you understand the mechanics of Copy Trading (latency, slippage, and liquidation).

---

<p align="center">
  <sub>Built with ❤️ for the DeFi Community</sub>
</p>
