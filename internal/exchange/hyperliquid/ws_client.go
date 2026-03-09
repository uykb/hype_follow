package hyperliquid

import (
	"encoding/json"
	"github.com/gorilla/websocket"
	"github.com/uykb/HypeFollow/internal/config"
	"github.com/uykb/HypeFollow/internal/core/events"
	"github.com/uykb/HypeFollow/pkg/logger"
	"go.uber.org/zap"
	"strconv"
	"sync"
	"time"
)

const (
	WSUrl = "wss://api.hyperliquid.xyz/ws" // Or from config
)

type Client struct {
	conn        *websocket.Conn
	eventChan   chan<- events.Event
	done        chan struct{}
	mu          sync.Mutex
	isConnected bool
}

func NewClient(eventChan chan<- events.Event) *Client {
	return &Client{
		eventChan: eventChan,
		done:      make(chan struct{}),
	}
}

func (c *Client) Run() {
	backoff := time.Second
	maxBackoff := 30 * time.Second

	for {
		select {
		case <-c.done:
			return
		default:
		}

		if err := c.connect(); err != nil {
			logger.Log.Error("Failed to connect to Hyperliquid WS", zap.Error(err))
			time.Sleep(backoff)
			backoff *= 2
			if backoff > maxBackoff {
				backoff = maxBackoff
			}
			continue
		}

		backoff = time.Second // Reset backoff on successful connection
		c.readLoop()
	}
}

func (c *Client) connect() error {
	logger.Log.Info("Connecting to Hyperliquid WS", zap.String("url", WSUrl))
	conn, _, err := websocket.DefaultDialer.Dial(WSUrl, nil)
	if err != nil {
		return err
	}

	c.mu.Lock()
	c.conn = conn
	c.isConnected = true
	c.mu.Unlock()

	// Subscribe
	if err := c.subscribe(); err != nil {
		return err
	}

	// Start Pinger
	go c.pingLoop()

	return nil
}

func (c *Client) subscribe() error {
	addr := config.Cfg.Hyperliquid.AccountAddress
	if addr == "" {
		logger.Log.Warn("No Hyperliquid account address configured, skipping subscription")
		return nil
	}

	subs := []string{"orderUpdates", "userFills"}
	for _, subType := range subs {
		msg := Subscription{
			Method: "subscribe",
			Subscription: SubscriptionDetail{
				Type: subType,
				User: addr,
			},
		}
		if err := c.conn.WriteJSON(msg); err != nil {
			return err
		}
		logger.Log.Info("Subscribed to Hyperliquid channel", zap.String("type", subType))
	}
	return nil
}

func (c *Client) pingLoop() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-c.done:
			return
		case <-ticker.C:
			c.mu.Lock()
			if !c.isConnected {
				c.mu.Unlock()
				return
			}
			err := c.conn.WriteJSON(Ping{Method: "ping"})
			c.mu.Unlock()
			if err != nil {
				logger.Log.Error("Failed to send ping", zap.Error(err))
				return
			}
		}
	}
}

func (c *Client) readLoop() {
	defer c.cleanup()

	for {
		_, message, err := c.conn.ReadMessage()
		if err != nil {
			logger.Log.Error("Read error", zap.Error(err))
			return
		}

		var wsMsg WSMessage
		if err := json.Unmarshal(message, &wsMsg); err != nil {
			logger.Log.Error("Parse error", zap.Error(err))
			continue
		}

		c.handleMessage(wsMsg)
	}
}

func (c *Client) handleMessage(msg WSMessage) {
	switch msg.Channel {
	case "orderUpdates":
		c.processOrderUpdates(msg.Data)
	case "userFills":
		c.processUserFills(msg.Data)
	}
}

func (c *Client) processOrderUpdates(data []byte) {
	var updates OrderUpdateData
	if err := json.Unmarshal(data, &updates); err != nil {
		logger.Log.Error("Failed to parse order updates", zap.Error(err))
		return
	}

	for _, update := range updates {
		order := update.Order
		
		// Optimization: Filter for HYPE coin only
		if order.Coin != "HYPE" {
			continue
		}

		price, _ := strconv.ParseFloat(order.LimitPx, 64)
		size, _ := strconv.ParseFloat(order.Sz, 64)

		var eventType events.EventType
		switch order.Status {
		case "open", "triggered":
			eventType = events.EvtHLOrder
		case "canceled", "margin_canceled":
			eventType = events.EvtHLOrderCancel
		default:
			continue
		}
		
		evt := events.Event{
			Type:      eventType,
			Timestamp: time.Unix(order.Timestamp/1000, 0),
			Symbol:    order.Coin,
			Payload: events.HLOrderPayload{
				OrderID:      strconv.FormatInt(order.Oid, 10),
				Coin:         order.Coin,
				Side:         order.Side,
				LimitPrice:   price,
				Size:         size,
				IsReduceOnly: order.ReduceOnly,
				Status:       order.Status,
			},
		}
		c.eventChan <- evt
	}
}

func (c *Client) processUserFills(data []byte) {
	var fillsData UserFillsData
	if err := json.Unmarshal(data, &fillsData); err != nil {
		logger.Log.Error("Failed to parse user fills", zap.Error(err))
		return
	}

	if fillsData.IsSnapshot {
		return
	}

	for _, fill := range fillsData.Fills {
		// Optimization: Filter for HYPE coin only
		if fill.Coin != "HYPE" {
			continue
		}
		
		// Note: Removed Crossed check to support Maker fills (Grid Strategy)

		price, _ := strconv.ParseFloat(fill.Px, 64)
		size, _ := strconv.ParseFloat(fill.Sz, 64)

		evt := events.Event{
			Type:      events.EvtHLFill,
			Timestamp: time.Unix(fill.Time/1000, 0),
			Symbol:    fill.Coin,
			Payload: events.HLFillPayload{
				Coin:      fill.Coin,
				Side:      fill.Side,
				Price:     price,
				Size:      size,
				Dir:       "Open",
			},
		}
		c.eventChan <- evt
	}
}

func (c *Client) cleanup() {
	c.mu.Lock()
	if c.conn != nil {
		c.conn.Close()
	}
	c.isConnected = false
	c.mu.Unlock()
}

func (c *Client) Stop() {
	close(c.done)
	c.cleanup()
}
