import { useState, useEffect } from 'react';

const WS_URL = window.location.origin.replace(/^http/, 'ws');

export const useWebSocket = () => {
  const [snapshot, setSnapshot] = useState(null);
  const [logs, setLogs] = useState([]);
  const [systemData, setSystemData] = useState(null);
  const [connected, setConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(null);

  useEffect(() => {
    let ws;
    let reconnectTimer;

    const connect = () => {
      try {
        ws = new WebSocket(WS_URL);
      } catch (err) {
        console.error('Failed to create WebSocket', err);
        return;
      }

      ws.onopen = () => {
        setConnected(true);
        console.log('Connected to monitor WS');
      };

      ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'snapshot' || msg.type === 'update') {
              setSnapshot(msg.data);
              setLastUpdate(new Date());
            } else if (msg.type === 'logs') {
              setLogs(msg.data);
            } else if (msg.type === 'log') {
              setLogs(prev => [msg.data, ...prev].slice(0, 100));
            } else if (msg.type === 'system') {
              setSystemData(msg.data);
            }
        } catch (e) {
            console.error("Error parsing WS message", e);
        }
      };

      ws.onclose = () => {
        setConnected(false);
        console.log('Monitor WS closed');
        reconnectTimer = setTimeout(connect, 3000);
      };

      ws.onerror = (err) => {
        console.error('WS error', err);
        ws.close();
      };
    };

    connect();

    return () => {
      if (ws) ws.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, []);

  return { snapshot, logs, systemData, connected, lastUpdate };
};
