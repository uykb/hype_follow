package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	OrderPlaced = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "hypefollow_orders_placed_total",
		Help: "The total number of orders placed",
	}, []string{"symbol", "side"})

	OrderFailed = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "hypefollow_orders_failed_total",
		Help: "The total number of orders failed",
	}, []string{"symbol", "reason"})

	OrderCancelled = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "hypefollow_orders_cancelled_total",
		Help: "The total number of orders cancelled",
	}, []string{"symbol"})

	HLEvents = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "hypefollow_hl_events_total",
		Help: "Total Hyperliquid events received",
	}, []string{"type"})

	Equity = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "hypefollow_account_equity",
		Help: "Current account equity",
	}, []string{"exchange"})
)
