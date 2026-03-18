/**
 * In-Memory Store
 * 
 * A Redis-like in-memory storage that replaces Redis for this project.
 * All data is lost on process restart, which is intentional for the
 * take-profit restart strategy.
 * 
 * Features:
 * - Key-value storage with TTL support
 * - Hash storage (hset, hget, hgetall)
 * - Atomic operations (set with NX)
 * - Pipeline support for batch operations
 */

const logger = require('./logger');

class MemoryStore {
  constructor() {
    // Main key-value store
    this.store = new Map();
    // Hash store (for hset/hget operations)
    this.hashStore = new Map();
    // TTL tracking
    this.ttlTimers = new Map();
  }

  /**
   * Set a key-value pair
   * @param {string} key 
   * @param {string|number|object} value 
   * @param {string} mode - 'NX' for only if not exists
   * @param {string} expireMode - 'EX' for seconds, 'PX' for milliseconds
   * @param {number} expireTime 
   * @returns {string|null} 'OK' if set, null if not (for NX mode)
   */
  async set(key, value, mode = null, expireMode = null, expireTime = null) {
    // Handle NX mode (only set if not exists)
    if (mode === 'NX') {
      if (this.store.has(key)) {
        return null;
      }
    }

    // Convert object to string for storage
    const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
    
    this.store.set(key, stringValue);

    // Handle expiration
    if (expireMode && expireTime) {
      this._setExpiry(key, expireMode, expireTime);
    }

    return 'OK';
  }

  /**
   * Get a value by key
   * @param {string} key 
   * @returns {string|null}
   */
  async get(key) {
    const value = this.store.get(key);
    return value !== undefined ? value : null;
  }

  /**
   * Delete a key
   * @param {string} key 
   * @returns {number} 1 if deleted, 0 if not found
   */
  async del(key) {
    // Clear any TTL timer
    this._clearExpiry(key);
    
    const deleted = this.store.delete(key);
    this.hashStore.delete(key);
    
    return deleted ? 1 : 0;
  }

  /**
   * Check if key exists
   * @param {string} key 
   * @returns {number} 1 if exists, 0 if not
   */
  async exists(key) {
    return this.store.has(key) || this.hashStore.has(key) ? 1 : 0;
  }

  /**
   * Set hash field
   * @param {string} key 
   * @param {object|string} fieldOrObj - field name or object of field-value pairs
   * @param {string|number} value - value (if fieldOrObj is a string)
   */
  async hset(key, fieldOrObj, value = null) {
    if (!this.hashStore.has(key)) {
      this.hashStore.set(key, new Map());
    }
    
    const hash = this.hashStore.get(key);
    
    if (typeof fieldOrObj === 'object') {
      // Set multiple fields
      for (const [field, val] of Object.entries(fieldOrObj)) {
        hash.set(field, String(val));
      }
    } else {
      // Set single field
      hash.set(fieldOrObj, String(value));
    }
    
    return 'OK';
  }

  /**
   * Get hash field value
   * @param {string} key 
   * @param {string} field 
   * @returns {string|null}
   */
  async hget(key, field) {
    const hash = this.hashStore.get(key);
    if (!hash) return null;
    return hash.get(field) || null;
  }

  /**
   * Get all hash fields and values
   * @param {string} key 
   * @returns {object}
   */
  async hgetall(key) {
    const hash = this.hashStore.get(key);
    if (!hash) return {};
    
    const result = {};
    for (const [field, value] of hash.entries()) {
      result[field] = value;
    }
    return result;
  }

  /**
   * Delete hash field
   * @param {string} key 
   * @param {string} field 
   * @returns {number} 1 if deleted, 0 if not
   */
  async hdel(key, field) {
    const hash = this.hashStore.get(key);
    if (!hash) return 0;
    
    return hash.delete(field) ? 1 : 0;
  }

  /**
   * Increment by float
   * @param {string} key 
   * @param {number} increment 
   * @returns {string} New value as string
   */
  async incrbyfloat(key, increment) {
    const current = parseFloat(this.store.get(key) || '0');
    const newValue = current + increment;
    this.store.set(key, String(newValue));
    return String(newValue);
  }

  /**
   * Get all keys matching pattern
   * @param {string} pattern - Glob pattern (e.g., "map:*")
   * @returns {string[]}
   */
  async keys(pattern) {
    const regex = this._patternToRegex(pattern);
    const allKeys = [...this.store.keys(), ...this.hashStore.keys()];
    return allKeys.filter(key => regex.test(key));
  }

  /**
   * Set expiration on a key
   * @param {string} key 
   * @param {number} seconds 
   * @returns {number} 1 if set, 0 if key not found
   */
  async expire(key, seconds) {
    if (!this.store.has(key) && !this.hashStore.has(key)) {
      return 0;
    }
    this._setExpiry(key, 'EX', seconds);
    return 1;
  }

  /**
   * Create a pipeline for batch operations
   * @returns {Pipeline}
   */
  pipeline() {
    return new Pipeline(this);
  }

  /**
   * Disconnect (no-op for memory store)
   */
  disconnect() {
    logger.info('[MemoryStore] Disconnect called (no-op for in-memory store)');
  }

  // Private methods

  _setExpiry(key, mode, time) {
    // Clear existing timer
    this._clearExpiry(key);
    
    const ttlMs = mode === 'EX' ? time * 1000 : time;
    
    const timer = setTimeout(() => {
      this.store.delete(key);
      this.hashStore.delete(key);
      this.ttlTimers.delete(key);
    }, ttlMs);
    
    this.ttlTimers.set(key, timer);
  }

  _clearExpiry(key) {
    const timer = this.ttlTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.ttlTimers.delete(key);
    }
  }

  _patternToRegex(pattern) {
    // Convert glob pattern to regex
    const regexStr = pattern
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')
      .replace(/\[!/g, '[^')
      .replace(/\[/g, '[')
      .replace(/\]/g, ']');
    return new RegExp(`^${regexStr}$`);
  }
}

/**
 * Pipeline class for batch operations
 */
class Pipeline {
  constructor(store) {
    this.store = store;
    this.commands = [];
  }

  set(key, value, mode, expireMode, expireTime) {
    this.commands.push(['set', key, value, mode, expireMode, expireTime]);
    return this;
  }

  get(key) {
    this.commands.push(['get', key]);
    return this;
  }

  del(key) {
    this.commands.push(['del', key]);
    return this;
  }

  hset(key, fieldOrObj, value) {
    this.commands.push(['hset', key, fieldOrObj, value]);
    return this;
  }

  hget(key, field) {
    this.commands.push(['hget', key, field]);
    return this;
  }

  hgetall(key) {
    this.commands.push(['hgetall', key]);
    return this;
  }

  expire(key, seconds) {
    this.commands.push(['expire', key, seconds]);
    return this;
  }

  /**
   * Execute all commands in the pipeline
   * @returns {Promise<Array>}
   */
  async exec() {
    const results = [];
    
    for (const cmd of this.commands) {
      const [method, ...args] = cmd;
      
      try {
        const result = await this.store[method](...args);
        results.push([null, result]);
      } catch (error) {
        results.push([error, null]);
      }
    }
    
    return results;
  }
}

// Export singleton instance
module.exports = new MemoryStore();