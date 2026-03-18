package lock

import (
	"sync"
	"time"
)

// Manager provides in-memory locking for order processing.
// It replaces the previous Redis-based distributed lock.
type Manager struct {
	locks sync.Map // map[string]*lockEntry
}

type lockEntry struct {
	expiresAt time.Time
}

func NewManager() *Manager {
	return &Manager{}
}

// AcquireLock attempts to acquire a lock for the given order ID.
// Returns true if the lock was acquired, false if already locked.
// The lock will automatically expire after the given TTL.
func (m *Manager) AcquireLock(oid string, ttl time.Duration) bool {
	now := time.Now()
	
	// Try to load existing entry
	if val, ok := m.locks.Load(oid); ok {
		entry := val.(*lockEntry)
		if now.Before(entry.expiresAt) {
			// Lock is still valid
			return false
		}
		// Lock expired, we can acquire it
	}
	
	// Create new lock entry
	entry := &lockEntry{
		expiresAt: now.Add(ttl),
	}
	
	// Use LoadOrStore for atomic operation
	actual, loaded := m.locks.LoadOrStore(oid, entry)
	if loaded {
		// Someone else stored it first
		existing := actual.(*lockEntry)
		if now.Before(existing.expiresAt) {
			return false
		}
		// Expired, try to update
		m.locks.Store(oid, entry)
	}
	
	return true
}

// ReleaseLock releases the lock for the given order ID.
func (m *Manager) ReleaseLock(oid string) {
	m.locks.Delete(oid)
}

// Cleanup removes expired locks to prevent memory leaks.
// Should be called periodically.
func (m *Manager) Cleanup() {
	now := time.Now()
	m.locks.Range(func(key, value interface{}) bool {
		entry := value.(*lockEntry)
		if now.After(entry.expiresAt) {
			m.locks.Delete(key)
		}
		return true
	})
}