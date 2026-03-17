const assert = require('assert');
// We need to mock dependencies BEFORE requiring index.js if it uses them at top level
// But index.js requires them. We can use proxyquire or just mock the global state if they are singletons.

// Mocking dependencies
const logger = require('../src/utils/logger');
// Disable actual logging for tests to keep output clean
logger.info = () => {};
logger.error = console.error;
logger.debug = () => {};
logger.warn = () => {};

const orderMapper = require('../src/core/order-mapper');
const binanceClient = require('../src/binance/api-client');
const orderExecutor = require('../src/core/order-executor');
const consistencyEngine = require('../src/core/consistency-engine');

// Save original methods
const originalGetBinanceOrder = orderMapper.getBinanceOrder;
const originalExecuteLimitOrder = orderExecutor.executeLimitOrder;
const originalCancelOrder = binanceClient.cancelOrder;

let executionOrder = [];

// Mock implementations
orderMapper.getBinanceOrder = async (user, oid) => {
    executionOrder.push(`getMapping:${oid}`);
    return null; // Simulate new order
};

orderExecutor.executeLimitOrder = async (orderData) => {
    executionOrder.push(`executeStart:${orderData.oid}`);
    await new Promise(resolve => setTimeout(resolve, 100)); // Make it slow
    executionOrder.push(`executeEnd:${orderData.oid}`);
};

binanceClient.cancelOrder = async (symbol, orderId) => {
    executionOrder.push(`cancel:${orderId}`);
};

const { processOrderEvent } = require('../src/index');

async function testRaceCondition() {
    console.log('=== Starting Race Condition Serialization Test ===\n');

    const user = '0xTestUser';
    const oid = '12345';

    const event1 = {
        userAddress: user,
        oid: oid,
        status: 'open',
        coin: 'HYPE',
        side: 'B',
        sz: '10.0'
    };

    const event2 = {
        userAddress: user,
        oid: oid,
        status: 'canceled',
        coin: 'HYPE'
    };

    console.log('Sending event 1 (open) and event 2 (canceled) rapidly...');
    
    // We need to mock getBinanceOrder to return mapping for event 2 AFTER event 1 "finishes"
    // In our real app, event 1 would save mapping.
    let mappingSaved = false;
    orderMapper.getBinanceOrder = async (u, o) => {
        executionOrder.push(`getMapping:${o}`);
        if (mappingSaved) return { orderId: 'binance_123', symbol: 'HYPEUSDT' };
        return null;
    };
    
    orderExecutor.executeLimitOrder = async (orderData) => {
        executionOrder.push(`executeStart:${orderData.oid}`);
        await new Promise(resolve => setTimeout(resolve, 200)); 
        mappingSaved = true; // Simulate mapping saved at the end of execution
        executionOrder.push(`executeEnd:${orderData.oid}`);
    };

    const p1 = processOrderEvent(event1);
    const p2 = processOrderEvent(event2);

    await Promise.all([p1, p2]);

    console.log('Execution Sequence:', executionOrder);

    // Expected Sequence:
    // 1. getMapping:12345 (for event 1)
    // 2. executeStart:12345
    // 3. executeEnd:12345
    // 4. getMapping:12345 (for event 2)
    // 5. cancel:binance_123

    assert.strictEqual(executionOrder[0], `getMapping:${oid}`, 'Event 1 should start with mapping check');
    assert.strictEqual(executionOrder[1], `executeStart:${oid}`, 'Event 1 should start execution');
    assert.strictEqual(executionOrder[2], `executeEnd:${oid}`, 'Event 1 should finish execution before event 2 starts');
    assert.strictEqual(executionOrder[3], `getMapping:${oid}`, 'Event 2 should check mapping AFTER event 1 finishes');
    assert.strictEqual(executionOrder[4], `cancel:binance_123`, 'Event 2 should cancel the order because mapping exists now');

    console.log('\nPASS: Events were serialized correctly.');
    
    // Restore original methods (not strictly necessary but good practice)
    orderMapper.getBinanceOrder = originalGetBinanceOrder;
    orderExecutor.executeLimitOrder = originalExecuteLimitOrder;
    binanceClient.cancelOrder = originalCancelOrder;
}

testRaceCondition().catch(err => {
    console.error('Test Failed:', err);
    process.exit(1);
});
