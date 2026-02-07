const authUtil = require('../utils/auth-util');

/**
 * Authentication Middleware
 */
module.exports = (req, res, next) => {
  // Allow login and status checks
  if (req.path.startsWith('/api/admin/')) {
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization required' });
  }

  const token = authHeader.split(' ')[1];
  const decoded = authUtil.verifyJWT(token);

  if (!decoded) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.user = decoded;
  next();
};
