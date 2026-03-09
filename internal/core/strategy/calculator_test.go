package strategy

import (
	"testing"
	"github.com/stretchr/testify/assert"
	"github.com/uykb/HypeFollow/internal/config"
	"github.com/uykb/HypeFollow/pkg/logger"
)

func init() {
	logger.InitLogger("debug")
	// Mock Config
	config.Cfg = &config.Config{
		Trading: config.TradingConfig{
			Mode: "fixed",
			FixedRatio: 0.1,
			EqualRatio: 1.0,
			MinOrderSize: map[string]float64{
				"BTC": 0.001,
			},
		},
	}
}

func TestCalculateQuantity_Fixed(t *testing.T) {
	calc := NewCalculator()
	
	// Case 1: Standard Fixed Ratio
	// Master: 1.0, Ratio: 0.1 -> Follower: 0.1
	qty := calc.CalculateQuantity("BTC", 1.0, 1000, 1000)
	assert.Equal(t, 0.1, qty)
}

func TestCalculateQuantity_Equal(t *testing.T) {
	config.Cfg.Trading.Mode = "equal"
	calc := NewCalculator()

	// Case 2: Equal Ratio
	// Master Eq: 1000, Follower Eq: 500, Ratio: 1.0 -> Effective Ratio: 0.5
	// Master Size: 1.0 -> Follower Size: 0.5
	qty := calc.CalculateQuantity("ETH", 1.0, 1000, 500)
	assert.Equal(t, 0.5, qty)
}

func TestCalculateQuantity_MinSize(t *testing.T) {
	config.Cfg.Trading.Mode = "fixed"
	calc := NewCalculator()

	// Case 3: Min Size
	// Master: 0.001, Ratio: 0.1 -> Follower: 0.0001 (Below 0.001) -> Should be 0.001
	qty := calc.CalculateQuantity("BTC", 0.001, 1000, 1000)
	assert.Equal(t, 0.001, qty)
}
