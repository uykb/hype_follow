package config

import (
	"fmt"
	"github.com/spf13/viper"
)

type Config struct {
	App         AppConfig         `mapstructure:"app"`
	Binance     BinanceConfig     `mapstructure:"binance"`
	Hyperliquid HyperliquidConfig `mapstructure:"hyperliquid"`
	Redis       RedisConfig       `mapstructure:"redis"`
	Trading     TradingConfig     `mapstructure:"trading"`
	RiskControl RiskControlConfig `mapstructure:"risk_control"`
}

type AppConfig struct {
	LogLevel string `mapstructure:"log_level"`
	Env      string `mapstructure:"env"`
}

type BinanceConfig struct {
	ApiKey    string `mapstructure:"api_key"`
	ApiSecret string `mapstructure:"api_secret"`
	Testnet   bool   `mapstructure:"testnet"`
}

type HyperliquidConfig struct {
	AccountAddress string `mapstructure:"account_address"`
}

type RedisConfig struct {
	Host     string `mapstructure:"host"`
	Port     int    `mapstructure:"port"`
	Password string `mapstructure:"password"`
	DB       int    `mapstructure:"db"`
}

type TradingConfig struct {
	Mode         string             `mapstructure:"mode"` // "fixed" or "equal"
	FixedRatio   float64            `mapstructure:"fixed_ratio"`
	EqualRatio   float64            `mapstructure:"equal_ratio"`
	MinOrderSize map[string]float64 `mapstructure:"min_order_size"`
}

type RiskControlConfig struct {
	SupportedCoins  []string           `mapstructure:"supported_coins"`
	MaxPositionSize map[string]float64 `mapstructure:"max_position_size"`
	EmergencyStop   bool               `mapstructure:"emergency_stop"`
}

var Cfg *Config

func LoadConfig() error {
	viper.SetConfigName("config")
	viper.SetConfigType("yaml")
	viper.AddConfigPath(".")

	if err := viper.ReadInConfig(); err != nil {
		return fmt.Errorf("error reading config file: %w", err)
	}

	if err := viper.Unmarshal(&Cfg); err != nil {
		return fmt.Errorf("unable to decode into struct: %w", err)
	}
	return nil
}
