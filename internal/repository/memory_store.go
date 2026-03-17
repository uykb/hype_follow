package repository

import (
	"context"
	"fmt"
	"sync"
)

// MemoryStore 提供基于内存的订单映射存储
type MemoryStore struct {
	orderMappings map[string]int64 // key: hl_oid, value: binance_order_id
	mu            sync.RWMutex
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		orderMappings: make(map[string]int64),
	}
}

// SaveOrderMapping 保存 HL OID 到 Binance OrderID 的映射
func (ms *MemoryStore) SaveOrderMapping(ctx context.Context, hlOID string, binanceOID int64) error {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	ms.orderMappings[hlOID] = binanceOID
	return nil
}

// GetBinanceOrderID 根据 HL OID 获取 Binance OrderID
func (ms *MemoryStore) GetBinanceOrderID(ctx context.Context, hlOID string) (int64, error) {
	ms.mu.RLock()
	defer ms.mu.RUnlock()
	binanceOID, exists := ms.orderMappings[hlOID]
	if !exists {
		return 0, fmt.Errorf("order mapping not found for hl_oid: %s", hlOID)
	}
	return binanceOID, nil
}

// DeleteOrderMapping 删除订单映射
func (ms *MemoryStore) DeleteOrderMapping(hlOID string) {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	delete(ms.orderMappings, hlOID)
}

// Clear 清空所有映射
func (ms *MemoryStore) Clear() {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	ms.orderMappings = make(map[string]int64)
}
