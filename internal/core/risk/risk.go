package risk

import (
	"fmt"
	"github.com/uykb/HypeFollow/internal/config"
	"github.com/uykb/HypeFollow/pkg/logger"
	"go.uber.org/zap"
)

type RiskManager struct {
	SupportedCoins  map[string]bool
	MaxPositionSize map[string]float64
	EmergencyStop   bool
}

func NewRiskManager() *RiskManager {
	supported := make(map[string]bool)
	for _, coin := range config.Cfg.RiskControl.SupportedCoins {
		supported[coin] = true
	}

	return &RiskManager{
		SupportedCoins:  supported,
		MaxPositionSize: config.Cfg.RiskControl.MaxPositionSize,
		EmergencyStop:   config.Cfg.RiskControl.EmergencyStop,
	}
}

func (r *RiskManager) CheckOrder(coin string, currentPos float64, newSize float64) error {
	if r.EmergencyStop {
		return fmt.Errorf("emergency stop is active")
	}

	if !r.SupportedCoins[coin] {
		return fmt.Errorf("coin %s is not supported", coin)
	}

	// Check Max Position Size
	if limit, ok := r.MaxPositionSize[coin]; ok {
		projected := currentPos + newSize // Note: this is a simple check, sign matters in real logic
		// Taking absolute values for safety check
		absProjected := projected
		if absProjected < 0 {
			absProjected = -absProjected
		}

		if absProjected > limit {
			logger.Log.Warn("Risk check failed: Max position size exceeded", 
				zap.String("coin", coin), 
				zap.Float64("projected", absProjected), 
				zap.Float64("limit", limit))
			return fmt.Errorf("max position size exceeded for %s", coin)
		}
	}

	return nil
}

func (r *RiskManager) SetEmergencyStop(active bool) {
	r.EmergencyStop = active
	logger.Log.Warn("Emergency Stop Status Changed", zap.Bool("active", active))
}
