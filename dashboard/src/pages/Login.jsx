import React, { useState } from 'react';
import { 
  Box, Paper, Typography, TextField, Button, Alert, 
  Container, Avatar, CircularProgress 
} from '@mui/material';
import { LockOutlined } from '@mui/icons-material';

const Login = ({ onLogin }) => {
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });

      const data = await res.json();
      if (data.success) {
        onLogin(data.token);
      } else {
        setError(data.error || '验证失败');
      }
    } catch (err) {
      setError('无法连接到服务器');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Container maxWidth="xs">
      <Box sx={{ mt: 15, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <Avatar sx={{ m: 1, bgcolor: 'secondary.main' }}>
          <LockOutlined />
        </Avatar>
        <Typography component="h1" variant="h5">
          Authenticator 验证
        </Typography>
        <Paper sx={{ mt: 3, p: 4, width: '100%', borderRadius: 2 }}>
          <Box component="form" onSubmit={handleSubmit}>
            <TextField
              margin="normal"
              required
              fullWidth
              label="6位验证码"
              autoFocus
              value={token}
              onChange={(e) => setToken(e.target.value)}
              inputProps={{ maxLength: 6, pattern: '[0-9]*' }}
            />
            {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
            <Button
              type="submit"
              fullWidth
              variant="contained"
              sx={{ mt: 3, mb: 2, height: 45 }}
              disabled={loading || token.length !== 6}
            >
              {loading ? <CircularProgress size={24} /> : '进入系统'}
            </Button>
            <Typography variant="body2" color="text.secondary" align="center">
              请输入您的 Google Authenticator 动态密码
            </Typography>
          </Box>
        </Paper>
      </Box>
    </Container>
  );
};

export default Login;
