const redis = require('../src/utils/redis');
const logger = require('../src/utils/logger');

async function resetAuth() {
  console.log('--- HypeFollow Auth Reset Tool ---');
  try {
    const exists = await redis.exists('admin:totp:secret');
    if (!exists) {
      console.log('No TOTP configuration found. System is already in setup mode.');
      process.exit(0);
    }
    
    await redis.del('admin:totp:secret');
    console.log('SUCCESS: TOTP configuration has been cleared.');
    console.log('Please refresh your browser to perform the initial setup again.');
  } catch (err) {
    console.error('FAILED to reset auth:', err.message);
  } finally {
    process.exit(0);
  }
}

resetAuth();
