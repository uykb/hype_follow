package hyperliquid

import "encoding/json"

type WSMessage struct {
	Channel string          `json:"channel"`
	Data    json.RawMessage `json:"data"`
}

type ClearinghouseStateResponse struct {
	AssetPositions []AssetPosition `json:"assetPositions"`
	MarginSummary  MarginSummary   `json:"marginSummary"`
}

type AssetPosition struct {
	Position PositionDetails `json:"position"`
	Type     string          `json:"type"` // "oneWay"
}

type PositionDetails struct {
	Coin           string `json:"coin"`
	Szi            string `json:"szi"` // Size
	EntryPx        string `json:"entryPx"`
	PositionValue  string `json:"positionValue"`
	ReturnOnEquity string `json:"returnOnEquity"`
	UnrealizedPnl  string `json:"unrealizedPnl"`
}

type OrderUpdateData []OrderUpdateEvent

type OrderUpdateEvent struct {
	Order OrderDetail `json:"order"`
}

type OrderDetail struct {
	Coin       string  `json:"coin"`
	Side       string  `json:"side"` // "B" or "A"
	LimitPx    string  `json:"limitPx"`
	Sz         string  `json:"sz"`
	Oid        int64   `json:"oid"`
	Status     string  `json:"status"`
	Timestamp  int64   `json:"timestamp"`
	ReduceOnly bool    `json:"reduceOnly,omitempty"`
}

type UserFillsData struct {
	IsSnapshot bool   `json:"isSnapshot"`
	User       string `json:"user"`
	Fills      []Fill `json:"fills"`
}

type Fill struct {
	Coin    string `json:"coin"`
	Px      string `json:"px"`
	Sz      string `json:"sz"`
	Side    string `json:"side"` // "B" or "A"
	Time    int64  `json:"time"`
	Crossed bool   `json:"crossed"` // True if taker
}

type Subscription struct {
	Method       string             `json:"method"`
	Subscription SubscriptionDetail `json:"subscription"`
}

type SubscriptionDetail struct {
	Type string `json:"type"`
	User string `json:"user"`
}

type Ping struct {
	Method string `json:"method"`
}
