package fsm

import (
	"context"
	"github.com/adshao/go-binance/v2/futures"
	"github.com/uykb/HypeFollow/internal/core/account"
	"github.com/uykb/HypeFollow/internal/core/events"
	"github.com/uykb/HypeFollow/internal/core/risk"
	"github.com/uykb/HypeFollow/internal/core/strategy"
	"github.com/uykb/HypeFollow/internal/exchange/binance"
	"github.com/uykb/HypeFollow/internal/repository"
	"github.com/uykb/HypeFollow/pkg/logger"
	"github.com/uykb/HypeFollow/pkg/metrics"
	"go.uber.org/zap"
	"strconv"
	"time"
)

type State int

const (
	StateIdle State = iota
	StatePendingOrder
	StateSyncing
)

type FSM struct {
	Symbol       string
	CurrentState State
	InputChan    chan events.Event
	BinanceCli   *binance.Client
	Strategy     *strategy.Calculator
	Risk         *risk.RiskManager
	Repo         *repository.RedisRepo
	AccountMgr   *account.Manager
	
	// Local State
	CurrentPosition float64
	PendingOrderID  string
}

func NewFSM(symbol string, cli *binance.Client, strat *strategy.Calculator, risk *risk.RiskManager, repo *repository.RedisRepo, acct *account.Manager) *FSM {
	return &FSM{
		Symbol:     symbol,
		InputChan:  make(chan events.Event, 100), // Buffer
		BinanceCli: cli,
		Strategy:   strat,
		Risk:       risk,
		Repo:       repo,
		AccountMgr: acct,
	}
}

func (f *FSM) Run(ctx context.Context) {
	logger.Log.Info("FSM Started", zap.String("symbol", f.Symbol))
	
	// Initial Position Sync
	f.syncPosition()

	for {
		select {
		case <-ctx.Done():
			return
		case evt := <-f.InputChan:
			f.handleEvent(evt)
		}
	}
}

func (f *FSM) handleEvent(evt events.Event) {
	logger.Log.Debug("Processing Event", 
		zap.String("symbol", f.Symbol), 
		zap.Int("state", int(f.CurrentState)), 
		zap.Int("type", int(evt.Type)))

	switch f.CurrentState {
	case StateIdle:
		switch evt.Type {
		case events.EvtHLOrder:
			f.handleHLOrder(evt)
		case events.EvtHLOrderCancel:
			f.handleHLOrderCancel(evt)
		case events.EvtHLFill:
			f.handleHLFill(evt)
		}
	case StatePendingOrder:
		switch evt.Type {
		case events.EvtBinanceExecutionReport:
			f.handleBinanceExecution(evt)
		}
	}
}

func (f *FSM) handleHLOrder(evt events.Event) {
	metrics.HLEvents.WithLabelValues("order").Inc()
	payload, ok := evt.Payload.(events.HLOrderPayload)
	if !ok {
		return
	}

	// 1. Symbol Mapping (Simplified)
	// In production, use a robust mapper (e.g., Redis or Config)
	binanceSymbol := payload.Coin + "USDT" 

	// 2. Side Mapping
	var side futures.SideType
	if payload.Side == "B" {
		side = futures.SideTypeBuy
	} else {
		side = futures.SideTypeSell
	}

	// 3. Position Sizing
	binanceEquity, hlEquity := f.AccountMgr.GetEquities()
	metrics.Equity.WithLabelValues("binance").Set(binanceEquity)
	metrics.Equity.WithLabelValues("hyperliquid").Set(hlEquity)
	
	var quantity float64
	if payload.IsReduceOnly {
		// Grid Strategy: Sync TP size to current position
		currentPos := f.CurrentPosition
		if currentPos < 0 { currentPos = -currentPos } // abs
		
		if currentPos == 0 {
			logger.Log.Warn("Received ReduceOnly order but current position is 0", zap.String("oid", payload.OrderID))
			return
		}
		quantity = currentPos
		logger.Log.Info("Syncing TP Order Size to Current Position", zap.Float64("qty", quantity))
	} else {
		quantity = f.Strategy.CalculateQuantity(binanceSymbol, payload.Size, hlEquity, binanceEquity)
	}

	// 4. Risk Check
	if err := f.Risk.CheckOrder(binanceSymbol, f.CurrentPosition, quantity); err != nil {
		logger.Log.Warn("Order rejected by Risk Manager", zap.Error(err))
		metrics.OrderFailed.WithLabelValues(binanceSymbol, "risk_rejected").Inc()
		return
	}

	// 5. Distributed Lock
	ctxLock, cancelLock := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancelLock()
	
	locked, err := f.Repo.AcquireLock(ctxLock, payload.OrderID, 10*time.Second)
	if err != nil || !locked {
		logger.Log.Warn("Failed to acquire lock, skipping order", zap.String("oid", payload.OrderID))
		return
	}

	logger.Log.Info("Replicating HL Order", 
		zap.String("symbol", f.Symbol), 
		zap.String("binanceSymbol", binanceSymbol),
		zap.String("side", string(side)), 
		zap.Float64("price", payload.LimitPrice),
		zap.Float64("qty", quantity))

	// 6. Execute Order
	// Use context with timeout
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	resp, err := f.BinanceCli.PlaceOrder(ctx, binanceSymbol, side, quantity, payload.LimitPrice, payload.IsReduceOnly)
	if err != nil {
		logger.Log.Error("Failed to place Binance order", zap.Error(err))
		metrics.OrderFailed.WithLabelValues(binanceSymbol, "api_error").Inc()
		return
	}

	f.PendingOrderID = strconv.FormatInt(resp.OrderID, 10)
	f.CurrentState = StatePendingOrder
	metrics.OrderPlaced.WithLabelValues(binanceSymbol, string(side)).Inc()
	
	// 7. Save Mapping
	go func() {
		ctxRepo, cancelRepo := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancelRepo()
		if err := f.Repo.SaveOrderMapping(ctxRepo, payload.OrderID, resp.OrderID); err != nil {
			logger.Log.Error("Failed to save order mapping", zap.Error(err))
		}
	}()
	
	logger.Log.Info("Order Placed Successfully", zap.String("orderID", f.PendingOrderID))
}

func (f *FSM) handleHLOrderCancel(evt events.Event) {
	payload, ok := evt.Payload.(events.HLOrderPayload)
	if !ok {
		return
	}

	binanceSymbol := payload.Coin + "USDT"
	
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	binanceOID, err := f.Repo.GetBinanceOrderID(ctx, payload.OrderID)
	if err != nil {
		logger.Log.Warn("Failed to find mapped order for cancellation", zap.String("hl_oid", payload.OrderID))
		return
	}

	logger.Log.Info("Cancelling Binance Order", zap.Int64("binance_oid", binanceOID))
	
	err = f.BinanceCli.CancelOrder(ctx, binanceSymbol, binanceOID)
	if err != nil {
		logger.Log.Error("Failed to cancel Binance order", zap.Error(err))
		return
	}
	
	metrics.OrderCancelled.WithLabelValues(binanceSymbol).Inc()
}

func (f *FSM) handleHLFill(evt events.Event) {
	// Logic for fills (Market Replication)
	// Do not update position here to avoid double counting or drift.
	// Position is updated via Binance Execution Reports.
	logger.Log.Info("HL Fill Received (Logging Only)", zap.String("symbol", f.Symbol))
}

func (f *FSM) handleBinanceExecution(evt events.Event) {
	payload, ok := evt.Payload.(events.BinanceExecutionPayload)
	if !ok {
		return
	}

	if payload.ExecutionType == "TRADE" {
		if payload.Side == "BUY" {
			f.CurrentPosition += payload.Quantity
		} else {
			f.CurrentPosition -= payload.Quantity
		}
		logger.Log.Info("Position Updated via Binance Execution", zap.Float64("new_pos", f.CurrentPosition))
	}

	// Update state based on execution
	f.CurrentState = StateIdle
}

func (f *FSM) syncPosition() {
	positions, err := f.BinanceCli.GetPositions(context.Background())
	if err != nil {
		logger.Log.Error("Failed to sync position", zap.Error(err))
		return
	}
	for _, p := range positions {
		// f.Symbol is likely "HYPE", p.Symbol is "HYPEUSDT"
		if p.Symbol == f.Symbol + "USDT" {
			amt, _ := strconv.ParseFloat(p.PositionAmt, 64)
			f.CurrentPosition = amt
			logger.Log.Info("Position Synced", zap.String("symbol", f.Symbol), zap.Float64("amt", f.CurrentPosition))
			break
		}
	}
}
