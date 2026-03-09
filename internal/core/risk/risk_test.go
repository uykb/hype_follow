package risk

import (
	"testing"
	"github.com/stretchr/testify/assert"
	"github.com/uykb/HypeFollow/internal/config"
	"github.com/uykb/HypeFollow/pkg/logger"
)

func init() {
	logger.InitLogger("debug")
	config.Cfg = &config.Config{
		RiskControl: config.RiskControlConfig{
			SupportedCoins: []string{"BTC", "ETH"},
			MaxPositionSize: map[string]float64{
				"BTC": 1.0,
			},
			EmergencyStop: false,
		},
	}
}

func TestRiskManager_CheckOrder(t *testing.T) {
	rm := NewRiskManager()

	// 1. Supported Coin
	err := rm.CheckOrder("BTC", 0, 0.1)
	assert.NoError(t, err)

	// 2. Unsupported Coin
	err = rm.CheckOrder("SOL", 0, 0.1)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not supported")

	// 3. Max Position Limit
	// Current: 0.9, New: 0.2 -> Total: 1.1 > 1.0
	err = rm.CheckOrder("BTC", 0.9, 0.2)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "max position size exceeded")

	// 4. Emergency Stop
	rm.SetEmergencyStop(true)
	err = rm.CheckOrder("BTC", 0, 0.1)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "emergency stop")
}
