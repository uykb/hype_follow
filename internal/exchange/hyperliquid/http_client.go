package hyperliquid

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

const (
	InfoUrl = "https://api.hyperliquid.xyz/info"
)

type HttpClient struct {
	client *http.Client
}

func NewHttpClient() *HttpClient {
	return &HttpClient{
		client: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

type ClearinghouseState struct {
	MarginSummary MarginSummary `json:"marginSummary"`
}

type MarginSummary struct {
	AccountValue string `json:"accountValue"`
	TotalMargin  string `json:"totalMargin"`
	TotalNtlPos  string `json:"totalNtlPos"`
}

func (c *HttpClient) GetAccountEquity(address string) (float64, error) {
	reqBody := map[string]string{
		"type": "clearinghouseState",
		"user": address,
	}

	jsonBody, err := json.Marshal(reqBody)
	if err != nil {
		return 0, err
	}

	resp, err := c.client.Post(InfoUrl, "application/json", bytes.NewBuffer(jsonBody))
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return 0, fmt.Errorf("unexpected status code: %d, body: %s", resp.StatusCode, string(body))
	}

	var state ClearinghouseState
	if err := json.NewDecoder(resp.Body).Decode(&state); err != nil {
		return 0, err
	}

	equity, err := strconv.ParseFloat(state.MarginSummary.AccountValue, 64)
	if err != nil {
		return 0, fmt.Errorf("failed to parse account value: %w", err)
	}

	return equity, nil
}
