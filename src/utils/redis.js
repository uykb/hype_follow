const Redis = require('ioredis');
const config = require('config');
const logger = require('./logger');

const redisConfig = config.get('redis');

const redis = new Redis({
  host: redisConfig.host,
  port: redisConfig.port,
  password: redisConfig.password,
  maxRetriesPerRequest: null, // Disable the max retries limit to allow infinite retries during startup
  retryStrategy: (times) => {
    // Linear backoff: 50ms, 100ms, 150ms... up to 2000ms
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  reconnectOnError: (err) => {
    const targetError = 'READONLY';
    if (err.message.includes(targetError)) {
      // Only reconnect when the error contains "READONLY"
      return true;
    }
    return false;
  }
});

redis.on('connect', () => {
  logger.info('Connected to Redis');
});

redis.on('error', (err) => {
  logger.error('Redis connection error', err);
});

module.exports = redis;
