package fsm

import (
	"context"
	"math"
	"strconv"
	"time"

	"github.com/adshao/go-binance/v2/futures"
	"github.com/uykb/HypeFollow/internal/config"
	"github.com/uykb/HypeFollow/internal/core/account"
	"github.com/uykb/HypeFollow/internal/core/events"
	"github.com/uykb/HypeFollow/internal/core/risk"
	"github.com/uykb/HypeFollow/internal/core/strategy"
	"github.com/uykb/HypeFollow/internal/exchange/binance"
	"github.com/uykb/HypeFollow/internal/repository"
	"github.com/uykb/HypeFollow/pkg/logger"
	"github.com/uykb/HypeFollow/pkg/metrics"
	"go.uber.org/zap"
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

	CurrentPosition float64
	PendingOrderID  string
	LastTPOrderID   string
	DeferredEvents  []events.Event

	stopChan chan struct{}
}

func NewFSM(symbol string, cli *binance.Client, strat *strategy.Calculator, riskMgr *risk.RiskManager, repo *repository.RedisRepo, acct *account.Manager) *FSM {
	fsm := &FSM{
		Symbol:     symbol,
		InputChan:  make(chan events.Event, 100),
		BinanceCli: cli,
		Strategy:   strat,
		Risk:       riskMgr,
		Repo:       repo,
		AccountMgr: acct,
		DeferredEvents: make([]events.Event, 0),
		stopChan:  make(chan struct{}),
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if tpID, err := repo.GetTPOrderID(ctx, symbol); err == nil && tpID != "" {
		fsm.LastTPOrderID = tpID
		logger.Log.Info("Loaded TP Order ID from Redis", zap.String("symbol", symbol), zap.String("tp_oid", tpID))
	}

	return fsm
}

func (f *FSM) Run(ctx context.Context) {
	logger.Log.Info("FSM Started", zap.String("symbol", f.Symbol))

	f.syncPosition()

	interval := config.Cfg.RiskControl.TPDesyncCheckIntv
	if interval <= 0 {
		interval = 10
	}
	go f.startTPDesyncMonitor(ctx, time.Duration(interval)*time.Second)

	for {
		if f.CurrentState == StateIdle && len(f.DeferredEvents) > 0 {
			evt := f.DeferredEvents[0]
			f.DeferredEvents = f.DeferredEvents[1:]
			logger.Log.Debug("Processing Deferred Event", zap.Any("type", evt.Type))
			f.handleEvent(evt)
			continue
		}

		select {
		case <-ctx.Done():
			return
		case <-f.stopChan:
			return
		case evt := <-f.InputChan:
			f.handleEvent(evt)
		}
	}
}

func (f *FSM) Stop() {
	close(f.stopChan)
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
		case events.EvtTPDesyncCheck:
			f.handleTPDesyncCheck(evt)
		}
	case StatePendingOrder:
		switch evt.Type {
		case events.EvtBinanceExecutionReport:
			f.handleBinanceExecution(evt)
		case events.EvtHLOrder, events.EvtHLOrderCancel, events.EvtHLFill, events.EvtSmartSyncCheck, events.EvtTPDesyncCheck:
			logger.Log.Info("Deferring event during PendingOrder", zap.Any("type", evt.Type))
			f.DeferredEvents = append(f.DeferredEvents, evt)
		}
	case StateSyncing:
		if evt.Type == events.EvtHLOrder || evt.Type == events.EvtHLOrderCancel || evt.Type == events.EvtTPDesyncCheck {
			logger.Log.Info("Deferring event during Syncing", zap.Any("type", evt.Type))
			f.DeferredEvents = append(f.DeferredEvents, evt)
		}
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

	if config.Cfg.Trading.LongOnly && payload.Side == "S" && !payload.IsReduceOnly {
		logger.Log.Debug("Skipping short order (long_only mode)", zap.String("oid", payload.OrderID))
		return
	}

	binanceSymbol := payload.Coin + "USDT"

	var side futures.SideType
	if payload.Side == "B" {
		side = futures.SideTypeBuy
	} else {
		side = futures.SideTypeSell
	}

	binanceEquity, hlEquity := f.AccountMgr.GetEquities()
	metrics.Equity.WithLabelValues("binance").Set(binanceEquity)
	metrics.Equity.WithLabelValues("hyperliquid").Set(hlEquity)

	var quantity float64
	if payload.IsReduceOnly {
		currentPos := f.CurrentPosition
		if currentPos < 0 {
			currentPos = -currentPos
		}

		if currentPos == 0 {
			logger.Log.Warn("Received ReduceOnly order but current position is 0", zap.String("oid", payload.OrderID))
			return
		}

		if f.LastTPOrderID != "" {
			logger.Log.Info("Cancelling previous TP order before placing new one", zap.String("old_tp_oid", f.LastTPOrderID))
			ctxCancel, cancelCancel := context.WithTimeout(context.Background(), 2*time.Second)
			oid, _ := strconv.ParseInt(f.LastTPOrderID, 10, 64)
			_ = f.BinanceCli.CancelOrder(ctxCancel, binanceSymbol, oid)
			cancelCancel()
			f.clearTPOrderID()
		}

		quantity = currentPos
		logger.Log.Info("Syncing TP Order Size to Current Position", zap.Float64("qty", quantity))
	} else {
		quantity = f.Strategy.CalculateQuantity(binanceSymbol, payload.Size, hlEquity, binanceEquity)
	}

	if err := f.Risk.CheckOrder(binanceSymbol, f.CurrentPosition, quantity); err != nil {
		logger.Log.Warn("Order rejected by Risk Manager", zap.Error(err))
		metrics.OrderFailed.WithLabelValues(binanceSymbol, "risk_rejected").Inc()
		return
	}

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
		zap.Float64("qty", quantity),
		zap.Bool("isTP", payload.IsReduceOnly))

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var resp *futures.CreateOrderResponse
	if payload.IsReduceOnly && config.Cfg.Trading.TPUseMarket {
		logger.Log.Info("Using MARKET order for TP (price spread protection)")
		resp, err = f.BinanceCli.PlaceMarketOrder(ctx, binanceSymbol, side, quantity, true)
	} else {
		resp, err = f.BinanceCli.PlaceOrder(ctx, binanceSymbol, side, quantity, payload.LimitPrice, payload.IsReduceOnly)
	}

	if err != nil {
		logger.Log.Error("Failed to place Binance order", zap.Error(err))
		metrics.OrderFailed.WithLabelValues(binanceSymbol, "api_error").Inc()
		return
	}

	f.PendingOrderID = strconv.FormatInt(resp.OrderID, 10)
	f.CurrentState = StatePendingOrder
	metrics.OrderPlaced.WithLabelValues(binanceSymbol, string(side)).Inc()

	if payload.IsReduceOnly {
		f.saveTPOrderID(f.PendingOrderID)
	}

	ctxRepo, cancelRepo := context.WithTimeout(context.Background(), 5*time.Second)
	if err := f.Repo.SaveOrderMapping(ctxRepo, payload.OrderID, resp.OrderID); err != nil {
		logger.Log.Error("Failed to save order mapping", zap.Error(err))
	}
	cancelRepo()

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

	if strconv.FormatInt(binanceOID, 10) == f.LastTPOrderID {
		f.clearTPOrderID()
	}

	metrics.OrderCancelled.WithLabelValues(binanceSymbol).Inc()
}

func (f *FSM) handleHLFill(evt events.Event) {
	logger.Log.Info("HL Fill Received, scheduling SmartSync", zap.String("symbol", f.Symbol))

	time.AfterFunc(2*time.Second, func() {
		f.InputChan <- events.Event{
			Type:      events.EvtSmartSyncCheck,
			Symbol:    f.Symbol,
			Timestamp: time.Now(),
			Payload:   events.SmartSyncPayload{IsTP: false, Cycle: 1},
		}
	})
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

		isTP := math.Abs(f.CurrentPosition) < 0.0001
		go func() {
			time.Sleep(5 * time.Second)
			f.InputChan <- events.Event{
				Type:      events.EvtSmartSyncCheck,
				Symbol:    f.Symbol,
				Timestamp: time.Now(),
				Payload:   events.SmartSyncPayload{IsTP: isTP, Cycle: 0},
			}
		}()
	}

	f.CurrentState = StateIdle
}

func (f *FSM) handleSmartSyncCheck(evt events.Event) {
	payload := evt.Payload.(events.SmartSyncPayload)
	isTP := payload.IsTP
	cycle := payload.Cycle

	logger.Log.Info("Running Smart Sync Check", zap.Bool("isTP", isTP), zap.Int("cycle", cycle))

	maxCycles := config.Cfg.RiskControl.MaxSmartSyncCycles
	if maxCycles <= 0 {
		maxCycles = 12
	}

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
		if math.Abs(hlPos) < 0.0001 {
			if cycle >= maxCycles {
				logger.Log.Warn("SmartSync(TP): Max cycles reached, forcing full sync",
					zap.Int("cycle", cycle),
					zap.Int("max_cycles", maxCycles))
				f.performFullSync(0)
				return
			}

			logger.Log.Info("SmartSync(TP): HL still has no position, retrying",
				zap.Int("cycle", cycle),
				zap.Int("max_cycles", maxCycles))

			if cycle == 0 {
				logger.Log.Info("SmartSync(TP): Cancelling all Binance orders while waiting for HL")
				if err := f.BinanceCli.CancelAllOpenOrders(context.Background(), f.Symbol+"USDT"); err != nil {
					logger.Log.Error("Failed to cancel orders during TP wait", zap.Error(err))
				}
			}

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
		logger.Log.Info("SmartSync(TP): HL position detected, performing full sync", zap.Float64("hlPos", hlPos))
		f.performFullSync(hlPos)
	} else {
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

		f.performFullSync(hlPos)
	}
}

func (f *FSM) handleTPDesyncCheck(evt events.Event) {
	logger.Log.Debug("Checking TP Desync", zap.String("symbol", f.Symbol))

	hlState, err := f.AccountMgr.GetHLState()
	if err != nil {
		logger.Log.Error("TPDesyncCheck: Failed to get HL state", zap.Error(err))
		return
	}

	var hlPos float64
	for _, p := range hlState.AssetPositions {
		if p.Position.Coin == f.Symbol {
			hlPos, _ = strconv.ParseFloat(p.Position.Szi, 64)
			break
		}
	}

	binancePos := f.CurrentPosition
	hlAbs := math.Abs(hlPos)
	binanceAbs := math.Abs(binancePos)

	if hlAbs < 0.0001 && binanceAbs > 0.0001 {
		logger.Log.Warn("TP DESYNC DETECTED: HL has no position but Binance still holds",
			zap.Float64("hl_pos", hlPos),
			zap.Float64("binance_pos", binancePos))

		f.performFullSync(0)
		metrics.OrderFailed.WithLabelValues(f.Symbol+"USDT", "tp_desync").Inc()
		return
	}

	if binanceAbs < 0.0001 && hlAbs > 0.0001 {
		logger.Log.Warn("TP DESYNC DETECTED: Binance has no position but HL still holds",
			zap.Float64("hl_pos", hlPos),
			zap.Float64("binance_pos", binancePos))

		f.performFullSync(hlPos)
		metrics.OrderFailed.WithLabelValues(f.Symbol+"USDT", "tp_desync").Inc()
		return
	}

	logger.Log.Debug("TP Desync check passed",
		zap.Float64("hl_pos", hlPos),
		zap.Float64("binance_pos", binancePos))
}

func (f *FSM) startTPDesyncMonitor(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-f.stopChan:
			return
		case <-ticker.C:
			select {
			case f.InputChan <- events.Event{
				Type:      events.EvtTPDesyncCheck,
				Symbol:    f.Symbol,
				Timestamp: time.Now(),
			}:
			default:
				logger.Log.Debug("TP Desync check skipped (channel full)")
			}
		}
	}
}

func (f *FSM) performFullSync(hlPos float64) {
	f.CurrentState = StateSyncing
	defer func() { f.CurrentState = StateIdle }()

	logger.Log.Info("Performing Full Sync with HL", zap.Float64("hlPos", hlPos))

	hlOrders, err := f.AccountMgr.GetHLOpenOrders()
	if err != nil {
		logger.Log.Error("Failed to get HL open orders", zap.Error(err))
		return
	}

	err = f.BinanceCli.CancelAllOpenOrders(context.Background(), f.Symbol+"USDT")
	if err != nil {
		logger.Log.Error("Failed to cancel all open orders", zap.Error(err))
	}

	f.clearTPOrderID()

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
	}

	var hasTP bool
	var tpPrice float64

	for _, o := range hlOrders {
		if o.Coin != f.Symbol {
			continue
		}

		if config.Cfg.Trading.LongOnly && o.Side == "S" && !o.ReduceOnly {
			logger.Log.Debug("Skipping short order during sync (long_only mode)")
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

		if o.ReduceOnly {
			hasTP = true
			tpPrice = price
			continue
		}

		_, err := f.BinanceCli.PlaceOrder(context.Background(), f.Symbol+"USDT", side, size, price, o.ReduceOnly)
		if err != nil {
			logger.Log.Error("Failed to replicate order during sync", zap.Error(err))
		}
	}

	if hasTP {
		targetPos := math.Abs(hlPos)
		if targetPos > 0 {
			var tpSide futures.SideType
			if hlPos > 0 {
				tpSide = futures.SideTypeSell
			} else {
				tpSide = futures.SideTypeBuy
			}

			logger.Log.Info("Placing Consolidated TP Order during Sync",
				zap.Float64("qty", targetPos),
				zap.Float64("price", tpPrice))

			var resp *futures.CreateOrderResponse
			if config.Cfg.Trading.TPUseMarket {
				resp, err = f.BinanceCli.PlaceMarketOrder(context.Background(), f.Symbol+"USDT", tpSide, targetPos, true)
			} else {
				resp, err = f.BinanceCli.PlaceOrder(context.Background(), f.Symbol+"USDT", tpSide, targetPos, tpPrice, true)
			}

			if err != nil {
				logger.Log.Error("Failed to place consolidated TP order", zap.Error(err))
			} else {
				f.saveTPOrderID(strconv.FormatInt(resp.OrderID, 10))
			}
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
		if p.Symbol == f.Symbol+"USDT" {
			amt, _ := strconv.ParseFloat(p.PositionAmt, 64)
			f.CurrentPosition = amt
			logger.Log.Info("Position Synced", zap.String("symbol", f.Symbol), zap.Float64("amt", f.CurrentPosition))
			break
		}
	}
}

func (f *FSM) saveTPOrderID(orderID string) {
	f.LastTPOrderID = orderID
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := f.Repo.SaveTPOrderID(ctx, f.Symbol, orderID); err != nil {
		logger.Log.Error("Failed to save TP order ID to Redis", zap.Error(err))
	}
}

func (f *FSM) clearTPOrderID() {
	f.LastTPOrderID = ""
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := f.Repo.ClearTPOrderID(ctx, f.Symbol); err != nil {
		logger.Log.Error("Failed to clear TP order ID from Redis", zap.Error(err))
	}
}
