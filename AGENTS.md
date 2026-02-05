# HypeFollow Agent Guidelines

This document provides comprehensive instructions for AI agents (and human developers) working on the HypeFollow repository.
It covers build commands, code style, architecture, and workflow rules to ensure consistency and stability.

## 1. Build, Lint, and Test Commands

### Backend (Root)
The backend is a Node.js application responsible for mirroring Hyperliquid orders to Binance.

*   **Install Dependencies**: `npm install`
*   **Start Application**:
    *   `npm start`: Runs `src/index.js` (Production mode).
    *   `npm run dev`: Runs `src/index.js` with `nodemon` for auto-restarts (Development).
    *   `npm run monitor`: Runs the status monitoring server (`src/monitoring/api-server.js`).

### Testing (Backend)
There is **no centralized test runner** (like Jest/Mocha) configured in `package.json`.
Tests are standalone scripts in the `tests/` directory using the built-in `assert` module.

*   **Run All Tests**: There is no single command. You must run them individually.
*   **Run a Single Test**:
    ```bash
    node tests/test-calculation.js
    node tests/test-api-security.js
    node tests/test-order-validation.js
    ```
*   **Creating Tests**:
    *   Create a new file in `tests/` (e.g., `tests/test-new-feature.js`).
    *   Use `require('assert')` for assertions.
    *   **CRITICAL**: You must mock external dependencies (Redis, Binance, Hyperliquid) using standard JS replacement or proxying. Do not make real API calls in tests.

### Dashboard (Frontend)
The `dashboard/` directory contains a React application built with Vite.

*   **Setup**: `cd dashboard && npm install`
*   **Development**: `cd dashboard && npm run dev` (Starts Vite dev server).
*   **Build**: `cd dashboard && npm run build` (Outputs to `dashboard/dist/`).
*   **Linting**: Standard ESLint usage if configured (check `dashboard/eslint.config.js` if present, otherwise rely on IDE formatting).

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
1.  **Hyperliquid WS** (`src/hyperliquid/`): Listens for `order` (Limit) and `fill` (Market) events.
2.  **Order Executor** (`src/core/order-executor.js`): The brain. Decides whether to place, update, or skip orders.
3.  **Position Tracker** (`src/core/position-tracker.js`): Tracks the "Delta" (difference) between Master and Follower to ensure eventual consistency.
4.  **Consistency Engine** (`src/core/consistency-engine.js`): Handles edge cases like missed events or orphan fills.
5.  **Redis**: Acts as the state database.
    *   `map:h2b:...`: Maps Hyperliquid OID -> Binance OrderID.
    *   `pos:delta:...`: Stores pending size that couldn't be executed immediately.

### Key Logic: The "Delta"
Because Binance has minimum order sizes ($5-100), we cannot always perfectly mirror small Hyperliquid adjustments.
*   **Pending Delta**: If a move is too small, we store it in Redis (`pos:delta`).
*   **Enforced Execution**: When the delta grows large enough (or during a larger trade), we bundle it and execute on Binance.

### Redis Data Structures
Understanding Redis keys is crucial for debugging and state management:
*   `map:h2b:<oid>`: String. Stores the mapped Binance Order ID for a given Hyperliquid Order ID.
*   `pos:delta:<coin>`: String (Float). Stores the accumulated position difference that needs to be synced.
*   `orderLock:<oid>`: String (TTL 10s). Distributed lock to prevent race conditions during order updates.
*   `exposure:<coin>`: Hash. Tracks current exposure for risk management calculations.

## 4. Agent Workflow Rules

1.  **Analyze First**: Before editing, run `ls -R src` and `grep` to understand the dependency graph. Use `glob` to find relevant files.
2.  **Mocking is Mandatory**: When asked to create tests, you **must** mock `ioredis` and `binance-api-node`.
    *   **Do not** attempt to connect to a real Redis instance in tests.
    *   Example:
        ```javascript
        const mockRedis = {
          get: async () => null,
          set: async () => 'OK',
          disconnect: () => {}
        };
        ```
3.  **Preserve State**: Do not modify `config/default.js` unless explicitly asked. It contains production defaults.
4.  **One-Way Mode**: The system strictly relies on Binance "One-Way Mode". Do not introduce "Hedge Mode" logic.
5.  **Safety**:
    *   Never log raw API keys or secrets.
    *   Never turn off `riskControl` checks in production code.
6.  **Dashboard**: If editing the dashboard, remember it is a separate scope. You must `cd dashboard` (via `workdir`) for any frontend commands.

## 5. Common Pitfalls to Avoid
*   **Async/Await in Loops**: Be careful with `await` inside `forEach`. Use `for...of` or `Promise.all` instead.
*   **Redis Keys**: Always use the defined constants or prefixes. Do not invent new key schemes without updating documentation.
*   **Floating Point Math**: When calculating sizes, be aware of JS floating point precision. Use helper functions in `position-calculator.js` where possible.
*   **Error Swallowing**: Do not use empty `catch` blocks. Always log the error with `logger.error`.
