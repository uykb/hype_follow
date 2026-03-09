package events

import (
	"time"
)

type EventType int

const (
	// Hyperliquid Events
	EvtHLOrder EventType = iota
	EvtHLOrderCancel
	EvtHLFill

	// Binance Events
	EvtBinanceExecutionReport

	// System Events
	EvtSyncTimer
)

type Event struct {
	Type      EventType
	Timestamp time.Time
	Symbol    string
	Payload   interface{}
}

// Payload definitions

type HLOrderPayload struct {
	OrderID      string
	Coin         string
	Side         string // "Buy" or "Sell"
	LimitPrice   float64
	Size         float64
	IsReduceOnly bool
	Status       string // "open", "canceled", "filled", etc.
}

type HLFillPayload struct {
	Coin        string
	Side        string
	Price       float64
	Size        float64
	Fee         float64
	ClosedPnl   float64
	Dir         string // "Open Long", "Close Short", etc.
}

type BinanceExecutionPayload struct {
	Symbol        string
	ClientOrderID string
	Side          string
	OrderType     string
	Quantity      float64
	Price         float64
	ExecutionType string // "NEW", "TRADE", "CANCELED"
	OrderStatus   string // "NEW", "PARTIALLY_FILLED", "FILLED"
}
