const OTPAuth = require('otpauth');
const QRCode = require('qrcode');
const jwt = require('jsonwebtoken');
const config = require('config');
const redis = require('./redis');
const logger = require('./logger');

const JWT_SECRET = process.env.JWT_SECRET || 'hypefollow-secret-key-123';
const REDIS_TOTP_KEY = 'admin:totp:secret';

/**
 * Auth Utility for TOTP and JWT
 */
class AuthUtil {
  /**
   * Check if TOTP is configured
   */
  async isConfigured() {
    const secret = await redis.get(REDIS_TOTP_KEY);
    return !!secret;
  }

  /**
   * Generate a new TOTP secret and QR code for setup
   */
  async generateSetupData() {
    const secret = new OTPAuth.Secret({ size: 20 });
    const totp = new OTPAuth.TOTP({
      issuer: 'HypeFollow',
      label: 'Admin',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: secret
    });

    const uri = totp.toString();
    const qrDataUrl = await QRCode.toDataURL(uri);

    return {
      secret: secret.base32,
      uri,
      qrDataUrl
    };
  }

  /**
   * Verify a TOTP token
   * @param {string} token 6-digit code
   * @param {string} secretBase32 base32 encoded secret
   */
  verifyToken(token, secretBase32) {
    const totp = new OTPAuth.TOTP({
      issuer: 'HypeFollow',
      label: 'Admin',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: secretBase32
    });

    // delta: 1 allows for ±30s clock drift
    const delta = totp.validate({ token, window: 1 });
    return delta !== null;
  }

  /**
   * Save secret to Redis
   */
  async saveSecret(secretBase32) {
    await redis.set(REDIS_TOTP_KEY, secretBase32);
    logger.info('TOTP Secret configured and saved to Redis');
  }

  /**
   * Get secret from Redis
   */
  async getSecret() {
    return await redis.get(REDIS_TOTP_KEY);
  }

  /**
   * Generate a JWT for a session
   */
  generateJWT() {
    return jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
  }

  /**
   * Verify a JWT
   */
  verifyJWT(token) {
    try {
      return jwt.verify(token, JWT_SECRET);
    } catch (e) {
      return null;
    }
  }
}

module.exports = new AuthUtil();
