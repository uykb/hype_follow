import React, { useState, useEffect } from 'react';
import { 
  Box, Paper, Typography, TextField, Button, Alert, 
  Container, Avatar, CircularProgress, Divider
} from '@mui/material';
import { SettingsSuggest } from '@mui/icons-material';
import { QRCodeSVG } from 'qrcode.react';

const Setup = ({ onComplete }) => {
  const [setupData, setSetupData] = useState(null);
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/admin/setup-qr')
      .then(res => res.json())
      .then(data => setSetupData(data))
      .catch(err => setError('加载配置信息失败'));
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/admin/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, secret: setupData.secret })
      });

      const data = await res.json();
      if (data.success) {
        onComplete(data.token);
      } else {
        setError(data.error || '验证失败');
      }
    } catch (err) {
      setError('无法连接到服务器');
    } finally {
      setLoading(false);
    }
  };

  if (!setupData) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', mt: 20 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Container maxWidth="sm">
      <Box sx={{ mt: 10, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <Avatar sx={{ m: 1, bgcolor: 'primary.main' }}>
          <SettingsSuggest />
        </Avatar>
        <Typography component="h1" variant="h5">
          首次启动：安全配置
        </Typography>
        
        <Paper sx={{ mt: 3, p: 4, width: '100%', borderRadius: 2, textAlign: 'center' }}>
          <Typography variant="body1" sx={{ mb: 3 }}>
            请使用 Google Authenticator 或 1Password 扫描下方二维码进行绑定
          </Typography>
          
          <Box sx={{ bgcolor: 'white', p: 2, display: 'inline-block', borderRadius: 2, mb: 3 }}>
            <QRCodeSVG value={setupData.uri} size={200} />
          </Box>
          
          <Box sx={{ textAlign: 'left', mb: 3 }}>
            <Typography variant="caption" color="text.secondary">手动输入密钥:</Typography>
            <Typography variant="body2" sx={{ fontFamily: 'monospace', bgcolor: 'action.hover', p: 1, borderRadius: 1 }}>
              {setupData.secret}
            </Typography>
          </Box>

          <Divider sx={{ mb: 3 }} />

          <Box component="form" onSubmit={handleSubmit}>
            <TextField
              margin="normal"
              required
              fullWidth
              label="请输入生成的6位验证码"
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
              sx={{ mt: 3, height: 45 }}
              disabled={loading || token.length !== 6}
            >
              {loading ? <CircularProgress size={24} /> : '完成绑定并登录'}
            </Button>
          </Box>
        </Paper>
      </Box>
    </Container>
  );
};

export default Setup;
