# HypeFollow Agent Guidelines

This document provides comprehensive instructions for AI agents (and human developers) working on the HypeFollow repository (Go Version).
It covers build commands, code style, architecture, and workflow rules to ensure consistency and stability.

## 1. Build, Lint, and Test Commands

### Backend (Root)
The backend is a high-performance Go application implementing an Event-Driven Finite State Machine (ED-FSM) architecture.

- **Dependencies**: `go mod tidy`
- **Build**: `make build` (Outputs to `bin/hypefollow-bot` or `bin/bot.exe`)
- **Run**: `make run` or `./bin/bot.exe`
- **Clean**: `make clean`

### Testing
- **Run All Tests**: `go test ./...`
- **Run Specific Package**: `go test ./internal/core/strategy`
- **Run Specific Test**: `go test -v -run TestCalculateQuantity ./internal/core/strategy`

### Dashboard (Frontend)
The `dashboard/` directory contains a React application built with Vite. (Currently decoupling from backend)

- **Setup**: `cd dashboard && npm install`
- **Development**: `cd dashboard && npm run dev`
- **Build**: `cd dashboard && npm run build`

## 2. Code Style & Conventions

Follow standard Go conventions (Effective Go).

### General
*   **Language**: Go 1.22+
*   **Formatting**: Always run `gofmt` (or let IDE handle it).
*   **Linting**: Use `golangci-lint` if available.
*   **Configuration**: Use `Viper` (`config.yaml`).
    *   Secrets must be loaded from environment variables or secure config files.
    *   Never hardcode API keys.

### Project Layout (Standard Go Layout)
*   `cmd/bot/`: Application entry point (`main.go`).
*   `internal/`: Private application and library code.
    *   `config/`: Configuration loading.
    *   `core/`: Business logic (FSM, Events, Strategy, Risk).
    *   `exchange/`: Exchange adapters (Binance, Hyperliquid).
    *   `repository/`: Data access layer (Redis).
*   `pkg/`: Library code ok to use by external applications (e.g., `logger`, `metrics`).

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

The system uses an **Event-Driven Finite State Machine (ED-FSM)** architecture.

### Core Components
1.  **Event Bus**: Go Channels (`chan events.Event`) transport messages between components.
2.  **FSM Manager** (`internal/core/fsm/manager.go`): Manages lifecycle of FSM actors.
3.  **FSM Actor** (`internal/core/fsm/fsm.go`): One Goroutine per Symbol.
    *   **States**: `Idle`, `PendingOrder`, `Syncing`.
    *   **Inputs**: HL Order/Fill Events, Binance Execution Reports.
4.  **Hyperliquid Adapter** (`internal/exchange/hyperliquid`):
    *   WebSocket Client: Listens for `orderUpdates` and `userFills`.
    *   HTTP Client: Fetches Account Equity.
5.  **Binance Adapter** (`internal/exchange/binance`):
    *   WebSocket User Stream: Listens for `ExecutionReport`.
    *   API Client: Places orders, fetches equity.
6.  **Strategy Engine** (`internal/core/strategy`): Calculates position sizes (`Fixed` or `Equal` ratio).
7.  **Risk Manager** (`internal/core/risk`): Pre-trade checks (Whitelist, Max Position, Emergency Stop).
8.  **Account Manager** (`internal/core/account`): Maintains real-time equity state.
9.  **Repository** (`internal/repository`): Redis persistence for:
    *   Order Mapping (`map:h2b:<oid>`)
    *   Distributed Locks (`orderLock:<oid>`)

### Data Flow
1.  **HL WS** receives `Order` event -> `EventBus`.
2.  **FSM Manager** dispatches event to specific `Symbol FSM`.
3.  **FSM** calls `AccountManager` for equity -> `Strategy` for size -> `Risk` for validation.
4.  **FSM** acquires `Redis Lock`.
5.  **FSM** calls `Binance Client` to place order.
6.  **FSM** saves mapping to `Redis` and updates State to `Pending`.

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
-   **Precision Issues**: Use `shopspring/decimal` for all money/quantity calculations. Never use `float64` for math logic.
-   **Context Cancellation**: Respect `context.Context` for graceful shutdowns and timeouts.
