package strategy

import (
	"github.com/shopspring/decimal"
	"github.com/uykb/HypeFollow/internal/config"
	"github.com/uykb/HypeFollow/pkg/logger"
	"go.uber.org/zap"
)

type Calculator struct {
	Mode         string
	FixedRatio   decimal.Decimal
	EqualRatio   decimal.Decimal
	MinOrderSizes map[string]decimal.Decimal
}

func NewCalculator() *Calculator {
	minSizes := make(map[string]decimal.Decimal)
	for k, v := range config.Cfg.Trading.MinOrderSize {
		minSizes[k] = decimal.NewFromFloat(v)
	}

	return &Calculator{
		Mode:          config.Cfg.Trading.Mode,
		FixedRatio:    decimal.NewFromFloat(config.Cfg.Trading.FixedRatio),
		EqualRatio:    decimal.NewFromFloat(config.Cfg.Trading.EqualRatio),
		MinOrderSizes: minSizes,
	}
}

// CalculateQuantity computes the follower's order size based on strategy
func (c *Calculator) CalculateQuantity(symbol string, masterSize float64, masterEquity, followerEquity float64) float64 {
	mSize := decimal.NewFromFloat(masterSize)
	var finalSize decimal.Decimal

	switch c.Mode {
	case "fixed":
		finalSize = mSize.Mul(c.FixedRatio)
	case "equal":
		if masterEquity <= 0 {
			logger.Log.Warn("Master equity is <= 0, defaulting to 0 size", zap.Float64("equity", masterEquity))
			return 0
		}
		mEq := decimal.NewFromFloat(masterEquity)
		fEq := decimal.NewFromFloat(followerEquity)
		ratio := fEq.Div(mEq).Mul(c.EqualRatio)
		finalSize = mSize.Mul(ratio)
	default:
		logger.Log.Error("Unknown trading mode", zap.String("mode", c.Mode))
		return 0
	}

	// Check Minimum Size
	if minSize, ok := c.MinOrderSizes[symbol]; ok {
		// Optimization: Check min notional (value) for HYPEUSDT
		// Min notional is 5 USDT. We need price to calculate notional.
		// Since we don't have price here, we rely on min quantity config.
		// If HYPE price is approx 12 USDT, 0.5 HYPE = 6 USDT > 5 USDT.
		// So setting MinOrderSize for HYPEUSDT to 0.5 in config is safer.
		
		if finalSize.LessThan(minSize) {
			logger.Log.Warn("Calculated size below minimum, using minimum", 
				zap.String("symbol", symbol), 
				zap.String("calc", finalSize.String()), 
				zap.String("min", minSize.String()))
			finalSize = minSize
		}
	}

	// Precision handling (simplified to 3 decimal places for now, should use exchange info)
	// In a real app, you'd fetch LOT_SIZE filter from Binance ExchangeInfo
	// HYPEUSDT usually has 2 decimal place for quantity on Binance (e.g. 12.34 HYPE)
	if symbol == "HYPEUSDT" {
		finalSize = finalSize.Round(2)
	} else {
		finalSize = finalSize.Round(3)
	}

	f, _ := finalSize.Float64()
	return f
}
