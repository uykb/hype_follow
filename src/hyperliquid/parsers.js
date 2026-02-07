const logger = require('../utils/logger');

/**
 * Parse Order Update Event - handles array of updates
 * @param {array} data The 'data' payload from the WebSocket message
 * @returns {array} Array of standardized order objects
 */
function parseOrderUpdate(data) {
  // Example payload structure for 'orderUpdates':
  // [ { "order": { "coin": "BTC", "side": "B", "limitPx": "30000", "sz": "1.0", "oid": 123, "status": "open", ... }, "user": "0x..." } ]
  
  if (!Array.isArray(data)) {
    logger.debug('parseOrderUpdate: data is not an array', { data });
    return [];
  }

  const orders = [];
  
  for (const orderEvent of data) {
    if (!orderEvent || !orderEvent.order) {
      logger.debug('parseOrderUpdate: invalid order event structure', { orderEvent });
      continue;
    }

    const order = orderEvent.order;
    const status = order.status ? order.status.toLowerCase() : '';

    // We are interested in 'open', 'canceled', 'filled', 'triggered', 'rejected', 'marginCanceled'
    const monitoredStatuses = ['open', 'canceled', 'filled', 'triggered', 'rejected', 'margincanceled'];
    if (!monitoredStatuses.includes(status)) {
      logger.debug(`parseOrderUpdate: ignoring status '${status}'`, { oid: order.oid });
      continue;
    }

    // Treat 'rejected' and 'marginCanceled' as 'canceled' for synchronization purposes
    let standardizedStatus = status;
    if (status === 'rejected' || status === 'margincanceled') {
      standardizedStatus = 'canceled';
    }

    orders.push({
      type: 'order',
      status: standardizedStatus,
      coin: order.coin,
      side: order.side, // 'B' or 'A'
      limitPx: order.limitPx,
      sz: order.sz,
      oid: order.oid,
      timestamp: order.timestamp,
      reduceOnly: order.reduceOnly || false,
      userAddress: orderEvent.user || null 
    });
  }

  return orders;
}

/**
 * Parse User Fills Event (Market Trades)
 * @param {object} data 
 * @returns {array} Array of standardized fill objects
 */
function parseUserFills(data) {
  // Example payload structure for 'userFills':
  // { "isSnapshot": false, "fills": [ { "coin": "BTC", "px": "30000", "sz": "0.1", "side": "B", "time": 123456, "crossed": true, ... } ] }
  
  // If it's a snapshot (on connection), we usually ignore it to avoid re-trading old history
  if (data.isSnapshot) {
    return [];
  }

  if (!Array.isArray(data.fills)) return [];

  const validFills = [];

  for (const fill of data.fills) {
    // We only care about "crossed: true" which implies the user was the Taker (Active Market Order)
    // "crossed: false" means they were the Maker (Limit Order filled), which is just a fill of a previous order.
    // For "Copy Trading", we typically want to copy their *active* moves (Market Orders).
    // Note: If we copy Limit Orders (via parseOrderUpdate), we don't need to copy the Fill of that Limit Order again via Market Order.
    
    if (fill.crossed === true) {
      validFills.push({
        type: 'fill',
        coin: fill.coin,
        side: fill.side, // 'B' or 'A'
        px: fill.px,
        sz: fill.sz,
        timestamp: fill.time,
        userAddress: data.user || null // UserFills event structure: { isSnapshot: false, user: "0x...", fills: [...] } - Wait, check HL docs. 
        // HL docs: { "type": "userFills", "data": { "isSnapshot": false, "user": "0x...", "fills": [...] } }
        // Yes, 'user' is often at the top level of the data object for userFills.
      });
    }
  }

  return validFills;
}

module.exports = {
  parseOrderUpdate,
  parseUserFills
};
