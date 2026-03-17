package main

import (
	"context"
	"fmt"
	"github.com/uykb/HypeFollow/internal/config"
	"github.com/uykb/HypeFollow/internal/core/account"
	"github.com/uykb/HypeFollow/internal/core/events"
	"github.com/uykb/HypeFollow/internal/core/fsm"
	"github.com/uykb/HypeFollow/internal/core/risk"
	"github.com/uykb/HypeFollow/internal/core/strategy"
	"github.com/uykb/HypeFollow/internal/exchange/binance"
	"github.com/uykb/HypeFollow/internal/exchange/hyperliquid"
	"github.com/uykb/HypeFollow/pkg/logger"
	"go.uber.org/zap"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	// 1. Load Config
	if err := config.LoadConfig(); err != nil {
		fmt.Printf("Failed to load config: %v\n", err)
		os.Exit(1)
	}

	// 2. Init Logger
	logger.InitLogger(config.Cfg.App.LogLevel)
	logger.Log.Info("Starting HypeFollow Bot (Go Version)", zap.String("env", config.Cfg.App.Env))

	// 3. Init Core Components
	strat := strategy.NewCalculator()
	riskManager := risk.NewRiskManager()

	// 4. Create Event Bus (Buffered Channel)
	eventChan := make(chan events.Event, 1000)

	// 5. Init Exchange Clients
	// Binance Client (Executor)
	binanceCli := binance.NewClient(eventChan)
	if err := binanceCli.Init(); err != nil {
		logger.Log.Fatal("Failed to init Binance client", zap.Error(err))
	}
	defer binanceCli.Stop()

	// Hyperliquid Client (Producer)
	hlCli := hyperliquid.NewClient(eventChan)
	// Start HL Client in a goroutine
	go hlCli.Run()
	defer hlCli.Stop()
	
	// 6. Init Account Manager
	accountMgr := account.NewManager(binanceCli)
	go accountMgr.Start(context.Background())

	// 7. Init Core FSM Manager
	fsmManager := fsm.NewManager(eventChan, binanceCli, strat, riskManager, accountMgr)
	go fsmManager.Run()
	defer fsmManager.Stop()

	// 8. Wait for Shutdown Signal
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	logger.Log.Info("Bot is running. Press Ctrl+C to stop.")
	<-sigChan

	logger.Log.Info("Shutting down...")
	// Cleanup happens via defers
}
