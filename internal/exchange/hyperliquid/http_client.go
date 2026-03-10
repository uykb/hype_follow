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

func (c *HttpClient) GetClearinghouseState(address string) (*ClearinghouseStateResponse, error) {
	reqBody := map[string]string{
		"type": "clearinghouseState",
		"user": address,
	}

	jsonBody, err := json.Marshal(reqBody)
	if err != nil {
		return nil, err
	}

	resp, err := c.client.Post(InfoUrl, "application/json", bytes.NewBuffer(jsonBody))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("unexpected status code: %d, body: %s", resp.StatusCode, string(body))
	}

	var state ClearinghouseStateResponse
	if err := json.NewDecoder(resp.Body).Decode(&state); err != nil {
		return nil, err
	}

	return &state, nil
}

func (c *HttpClient) GetOpenOrders(address string) ([]OrderDetail, error) {
	reqBody := map[string]string{
		"type": "openOrders",
		"user": address,
	}

	jsonBody, err := json.Marshal(reqBody)
	if err != nil {
		return nil, err
	}

	resp, err := c.client.Post(InfoUrl, "application/json", bytes.NewBuffer(jsonBody))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("unexpected status code: %d, body: %s", resp.StatusCode, string(body))
	}

	var orders []OrderDetail
	if err := json.NewDecoder(resp.Body).Decode(&orders); err != nil {
		return nil, err
	}

	return orders, nil
}
