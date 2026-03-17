package fsm

import (
	"context"
	"github.com/uykb/HypeFollow/internal/core/account"
	"github.com/uykb/HypeFollow/internal/core/events"
	"github.com/uykb/HypeFollow/internal/core/risk"
	"github.com/uykb/HypeFollow/internal/core/strategy"
	"github.com/uykb/HypeFollow/internal/exchange/binance"
	"github.com/uykb/HypeFollow/internal/repository"
	"github.com/uykb/HypeFollow/pkg/logger"
	"go.uber.org/zap"
	"sync"
)

type Manager struct {
	fsms        map[string]*FSM
	mu          sync.RWMutex
	binanceCli  *binance.Client
	eventChan   <-chan events.Event
	ctx         context.Context
	cancel      context.CancelFunc
	
	// Shared Components
	Strategy   *strategy.Calculator
	Risk       *risk.RiskManager
	Store      *repository.MemoryStore
	AccountMgr *account.Manager
	LockMgr    *repository.MemoryLock
}

func NewManager(eventChan <-chan events.Event, binanceCli *binance.Client, strat *strategy.Calculator, riskMgr *risk.RiskManager, acct *account.Manager) *Manager {
	ctx, cancel := context.WithCancel(context.Background())
	return &Manager{
		fsms:       make(map[string]*FSM),
		binanceCli: binanceCli,
		eventChan:  eventChan,
		ctx:        ctx,
		cancel:     cancel,
		Strategy:   strat,
		Risk:       riskMgr,
		Store:      repository.NewMemoryStore(),
		AccountMgr: acct,
		LockMgr:    repository.NewMemoryLock(),
	}
}

func (m *Manager) Run() {
	logger.Log.Info("FSM Manager started")
	for {
		select {
		case <-m.ctx.Done():
			return
		case evt := <-m.eventChan:
			m.Dispatch(evt)
		}
	}
}

func (m *Manager) Dispatch(evt events.Event) {
	symbol := evt.Symbol
	if symbol == "" {
		// Broadcast or ignore?
		// For now, only symbol-specific events are handled
		return
	}

	m.mu.RLock()
	fsm, exists := m.fsms[symbol]
	m.mu.RUnlock()

	if !exists {
		m.mu.Lock()
		// Double check
		if fsm, exists = m.fsms[symbol]; !exists {
			fsm = NewFSM(symbol, m.binanceCli, m.Strategy, m.Risk, m.Store, m.AccountMgr, m.LockMgr)
			m.fsms[symbol] = fsm
			go fsm.Run(m.ctx)
			logger.Log.Info("Created new FSM", zap.String("symbol", symbol))
		}
		m.mu.Unlock()
	}

	fsm.InputChan <- evt
}

func (m *Manager) Stop() {
	m.cancel()
}
