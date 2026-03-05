# HypeFollow Agent Guidelines

This document provides comprehensive instructions for AI agents (and human developers) working on the HypeFollow repository.
It covers build commands, code style, architecture, and workflow rules to ensure consistency and stability.

## 1. Build, Lint, and Test Commands

### Backend (Root)
The backend is a Node.js application responsible for mirroring Hyperliquid orders to Binance.

- **Install Dependencies**: `npm install`
- **Start Application**:
  - `npm start`: Runs `src/index.js` (Production mode).
  - `npm run dev`: Runs `src/index.js` with `nodemon` for auto-restarts (Development).
  - `npm run monitor`: Runs the status monitoring server (`src/monitoring/api-server.js`).
- **Admin Auth Reset**: `npm run reset-auth` clears TOTP setup in Redis and returns the system to setup mode.
- **Environment**:
  - Uses `config` for settings (see `config/default.js`).
  - Monitoring API listens on `MONITORING_PORT` (default `49618`).

### Testing (Backend)
There is **no centralized test runner** (like Jest/Mocha) configured in `package.json`.
Tests are standalone scripts in the `tests/` directory using the built-in `assert` module.

- **Run All Tests**: There is no single command. Run them individually.
- **Run a Single Test**:
  ```bash
  node tests/test-calculation.js
  node tests/test-api-security.js
  node tests/test-order-validation.js
  node tests/test-race-serialization.js
  ```
- **Creating Tests**:
  - Create a new file in `tests/` (e.g., `tests/test-new-feature.js`).
  - Use `require('assert')` for assertions.
  - **CRITICAL**: Mock `ioredis`, `binance-api-node`, and any external calls. Do not hit real services.

### Dashboard (Frontend)
The `dashboard/` directory contains a React application built with Vite.

- **Setup**: `cd dashboard && npm install`
- **Development**: `cd dashboard && npm run dev` (Starts Vite dev server).
- **Build**: `cd dashboard && npm run build` (Outputs to `dashboard/dist/`).
- **Stack**: React + Vite + MUI. No ESLint config file present by default.

## 2. Code Style & Conventions

Follow these rules strictly to maintain codebase consistency.

### General (Backend)
*   **Runtime**: Node.js (Latest LTS).
*   **Module System**: **CommonJS** (`require` / `module.exports`).
    *   *Do not* use ES Modules (`import` / `export`) in `src/`.
*   **Configuration**: Use the `config` module (`require('config')`).
    *   Never hardcode secrets or environment-dependent values.
    *   Defaults are in `config/default.js`.

### Formatting
*   **Indentation**: **2 spaces**.
*   **Semicolons**: **Always** use semicolons.
*   **Quotes**: Use **single quotes** (`'`) for strings. Use backticks (`` ` ``) for template literals.
*   **Braces**: K&R style (opening brace on the same line).
*   **Max Line Length**: Aim for 100-120 characters, but readability takes precedence.
*   **Trailing Commas**: Acceptable in multi-line objects/arrays.

### Naming
*   **Variables/Functions**: `camelCase` (e.g., `calculateQuantity`, `processOrder`).
*   **Classes**: `PascalCase` (e.g., `OrderExecutor`, `BinanceClient`).
*   **Files**: `kebab-case` (e.g., `order-mapper.js`, `risk-control.js`).
*   **Constants**: `UPPER_CASE` (e.g., `DEFAULT_TIMEOUT`, `REDIS_KEY_PREFIX`).
*   **Private Members**: Prefix with `_` to indicate internal use (e.g., `_connectWebSocket`), even if not strictly private.

### Type Safety & Documentation
*   **JSDoc**: Use JSDoc for all complex functions, especially public methods in core classes.
    ```javascript
    /**
     * Calculate quantity based on ratio and risk limits.
     * @param {string} coin - The coin symbol (e.g., 'BTC')
     * @param {number} masterSize - The size of the master order
     * @returns {Promise<number>} - The calculated follower size
     */
    async function calculateQuantity(coin, masterSize) { ... }
    ```
*   **Type Checking**: This is standard JavaScript. Be defensive with inputs.

### Error Handling
*   **Logging**: **ALWAYS** use the custom logger (`src/utils/logger.js`).
    *   `logger.info('Order placed', { orderId: '...' })`
    *   `logger.error('Failed to sync', error)`
*   **Async/Await**: Use `async/await` paired with `try/catch` blocks. Avoid raw Promise chains (`.then().catch()`) for complex logic.
*   **Process Exit**: Only exit `process.exit(1)` on critical startup failures (e.g., invalid API keys).

## 3. Architecture Overview

The system bridges Hyperliquid (Master) and Binance Futures (Follower).

### Core Components
1. **Hyperliquid WS** (`src/hyperliquid/`): Listens for `order` (Limit) and `fill` (Market) events.
2. **Order Executor** (`src/core/order-executor.js`): Decides whether to place, update, or skip orders.
3. **Position Tracker** (`src/core/position-tracker.js`): Tracks the delta between Master and Follower.
4. **Consistency Engine** (`src/core/consistency-engine.js`): Handles missed events and orphan fills.
5. **Order Validator** (`src/core/order-validator.js`): Periodically reconciles full snapshots and reports drift.
6. **Exposure Manager** (`src/core/exposure-manager.js`): Calculates target exposure and drift for display and TP management.
7. **Account Manager** (`src/core/account-manager.js`): Aggregates equity information and account utilities.
8. **Monitoring API** (`src/monitoring/api-server.js`): Serves REST and WebSocket endpoints for status, logs, and manual actions.
9. **Auth** (`src/utils/auth-util.js`, `src/middleware/auth-middleware.js`): TOTP setup and JWT-based API protection.
10. **Redis**: Acts as the state database.
    - `map:h2b:<oid>`: Maps Hyperliquid OID -> Binance OrderID.
    - `pos:delta:<coin>`: Stores pending size that couldn't be executed immediately.
    - `exposure:tp:<coin>`: Active Take Profit (Reduce-Only) order ID for a coin.
    - `orderLock:<oid>`: Short TTL lock to avoid concurrent updates.

### Key Logic: Dual-Track Reconciliation
The system maintains consistency using two parallel tracks:
1. **Fast Path (Incremental)**: Triggered by WS `order`/`fill` events to apply low-latency changes.
2. **Slow Path (Full Reconciliation)**: Triggered by `OrderValidator` every 60s. Fetches full snapshots from HL and Binance, calculates drift (`Target - Actual`), and realigns if drift > 1%.

### Redis Data Structures
Understanding Redis keys is crucial for debugging and state management:
- `map:h2b:<oid>`: String. Mapped Binance Order ID for a given Hyperliquid Order ID.
- `pos:delta:<coin>`: String (Float). Accumulated position difference. Reset during reconciliation.
- `orderLock:<oid>`: String (TTL 10s). Distributed lock for updates.
- `exposure:tp:<coin>`: String. Active Take Profit (Reduce-Only) order ID for a coin.
- `admin:totp:secret`: String. TOTP secret for admin access. Cleared by `npm run reset-auth`.

## 4. Agent Workflow Rules

1. **Analyze First**: Inspect `src/` structure and dependencies before editing.
2. **Mocking is Mandatory**: When creating tests, mock `ioredis`, `binance-api-node`, and external calls.
   ```javascript
   const mockRedis = {
     get: async () => null,
     set: async () => 'OK',
     disconnect: () => {}
   };
   ```
3. **Preserve State**: Do not modify `config/default.js` unless explicitly asked.
4. **One-Way Mode**: The system relies on Binance One-Way Mode only.
5. **Safety**:
   - Never log raw API keys or secrets.
   - Never disable `riskControl` in production code.
6. **Dashboard Scope**: For frontend commands, work under `dashboard/`.
7. **Auth & Monitoring**:
   - Initial access requires TOTP setup via `/api/admin/setup-qr` and `/api/admin/setup`.
   - Subsequent API/WebSocket access requires a valid JWT (query `token` for WS).
   - Use `npm run reset-auth` to clear TOTP and re-enter setup mode.

## 5. Common Pitfalls to Avoid
- **Async/Await in Loops**: Avoid `await` in `forEach`. Prefer `for...of` or `Promise.all`.
- **Redis Keys**: Reuse defined key patterns and constants.
- **Floating Point Math**: Use helpers in `position-calculator.js` to avoid precision issues.
- **Error Swallowing**: Always log errors with `logger.error`.
- **Mode Mismatch**: Do not introduce Binance Hedge Mode logic.
