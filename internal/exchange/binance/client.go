package binance

import (
	"context"
	"fmt"
	"github.com/adshao/go-binance/v2"
	"github.com/adshao/go-binance/v2/futures"
	"github.com/uykb/HypeFollow/internal/config"
	"github.com/uykb/HypeFollow/internal/core/events"
	"github.com/uykb/HypeFollow/pkg/logger"
	"go.uber.org/zap"
	"strconv"
	"time"
)

type Client struct {
	client    *futures.Client
	eventChan chan<- events.Event
	done      chan struct{}
}

func NewClient(eventChan chan<- events.Event) *Client {
	return &Client{
		eventChan: eventChan,
		done:      make(chan struct{}),
	}
}

func (c *Client) Init() error {
	apiKey := config.Cfg.Binance.ApiKey
	apiSecret := config.Cfg.Binance.ApiSecret
	useTestnet := config.Cfg.Binance.Testnet

	if useTestnet {
		futures.UseTestnet = true
	}

	c.client = binance.NewFuturesClient(apiKey, apiSecret)
	
	// Test connectivity
	err := c.client.NewPingService().Do(context.Background())
	if err != nil {
		return fmt.Errorf("failed to ping binance: %w", err)
	}
	logger.Log.Info("Connected to Binance API", zap.Bool("testnet", useTestnet))

	// Start User Data Stream
	go c.startUserDataStream()

	return nil
}

func (c *Client) startUserDataStream() {
	for {
		select {
		case <-c.done:
			return
		default:
		}

		listenKey, err := c.client.NewStartUserStreamService().Do(context.Background())
		if err != nil {
			logger.Log.Error("Failed to start user data stream", zap.Error(err))
			time.Sleep(5 * time.Second)
			continue
		}

		logger.Log.Info("Started Binance User Data Stream", zap.String("listenKey", listenKey))

		// Keep-alive loop
		stopKeepAlive := make(chan struct{})
		go func() {
			ticker := time.NewTicker(30 * time.Minute)
			defer ticker.Stop()
			for {
				select {
				case <-stopKeepAlive:
					return
				case <-ticker.C:
					err := c.client.NewKeepaliveUserStreamService().ListenKey(listenKey).Do(context.Background())
					if err != nil {
						logger.Log.Error("Failed to keep alive user stream", zap.Error(err))
					}
				}
			}
		}()

		// WebSocket Handler
		doneC, stopC, err := futures.WsUserDataServe(listenKey, c.handleUserData, c.handleWSError)
		if err != nil {
			logger.Log.Error("Failed to connect to user stream WS", zap.Error(err))
			close(stopKeepAlive)
			time.Sleep(5 * time.Second)
			continue
		}

		// Wait for disconnect
		select {
		case <-doneC:
			logger.Log.Warn("Binance User Stream disconnected")
		case <-c.done:
			stopC <- struct{}{}
			close(stopKeepAlive)
			return
		}
		close(stopKeepAlive)
	}
}

func (c *Client) handleUserData(event *futures.WsUserDataEvent) {
	if event.Event == futures.UserDataEventTypeOrderTradeUpdate {
		o := event.OrderTradeUpdate
		
		price, _ := strconv.ParseFloat(o.OriginalPrice, 64)
		qty, _ := strconv.ParseFloat(o.OriginalQty, 64)

		evt := events.Event{
			Type:      events.EvtBinanceExecutionReport,
			Timestamp: time.Unix(event.Time/1000, 0),
			Symbol:    o.Symbol,
			Payload: events.BinanceExecutionPayload{
				Symbol:        o.Symbol,
				ClientOrderID: o.ClientOrderID,
				Side:          string(o.Side),
				OrderType:     string(o.Type),
				Quantity:      qty,
				Price:         price,
				ExecutionType: string(o.ExecutionType),
				OrderStatus:   string(o.Status),
			},
		}
		c.eventChan <- evt
	}
}

func (c *Client) handleWSError(err error) {
	logger.Log.Error("Binance WS Error", zap.Error(err))
}

// Public API methods for Executor

func (c *Client) PlaceOrder(ctx context.Context, symbol string, side futures.SideType, quantity, price float64, reduceOnly bool) (*futures.CreateOrderResponse, error) {
	// Format Price (3 decimal places for HYPEUSDT) and Quantity (2 decimal places)
	var priceStr, qtyStr string
	if symbol == "HYPEUSDT" {
		priceStr = fmt.Sprintf("%.3f", price)
		qtyStr = fmt.Sprintf("%.2f", quantity)
	} else {
		priceStr = fmt.Sprintf("%f", price)
		qtyStr = fmt.Sprintf("%f", quantity)
	}

	service := c.client.NewCreateOrderService().
		Symbol(symbol).
		Side(side).
		Type(futures.OrderTypeLimit).
		TimeInForce(futures.TimeInForceTypeGTC).
		Quantity(qtyStr).
		Price(priceStr)

	if reduceOnly {
		service.ReduceOnly(true)
	}

	return service.Do(ctx)
}

func (c *Client) PlaceMarketOrder(ctx context.Context, symbol string, side futures.SideType, quantity float64, reduceOnly bool) (*futures.CreateOrderResponse, error) {
	var qtyStr string
	if symbol == "HYPEUSDT" {
		qtyStr = fmt.Sprintf("%.2f", quantity)
	} else {
		qtyStr = fmt.Sprintf("%f", quantity)
	}

	service := c.client.NewCreateOrderService().
		Symbol(symbol).
		Side(side).
		Type(futures.OrderTypeMarket).
		Quantity(qtyStr)
	
	if reduceOnly {
		service.ReduceOnly(true)
	}

	return service.Do(ctx)
}

func (c *Client) CancelOrder(ctx context.Context, symbol string, orderID int64) error {
	_, err := c.client.NewCancelOrderService().
		Symbol(symbol).
		OrderID(orderID).
		Do(ctx)
	return err
}

func (c *Client) CancelAllOpenOrders(ctx context.Context, symbol string) error {
	err := c.client.NewCancelAllOpenOrdersService().
		Symbol(symbol).
		Do(ctx)
	return err
}

func (c *Client) GetPositions(ctx context.Context) ([]*futures.AccountPosition, error) {
	res, err := c.client.NewGetAccountService().Do(ctx)
	if err != nil {
		return nil, err
	}
	return res.Positions, nil
}

func (c *Client) GetAccountEquity(ctx context.Context) (float64, error) {
	res, err := c.client.NewGetAccountService().Do(ctx)
	if err != nil {
		return 0, err
	}
	
	return strconv.ParseFloat(res.TotalMarginBalance, 64)
}

func (c *Client) GetMarketPrice(ctx context.Context, symbol string) (float64, error) {
	prices, err := c.client.NewListPricesService().Symbol(symbol).Do(ctx)
	if err != nil {
		return 0, fmt.Errorf("failed to get market price: %w", err)
	}
	if len(prices) == 0 {
		return 0, fmt.Errorf("no price data for symbol %s", symbol)
	}
	return strconv.ParseFloat(prices[0].Price, 64)
}

func (c *Client) GetOpenOrders(ctx context.Context, symbol string) ([]*futures.Order, error) {
	return c.client.NewListOpenOrdersService().Symbol(symbol).Do(ctx)
}

func (c *Client) Stop() {
	close(c.done)
}
