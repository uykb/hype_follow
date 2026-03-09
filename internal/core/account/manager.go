package account

import (
	"context"
	"github.com/uykb/HypeFollow/internal/config"
	"github.com/uykb/HypeFollow/internal/exchange/binance"
	"github.com/uykb/HypeFollow/internal/exchange/hyperliquid"
	"github.com/uykb/HypeFollow/pkg/logger"
	"go.uber.org/zap"
	"sync"
	"time"
)

type Manager struct {
	binanceCli *binance.Client
	hlCli      *hyperliquid.HttpClient
	
	mu             sync.RWMutex
	binanceEquity  float64
	hlEquity       float64
	lastUpdate     time.Time
}

func NewManager(b *binance.Client) *Manager {
	return &Manager{
		binanceCli: b,
		hlCli:      hyperliquid.NewHttpClient(),
	}
}

func (m *Manager) Start(ctx context.Context) {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()

	// Initial fetch
	m.updateEquities()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.updateEquities()
		}
	}
}

func (m *Manager) updateEquities() {
	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		eq, err := m.fetchBinanceEquity()
		if err != nil {
			logger.Log.Error("Failed to fetch Binance equity", zap.Error(err))
			return
		}
		m.mu.Lock()
		m.binanceEquity = eq
		m.mu.Unlock()
	}()

	go func() {
		defer wg.Done()
		addr := config.Cfg.Hyperliquid.AccountAddress
		if addr == "" {
			return
		}
		eq, err := m.hlCli.GetAccountEquity(addr)
		if err != nil {
			logger.Log.Error("Failed to fetch Hyperliquid equity", zap.Error(err))
			return
		}
		m.mu.Lock()
		m.hlEquity = eq
		m.mu.Unlock()
	}()

	wg.Wait()
	m.mu.Lock()
	m.lastUpdate = time.Now()
	m.mu.Unlock()
	
	logger.Log.Info("Account Equities Updated", 
		zap.Float64("binance", m.binanceEquity), 
		zap.Float64("hyperliquid", m.hlEquity))
}

func (m *Manager) fetchBinanceEquity() (float64, error) {
	// Need to expose GetAccount from Binance Client or similar
	// Assuming binance.Client has a method to get account info
	// We need to add GetAccountEquity to internal/exchange/binance/client.go
	return m.binanceCli.GetAccountEquity(context.Background())
}

func (m *Manager) GetEquities() (float64, float64) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.binanceEquity, m.hlEquity
}
