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
	"math"
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
		case events.EvtSmartSyncCheck:
			f.handleSmartSyncCheck(evt)
		}
	case StatePendingOrder:
		switch evt.Type {
		case events.EvtBinanceExecutionReport:
			f.handleBinanceExecution(evt)
		}
	case StateSyncing:
		// While syncing, we might ignore or buffer events
	}
}

func (f *FSM) handleHLOrder(evt events.Event) {
	if f.CurrentState == StateSyncing {
		logger.Log.Debug("Ignoring HL Order during Syncing", zap.String("oid", evt.Payload.(events.HLOrderPayload).OrderID))
		return
	}
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
		
		// Trigger smart sync logic after position change
		isTP := math.Abs(f.CurrentPosition) < 0.0001
		go func() {
			time.Sleep(5 * time.Second)
			f.InputChan <- events.Event{
				Type:      events.EvtSmartSyncCheck,
				Symbol:    f.Symbol,
				Timestamp: time.Now(),
				Payload:   events.SmartSyncPayload{IsTP: isTP},
			}
		}()
	}

	// Update state based on execution
	f.CurrentState = StateIdle
}

func (f *FSM) handleSmartSyncCheck(evt events.Event) {
	payload := evt.Payload.(events.SmartSyncPayload)
	isTP := payload.IsTP
	cycle := payload.Cycle

	logger.Log.Info("Running Smart Sync Check", zap.Bool("isTP", isTP), zap.Int("cycle", cycle))

	hlState, err := f.AccountMgr.GetHLState()
	if err != nil {
		logger.Log.Error("SmartSync: Failed to get HL state", zap.Error(err))
		return
	}

	var hlPos float64
	for _, p := range hlState.AssetPositions {
		if p.Position.Coin == f.Symbol {
			hlPos, _ = strconv.ParseFloat(p.Position.Szi, 64)
			break
		}
	}

	if isTP {
		// TP Logic: Must wait until HL position appears (non-zero)
		if math.Abs(hlPos) < 0.0001 {
			logger.Log.Info("SmartSync(TP): HL still has no position, retrying in 5s")
			// Schedule next check
			time.AfterFunc(5*time.Second, func() {
				f.InputChan <- events.Event{
					Type:      events.EvtSmartSyncCheck,
					Symbol:    f.Symbol,
					Timestamp: time.Now(),
					Payload:   events.SmartSyncPayload{IsTP: true, Cycle: cycle + 1},
				}
			})
			return
		}
		// Found HL position, perform full sync
		f.performFullSync(hlPos)
	} else {
		// Position Change Logic:
		// If cycle == 0, just wait 5s.
		if cycle == 0 {
			time.AfterFunc(5*time.Second, func() {
				f.InputChan <- events.Event{
					Type:      events.EvtSmartSyncCheck,
					Symbol:    f.Symbol,
					Timestamp: time.Now(),
					Payload:   events.SmartSyncPayload{IsTP: false, Cycle: 1},
				}
			})
			return
		}
		
		// Cycle >= 1: Perform sync
		f.performFullSync(hlPos)
	}
}

func (f *FSM) performFullSync(hlPos float64) {
	f.CurrentState = StateSyncing
	defer func() { f.CurrentState = StateIdle }()

	logger.Log.Info("Performing Full Sync with HL", zap.Float64("hlPos", hlPos))
	
	// 1. Sync Position via Market Order if needed
	diff := hlPos - f.CurrentPosition
	if math.Abs(diff) > 0.0001 {
		var side futures.SideType
		if diff > 0 {
			side = futures.SideTypeBuy
		} else {
			side = futures.SideTypeSell
		}
		
		logger.Log.Info("Syncing Position via Market Order", zap.Float64("diff", diff))
		_, err := f.BinanceCli.PlaceMarketOrder(context.Background(), f.Symbol+"USDT", side, math.Abs(diff), false)
		if err != nil {
			logger.Log.Error("Failed to sync position via market order", zap.Error(err))
		}
		// Note: Do NOT update f.CurrentPosition here. 
		// Wait for ExecutionReport to avoid double counting.
	}

	// 2. Sync Limit Orders
	hlOrders, err := f.AccountMgr.GetHLOpenOrders()
	if err != nil {
		logger.Log.Error("Failed to get HL open orders", zap.Error(err))
		return
	}

	// Cancel all existing Binance orders first
	err = f.BinanceCli.CancelAllOpenOrders(context.Background(), f.Symbol+"USDT")
	if err != nil {
		logger.Log.Error("Failed to cancel all open orders", zap.Error(err))
	}

	// Re-replicate all HL orders
	for _, o := range hlOrders {
		if o.Coin != f.Symbol {
			continue
		}
		
		price, _ := strconv.ParseFloat(o.LimitPx, 64)
		size, _ := strconv.ParseFloat(o.Sz, 64)
		
		var side futures.SideType
		if o.Side == "B" {
			side = futures.SideTypeBuy
		} else {
			side = futures.SideTypeSell
		}

		// Execute in parallel (non-blocking) or sequential?
		// Sequential is safer for rate limits.
		_, err := f.BinanceCli.PlaceOrder(context.Background(), f.Symbol+"USDT", side, size, price, o.ReduceOnly)
		if err != nil {
			logger.Log.Error("Failed to replicate order during sync", zap.Error(err))
		}
	}
	
	logger.Log.Info("Full Sync Completed")
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
