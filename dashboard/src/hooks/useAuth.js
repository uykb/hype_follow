import { useState, useEffect, useCallback } from 'react';

export const useAuth = () => {
  const [token, setToken] = useState(localStorage.getItem('hf_token'));
  const [isConfigured, setIsConfigured] = useState(true);

  const checkStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/status');
      const data = await res.json();
      setIsConfigured(data.configured);
    } catch (e) {
      console.error('Failed to check auth status', e);
    }
  }, []);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  const login = (newToken) => {
    localStorage.setItem('hf_token', newToken);
    setToken(newToken);
  };

  const logout = () => {
    localStorage.removeItem('hf_token');
    setToken(null);
  };

  return { token, isConfigured, login, logout, checkStatus };
};
