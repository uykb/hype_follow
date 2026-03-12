package repository

import (
	"context"
	"fmt"
	"github.com/redis/go-redis/v9"
	"github.com/uykb/HypeFollow/internal/config"
	"github.com/uykb/HypeFollow/pkg/logger"
	"go.uber.org/zap"
	"time"
)

type RedisRepo struct {
	client *redis.Client
}

func NewRedisRepo() *RedisRepo {
	cfg := config.Cfg.Redis
	client := redis.NewClient(&redis.Options{
		Addr:     fmt.Sprintf("%s:%d", cfg.Host, cfg.Port),
		Password: cfg.Password,
		DB:       cfg.DB,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if _, err := client.Ping(ctx).Result(); err != nil {
		logger.Log.Fatal("Failed to connect to Redis", zap.Error(err))
	}

	return &RedisRepo{client: client}
}

// SaveOrderMapping maps Hyperliquid OID to Binance OrderID
func (r *RedisRepo) SaveOrderMapping(ctx context.Context, hlOID string, binanceOID int64) error {
	key := fmt.Sprintf("map:h2b:%s", hlOID)
	return r.client.Set(ctx, key, binanceOID, 0).Err()
}

// GetBinanceOrderID gets Binance OrderID from Hyperliquid OID
func (r *RedisRepo) GetBinanceOrderID(ctx context.Context, hlOID string) (int64, error) {
	key := fmt.Sprintf("map:h2b:%s", hlOID)
	val, err := r.client.Get(ctx, key).Int64()
	if err != nil {
		return 0, err
	}
	return val, nil
}

// AcquireLock tries to acquire a distributed lock for an order
func (r *RedisRepo) AcquireLock(ctx context.Context, oid string, ttl time.Duration) (bool, error) {
	key := fmt.Sprintf("orderLock:%s", oid)
	return r.client.SetNX(ctx, key, "1", ttl).Result()
}

func (r *RedisRepo) SaveTPOrderID(ctx context.Context, symbol, orderID string) error {
	key := fmt.Sprintf("tp:order:%s", symbol)
	return r.client.Set(ctx, key, orderID, 0).Err()
}

func (r *RedisRepo) GetTPOrderID(ctx context.Context, symbol string) (string, error) {
	key := fmt.Sprintf("tp:order:%s", symbol)
	val, err := r.client.Get(ctx, key).Result()
	if err != nil {
		return "", err
	}
	return val, nil
}

func (r *RedisRepo) ClearTPOrderID(ctx context.Context, symbol string) error {
	key := fmt.Sprintf("tp:order:%s", symbol)
	return r.client.Del(ctx, key).Err()
}

func (r *RedisRepo) Close() error {
	return r.client.Close()
}
