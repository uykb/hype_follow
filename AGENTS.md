# HypeFollow Agent Guidelines

This document provides comprehensive instructions for AI agents (and human developers) working on the HypeFollow repository (Go Version).
It covers build commands, code style, architecture, and workflow rules to ensure consistency and stability.

## 1. Build, Lint, and Test Commands

### Backend (Root)
The backend is a Node.js application implementing an automated trading system that replicates orders from Hyperliquid to Binance.

- **Dependencies**: `npm install`
- **Run**: `npm start`
- **Development**: `npm run dev`

### Dashboard (Frontend)
The `dashboard/` directory contains a **read-only monitoring interface** built with React and Vite. It displays real-time system status without authentication or manual trading capabilities.

- **Setup**: `cd dashboard && npm install`
- **Development**: `cd dashboard && npm run dev`
- **Build**: `cd dashboard && npm run build`
- **Access**: Dashboard is served at the same port as the API (default: 49618)

## 2. Code Style & Conventions

Follow standard Go conventions (Effective Go).

### General
*   **Language**: Go 1.22+
*   **Formatting**: Always run `gofmt` (or let IDE handle it).
*   **Linting**: Use `golangci-lint` if available.
*   **Configuration**: Use `Viper` (`config.yaml`).
    *   Secrets must be loaded from environment variables or secure config files.
    *   Never hardcode API keys.

### Project Layout
*   `src/index.js`: Application entry point.
*   `src/core/`: Business logic (Order Executor, Risk Control, Position Tracker).
*   `src/exchange/`: Exchange adapters (Binance, Hyperliquid).
*   `src/monitoring/`: API server and data collector for the dashboard.
*   `src/utils/`: Utility functions (Logger, Redis, etc.).
*   `dashboard/`: Read-only React monitoring interface.

### Naming
*   **Files**: `snake_case.go` (e.g., `ws_client.go`).
*   **Structs/Interfaces**: `PascalCase` (e.g., `RiskManager`, `OrderExecutor`).
*   **Variables**: `camelCase` for local, `PascalCase` for exported.
*   **Constants**: `PascalCase` or `UPPER_CASE` depending on context, but prefer typed constants.

### Error Handling
*   **Return Errors**: Functions should return `error` as the last return value.
*   **Wrapping**: Use `fmt.Errorf("context: %w", err)` to wrap errors.
*   **Logging**: Use `pkg/logger` (Zap).
    *   `logger.Log.Info("Order placed", zap.String("oid", oid))`
    *   `logger.Log.Error("Failed to sync", zap.Error(err))`

## 3. Architecture Overview

The system uses an **Event-Driven Architecture** with real-time data synchronization.

### Core Components
1.  **Order Executor** (`src/core/order-executor.js`): Main execution logic for replicating orders.
2.  **Position Tracker** (`src/core/position-tracker.js`): Tracks positions across exchanges.
3.  **Risk Control** (`src/core/risk-control.js`): Validates trades against risk limits.
4.  **Consistency Engine** (`src/core/consistency-engine.js`): Ensures order consistency between exchanges.
5.  **Hyperliquid Adapter** (`src/hyperliquid/`):
    *   WebSocket Client: Listens for `orderUpdates` and `userFills`.
    *   HTTP Client: Fetches account data.
6.  **Binance Adapter** (`src/binance/`):
    *   API Client: Places orders, fetches equity.
    *   WebSocket User Stream: Listens for execution reports.
7.  **Monitoring Dashboard** (`src/monitoring/` + `dashboard/`):
    *   **Read-only display**: Shows real-time system status, positions, equity, and logs.
    *   **No authentication**: Direct access without login.
    *   **No trading controls**: Cannot place or cancel orders manually.
    *   **WebSocket updates**: Real-time data stream via WebSocket.

### Data Flow
1.  **HL WS** receives `Order` event.
2.  **Order Executor** validates and calculates position size.
3.  **Risk Control** performs pre-trade checks.
4.  **Binance Client** places the corresponding order.
5.  **Monitoring** displays real-time updates via WebSocket.

## 4. Agent Workflow Rules

1.  **Analyze First**: Understand the FSM state transitions before modifying logic.
2.  **Concurrency Safety**:
    *   FSMs are single-threaded actors. Do not share mutable state across FSMs without locks.
    *   Use `sync.RWMutex` for shared components like `AccountManager`.
3.  **Mocking**: Use interfaces for external dependencies to facilitate testing.
4.  **Configuration**: Add new config fields to `config.yaml` and `internal/config/structs.go`.
5.  **Metrics**: Update `pkg/metrics` when adding new critical paths.

## 5. Common Pitfalls
-   **Blocking the Event Loop**: FSM handlers must be fast. Offload heavy IO if necessary (though network IO is async in Go, avoid long sleeps).
-   **Precision Issues**: Use `decimal.js` for all money/quantity calculations. Never use JavaScript floating-point math for financial logic.
-   **Context Cancellation**: Respect `context.Context` for graceful shutdowns and timeouts.
