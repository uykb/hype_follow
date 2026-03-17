package repository

import (
	"context"
	"sync"
	"time"
)

// MemoryLock 提供基于内存的分布式锁实现
type MemoryLock struct {
	locks map[string]time.Time
	mu    sync.RWMutex
}

func NewMemoryLock() *MemoryLock {
	ml := &MemoryLock{
		locks: make(map[string]time.Time),
	}
	// 启动清理过期锁的goroutine
	go ml.cleanupExpiredLocks()
	return ml
}

// AcquireLock 尝试获取锁，返回是否成功获取
func (ml *MemoryLock) AcquireLock(ctx context.Context, oid string, ttl time.Duration) (bool, error) {
	ml.mu.Lock()
	defer ml.mu.Unlock()

	// 检查锁是否已存在且未过期
	if expireTime, exists := ml.locks[oid]; exists {
		if time.Now().Before(expireTime) {
			// 锁仍然存在且未过期
			return false, nil
		}
		// 锁已过期，可以重新获取
	}

	// 设置新锁
	ml.locks[oid] = time.Now().Add(ttl)
	return true, nil
}

// ReleaseLock 释放指定的锁
func (ml *MemoryLock) ReleaseLock(oid string) {
	ml.mu.Lock()
	defer ml.mu.Unlock()
	delete(ml.locks, oid)
}

// cleanupExpiredLocks 定期清理过期的锁
func (ml *MemoryLock) cleanupExpiredLocks() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		ml.mu.Lock()
		now := time.Now()
		for oid, expireTime := range ml.locks {
			if now.After(expireTime) {
				delete(ml.locks, oid)
			}
		}
		ml.mu.Unlock()
	}
}
