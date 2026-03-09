# HypeFollow Go 重构方案 (High-Performance ED-FSM)

本方案旨在将 HypeFollow 从 Node.js 重构为纯 Go 语言版本，采用 **事件驱动 (Event-Driven)** 结合 **有限状态机 (FSM)** 的架构，以实现毫秒级低延迟、高并发和强一致性。

## 1. 核心架构设计

### 1.1 总体架构图 (概念)

```mermaid
graph TD
    HL_WS[Hyperliquid WS] -->|Event: Order/Fill| EventBus
    Binance_WS[Binance WS] -->|Event: ExecutionReport| EventBus
    Ticker[Sync Ticker] -->|Event: CheckDrift| EventBus

    subgraph "Core Logic (Per-Symbol Goroutines)"
        EventBus -->|Dispatch| FSM_BTC[FSM Actor (BTC)]
        EventBus -->|Dispatch| FSM_ETH[FSM Actor (ETH)]
    end

    FSM_BTC -->|Action: PlaceOrder| Executor[Binance Executor]
    FSM_ETH -->|Action: PlaceOrder| Executor

    Executor -->|API Call| Binance_API[Binance API]
    
    FSM_BTC -->|State Update| Redis[(Redis Persistence)]
```

### 1.2 关键组件

1.  **Event Bus (事件总线)**:
    *   利用 Go Channel 实现的高性能事件分发器。
    *   支持多消费者模型，但在此场景下，建议根据 `Symbol` 将事件路由到特定的 FSM 实例，避免锁竞争。

2.  **FSM (有限状态机)**:
    *   **每个交易对 (Symbol) 一个独立的 FSM Goroutine**。
    *   维护该交易对的完整状态：当前仓位、活跃订单、目标仓位、最近一次同步时间。
    *   **状态定义**:
        *   `Idle`: 空闲，等待信号。
        *   `Pending`: 已发送订单给 Binance，等待回调。
        *   `Syncing`: 正在执行全量对齐（Drift Check）。
        *   `Cooldown`: 触发风控后的冷却状态。

3.  **Exchange Adapters (交易所适配器)**:
    *   **Hyperliquid**: 专注于极速接收 WS 消息，解析为统一 `Event` 结构。
    *   **Binance**: 维护 HTTP Keep-Alive 连接，管理 API 权重，处理 WS 推送的订单更新。

4.  **State Repository (状态仓库)**:
    *   **L1 (Memory)**: 原子变量/结构体，供 FSM 毫秒级读写。
    *   **L2 (Redis)**: 仅用于持久化关键映射 (`HL_OID` -> `Binance_OID`) 和故障恢复，不再作为热路径的必须依赖。

## 2. 目录结构 (Standard Go Layout)

```
/
├── cmd/
│   └── bot/
│       └── main.go           # 入口文件
├── internal/
│   ├── config/               # 配置加载 (Viper)
│   ├── core/
│   │   ├── events/           # 事件定义 (Structs)
│   │   ├── fsm/              # 状态机逻辑 (核心)
│   │   └── risk/             # 风控模块
│   ├── exchange/
│   │   ├── hyperliquid/      # HL 适配器
│   │   └── binance/          # Binance 适配器
│   ├── repository/           # 数据存储 (Redis/Mem)
│   └── utils/
│       ├── logger/           # 日志 (Zap)
│       └── math/             # 高精度计算 (Decimal)
├── pkg/                      # 可复用库
├── go.mod
├── Makefile
└── config.yaml
```

## 3. 性能优化策略

1.  **无锁设计 (Lock-Free / Channel-Based)**:
    *   通过 `Actor Model` (每个 Symbol 一个 Goroutine)，避免对全局 Map 加互斥锁。每个 FSM 独占自己的数据。
2.  **内存对象复用 (Sync.Pool)**:
    *   对于高频产生的 `Event` 对象，使用 `sync.Pool` 减少 GC 压力。
3.  **网络优化**:
    *   Binance API Client 使用 `fasthttp` 或调优后的 `net/http` (复用连接池)。
    *   WebSocket 处理使用 Zero-Copy 解析库 (如 `gjson` 或 `fastjson`) 减少内存分配。

## 4. 迁移步骤

1.  **环境准备**: 初始化 Go Module，配置 Lint 和 CI。
2.  **基础建设**: 实现 Redis 连接、Logger、Config 加载。
3.  **适配器开发**: 完成 Hyperliquid 和 Binance 的 WS 监听与 API 封装。
4.  **FSM 核心**: 实现状态机流转逻辑 (这是最复杂的部分)。
5.  **集成测试**: 在 Testnet 环境下进行模拟跟单。
6.  **切换**: 停止 Node.js 服务，启动 Go 服务。

## 5. FSM 详细设计 (示例)

```go
// 状态定义
type State int
const (
    StateIdle State = iota
    StateProcessingOrder
    StateReconciling
)

// 事件处理 Loop
func (f *FSM) Run() {
    for {
        select {
        case event := <-f.eventChan:
            f.handleEvent(event)
        case <-f.ticker.C:
            f.checkDrift()
        }
    }
}

func (f *FSM) handleEvent(evt Event) {
    switch f.CurrentState {
    case StateIdle:
        if evt.Type == EvtHLOrder {
            // 计算仓位 -> 下单 -> 切换状态
            f.transition(StateProcessingOrder)
        }
    case StateProcessingOrder:
        if evt.Type == EvtBinanceFill {
            // 确认成交 -> 更新仓位 -> 回到 Idle
            f.transition(StateIdle)
        }
    }
}
```
