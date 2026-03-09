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
	
	quantity := f.Strategy.CalculateQuantity(binanceSymbol, payload.Size, hlEquity, binanceEquity)

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

func (f *FSM) handleHLFill(evt events.Event) {
	// Logic for fills (Market Replication)
}

func (f *FSM) handleBinanceExecution(evt events.Event) {
	// Update state based on execution
	f.CurrentState = StateIdle
}
