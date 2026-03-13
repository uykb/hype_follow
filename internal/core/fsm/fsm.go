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
	StateTPPriceSyncing
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
	LastTPPrice     float64
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
	f.ensureTPSync()

	interval := config.Cfg.RiskControl.TPDesyncCheckIntv
	if interval <= 0 {
		interval = 60
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
	case StateIdle, StateTPPriceSyncing:
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
		case events.EvtTPEnsureCheck:
			f.handleTPEnsureCheck(evt)
		case events.EvtTPPriceSync:
			f.handleTPPriceSync(evt)
		}
	case StatePendingOrder:
		switch evt.Type {
		case events.EvtBinanceExecutionReport:
			f.handleBinanceExecution(evt)
		case events.EvtHLOrder, events.EvtHLOrderCancel, events.EvtHLFill, events.EvtSmartSyncCheck, events.EvtTPDesyncCheck, events.EvtTPEnsureCheck, events.EvtTPPriceSync:
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
		f.LastTPPrice = payload.LimitPrice
		logger.Log.Info("Syncing TP Order Size to Current Position", zap.Float64("qty", quantity), zap.Float64("price", payload.LimitPrice))
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
		logger.Log.Info("Using MARKET order for TP")
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
	var hlTPrice float64
	for _, p := range hlState.AssetPositions {
		if p.Position.Coin == f.Symbol {
			hlPos, _ = strconv.ParseFloat(p.Position.Szi, 64)
			break
		}
	}

	hlOrders, err := f.AccountMgr.GetHLOpenOrders()
	if err == nil {
		for _, o := range hlOrders {
			if o.Coin == f.Symbol && o.ReduceOnly {
				hlTPrice, _ = strconv.ParseFloat(o.LimitPx, 64)
				break
			}
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
					Payload:   events.SmartSyncPayload{IsTP: true, Cycle: cycle + 1, LastTPPrice: hlTPrice},
				}
			})
			return
		}
		logger.Log.Info("SmartSync(TP): HL position detected, performing full sync", zap.Float64("hlPos", hlPos), zap.Float64("hlTPPrice", hlTPrice))
		f.performFullSyncWithTPPrice(hlPos, hlTPrice)
	} else {
		if cycle == 0 {
			time.AfterFunc(5*time.Second, func() {
				f.InputChan <- events.Event{
					Type:      events.EvtSmartSyncCheck,
					Symbol:    f.Symbol,
					Timestamp: time.Now(),
					Payload:   events.SmartSyncPayload{IsTP: false, Cycle: 1, LastTPPrice: hlTPrice},
				}
			})
			return
		}

		if hlTPrice > 0 && hlTPrice != f.LastTPPrice && math.Abs(f.CurrentPosition) > 0.0001 {
			logger.Log.Info("SmartSync: Detected TP price change, syncing TP price",
				zap.Float64("old_price", f.LastTPPrice),
				zap.Float64("new_price", hlTPrice))
			f.syncTPPrice(hlPos, hlTPrice)
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

	hlOrders, _ := f.AccountMgr.GetHLOpenOrders()
	var hlTPPrice float64
	for _, o := range hlOrders {
		if o.Coin == f.Symbol && o.ReduceOnly {
			hlTPPrice, _ = strconv.ParseFloat(o.LimitPx, 64)
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

	if hlAbs > 0.0001 && binanceAbs > 0.0001 {
		binanceOpenOrders, _ := f.BinanceCli.GetOpenOrders(context.Background(), f.Symbol+"USDT")
		var binanceTPQty float64
		var binanceTPPrice float64
		for _, o := range binanceOpenOrders {
			if o.Side == "SELL" && o.ReduceOnly {
				binanceTPQty, _ = strconv.ParseFloat(o.OrigQty, 64)
				binanceTPPrice, _ = strconv.ParseFloat(o.Price, 64)
				break
			}
		}

		needSync := false

		if f.LastTPOrderID == "" && binanceTPQty < 0.0001 {
			logger.Log.Warn("TP DESYNC: Has position but no TP order, triggering sync",
				zap.Float64("hl_pos", hlPos),
				zap.Float64("binance_pos", binancePos))
			needSync = true
		}

		if !needSync && binanceTPQty > 0.0001 && hlTPPrice > 0 {
			qtyDiff := math.Abs(binanceTPQty - binanceAbs)
			priceDiff := math.Abs(binanceTPPrice - hlTPPrice)

			if qtyDiff > 0.0001 {
				logger.Log.Warn("TP QTY MISMATCH: Syncing TP quantity",
					zap.Float64("binance_tp_qty", binanceTPQty),
					zap.Float64("binance_pos", binanceAbs),
					zap.Float64("diff", qtyDiff))
				needSync = true
			}

			if priceDiff > 0.01 {
				logger.Log.Warn("TP PRICE MISMATCH: Syncing TP price",
					zap.Float64("hl_tp_price", hlTPPrice),
					zap.Float64("binance_tp_price", binanceTPPrice),
					zap.Float64("diff", priceDiff))
				needSync = true
			}
		}

		if needSync {
			f.performFullSync(hlPos)
			metrics.OrderFailed.WithLabelValues(f.Symbol+"USDT", "tp_desync").Inc()
			return
		}
	}

	logger.Log.Debug("TP Desync check passed - position, qty and price all match",
		zap.Float64("hl_pos", hlPos),
		zap.Float64("binance_pos", binancePos),
		zap.Float64("hl_tp_price", hlTPPrice),
		zap.Float64("binance_tp_price", f.LastTPPrice))
}

func (f *FSM) handleTPEnsureCheck(evt events.Event) {
	logger.Log.Debug("Checking TP Ensure", zap.String("symbol", f.Symbol))

	hlState, err := f.AccountMgr.GetHLState()
	if err != nil {
		logger.Log.Error("TPEnsureCheck: Failed to get HL state", zap.Error(err))
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

	if hlAbs > 0.0001 && binanceAbs > 0.0001 {
		if f.LastTPOrderID == "" {
			logger.Log.Warn("TP ENSURE: Has position but no TP order, triggering full sync",
				zap.Float64("hl_pos", hlPos),
				zap.Float64("binance_pos", binancePos))
			f.performFullSync(hlPos)
			return
		}
	}

	if hlAbs > 0.0001 && binanceAbs < 0.0001 {
		logger.Log.Warn("TP ENSURE: HL has position but Binance is empty",
			zap.Float64("hl_pos", hlPos),
			zap.Float64("binance_pos", binancePos))
		f.performFullSync(hlPos)
		return
	}

	logger.Log.Debug("TP Ensure check passed",
		zap.Float64("hl_pos", hlPos),
		zap.Float64("binance_pos", binancePos),
		zap.String("has_tp", strconv.FormatBool(f.LastTPOrderID != "")))
}

func (f *FSM) handleTPPriceSync(evt events.Event) {
	payload := evt.Payload.(events.TPPriceSyncPayload)
	cycle := payload.Cycle
	lastTPPrice := payload.LastTPPrice

	logger.Log.Info("Running TP Price Sync", zap.Float64("lastTPPrice", lastTPPrice), zap.Int("cycle", cycle))

	maxCycles := config.Cfg.RiskControl.MaxSmartSyncCycles
	if maxCycles <= 0 {
		maxCycles = 12
	}

	hlState, err := f.AccountMgr.GetHLState()
	if err != nil {
		logger.Log.Error("TPPriceSync: Failed to get HL state", zap.Error(err))
		return
	}

	var hlPos float64
	var currentHLTPPrice float64

	for _, p := range hlState.AssetPositions {
		if p.Position.Coin == f.Symbol {
			hlPos, _ = strconv.ParseFloat(p.Position.Szi, 64)
			break
		}
	}

	hlOrders, _ := f.AccountMgr.GetHLOpenOrders()
	for _, o := range hlOrders {
		if o.Coin == f.Symbol && o.ReduceOnly {
			currentHLTPPrice, _ = strconv.ParseFloat(o.LimitPx, 64)
			break
		}
	}

	if math.Abs(hlPos) < 0.0001 {
		logger.Log.Info("TPPriceSync: HL position is zero, skip")
		return
	}

	if currentHLTPPrice == lastTPPrice {
		logger.Log.Info("TPPriceSync: TP price unchanged, sync complete",
			zap.Float64("tp_price", currentHLTPPrice))
		f.syncTPPrice(hlPos, currentHLTPPrice)
		return
	}

	if cycle >= maxCycles {
		logger.Log.Warn("TPPriceSync: Max cycles reached, forcing sync",
			zap.Int("cycle", cycle))
		f.syncTPPrice(hlPos, currentHLTPPrice)
		return
	}

	logger.Log.Info("TPPriceSync: TP price not match yet, retrying",
		zap.Float64("expected", lastTPPrice),
		zap.Float64("actual", currentHLTPPrice),
		zap.Int("cycle", cycle),
		zap.Int("max_cycles", maxCycles))

	time.AfterFunc(2*time.Second, func() {
		f.InputChan <- events.Event{
			Type:      events.EvtTPPriceSync,
			Symbol:    f.Symbol,
			Timestamp: time.Now(),
			Payload:   events.TPPriceSyncPayload{LastTPPrice: lastTPPrice, Cycle: cycle + 1},
		}
	})
}

func (f *FSM) syncTPPrice(hlPos float64, tpPrice float64) {
	if math.Abs(f.CurrentPosition) < 0.0001 {
		logger.Log.Warn("syncTPPrice: No position, skip")
		return
	}

	binanceSymbol := f.Symbol + "USDT"

	if f.LastTPOrderID != "" {
		logger.Log.Info("Cancelling old TP order before sync new price",
			zap.String("old_oid", f.LastTPOrderID),
			zap.Float64("old_price", f.LastTPPrice),
			zap.Float64("new_price", tpPrice))
		ctxCancel, cancelCancel := context.WithTimeout(context.Background(), 2*time.Second)
		oid, _ := strconv.ParseInt(f.LastTPOrderID, 10, 64)
		_ = f.BinanceCli.CancelOrder(ctxCancel, binanceSymbol, oid)
		cancelCancel()
		f.clearTPOrderID()
	}

	targetPos := math.Abs(f.CurrentPosition)
	var side futures.SideType
	if f.CurrentPosition > 0 {
		side = futures.SideTypeSell
	} else {
		side = futures.SideTypeBuy
	}

	logger.Log.Info("Placing TP order with synced price",
		zap.Float64("qty", targetPos),
		zap.Float64("price", tpPrice))

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var resp *futures.CreateOrderResponse
	var err error
	if config.Cfg.Trading.TPUseMarket {
		resp, err = f.BinanceCli.PlaceMarketOrder(ctx, binanceSymbol, side, targetPos, true)
	} else {
		resp, err = f.BinanceCli.PlaceOrder(ctx, binanceSymbol, side, targetPos, tpPrice, true)
	}

	if err != nil {
		logger.Log.Error("Failed to place TP order during price sync", zap.Error(err))
		return
	}

	f.LastTPPrice = tpPrice
	f.saveTPOrderID(strconv.FormatInt(resp.OrderID, 10))
	logger.Log.Info("TP price sync completed", zap.String("tp_oid", f.PendingOrderID))
}

func (f *FSM) ensureTPSync() {
	time.AfterFunc(3*time.Second, func() {
		f.InputChan <- events.Event{
			Type:      events.EvtTPEnsureCheck,
			Symbol:    f.Symbol,
			Timestamp: time.Now(),
		}
	})
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

			logger.Log.Info("Placing TP Order during Full Sync",
				zap.Float64("qty", targetPos),
				zap.Float64("price", tpPrice))

			var resp *futures.CreateOrderResponse
			if config.Cfg.Trading.TPUseMarket {
				resp, err = f.BinanceCli.PlaceMarketOrder(context.Background(), f.Symbol+"USDT", tpSide, targetPos, true)
			} else {
				resp, err = f.BinanceCli.PlaceOrder(context.Background(), f.Symbol+"USDT", tpSide, targetPos, tpPrice, true)
			}

			if err != nil {
				logger.Log.Error("Failed to place TP order during sync", zap.Error(err))
			} else {
				f.LastTPPrice = tpPrice
				f.saveTPOrderID(strconv.FormatInt(resp.OrderID, 10))
			}
		}
	}

	logger.Log.Info("Full Sync Completed, scheduling re-check")

	time.AfterFunc(3*time.Second, func() {
		f.InputChan <- events.Event{
			Type:      events.EvtTPEnsureCheck,
			Symbol:    f.Symbol,
			Timestamp: time.Now(),
		}
	})
}

func (f *FSM) performFullSyncWithTPPrice(hlPos float64, tpPrice float64) {
	f.CurrentState = StateSyncing
	defer func() { f.CurrentState = StateIdle }()

	logger.Log.Info("Performing Full Sync with HL", zap.Float64("hlPos", hlPos), zap.Float64("tpPrice", tpPrice))

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

	for _, o := range hlOrders {
		if o.Coin != f.Symbol {
			continue
		}

		if config.Cfg.Trading.LongOnly && o.Side == "S" && !o.ReduceOnly {
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
			continue
		}

		_, err := f.BinanceCli.PlaceOrder(context.Background(), f.Symbol+"USDT", side, size, price, o.ReduceOnly)
		if err != nil {
			logger.Log.Error("Failed to replicate order during sync", zap.Error(err))
		}
	}

	if tpPrice > 0 && math.Abs(hlPos) > 0.0001 {
		targetPos := math.Abs(hlPos)
		var tpSide futures.SideType
		if hlPos > 0 {
			tpSide = futures.SideTypeSell
		} else {
			tpSide = futures.SideTypeBuy
		}

		logger.Log.Info("Placing TP Order during Full Sync",
			zap.Float64("qty", targetPos),
			zap.Float64("price", tpPrice))

		var resp *futures.CreateOrderResponse
		if config.Cfg.Trading.TPUseMarket {
			resp, err = f.BinanceCli.PlaceMarketOrder(context.Background(), f.Symbol+"USDT", tpSide, targetPos, true)
		} else {
			resp, err = f.BinanceCli.PlaceOrder(context.Background(), f.Symbol+"USDT", tpSide, targetPos, tpPrice, true)
		}

		if err != nil {
			logger.Log.Error("Failed to place TP order during sync", zap.Error(err))
		} else {
			f.LastTPPrice = tpPrice
			f.saveTPOrderID(strconv.FormatInt(resp.OrderID, 10))
		}
	}

	logger.Log.Info("Full Sync Completed, scheduling re-check for TP scenario")

	time.AfterFunc(3*time.Second, func() {
		f.InputChan <- events.Event{
			Type:      events.EvtTPEnsureCheck,
			Symbol:    f.Symbol,
			Timestamp: time.Now(),
		}
	})
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
	f.LastTPPrice = 0
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := f.Repo.ClearTPOrderID(ctx, f.Symbol); err != nil {
		logger.Log.Error("Failed to clear TP order ID from Redis", zap.Error(err))
	}
}
