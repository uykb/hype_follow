const assert = require('assert');
const orderValidator = require('../src/core/order-validator');
const orderMapper = require('../src/core/order-mapper');
const redis = require('../src/utils/redis');

async function runTests() {
  console.log('=== Starting Order Validation Tests ===\n');

  // Setup mock mapping
  const testUser = '0x1234567890123456789012345678901234567890';
  const testOid = 'test_hl_oid_999';
  const testBinanceId = '888888';
  console.log(`Setting up test mapping: ${testUser}:${testOid} -> ${testBinanceId}`);
  await orderMapper.saveMapping(testUser, testOid, testBinanceId, 'HYPEUSDT');

  // Test 1: Mapper support for timestamps
  console.log('Test 1: Mapper timestamp support');
  const ts = await orderMapper.getOrderTimestamp(testUser, testOid);
  assert.notStrictEqual(ts, null);
  console.log(`Found timestamp: ${ts} - PASS\n`);

  // Test 2: Validation logic (Mocking binance check)
  console.log('Test 2: Validation report');
  const report = await orderValidator.getReport();
  assert.strictEqual(report.activeCount >= 1, true);
  console.log(`Report active count: ${report.activeCount} - PASS\n`);

  // Cleanup
  await orderMapper.deleteMapping(testUser, testOid);
  console.log('Cleanup complete.');

  console.log('=== All Order Validation Tests Passed ===');
  process.exit(0);
}

runTests().catch(err => {
  console.error('Test Failed:', err);
  process.exit(1);
});
