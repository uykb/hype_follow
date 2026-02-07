import React, { useState, useEffect } from 'react';
import { 
  Paper, Typography, Box, TextField, Button, Grid, 
  MenuItem, Select, FormControl, InputLabel, Alert,
  CircularProgress, Switch, FormControlLabel
} from '@mui/material';
import { Save } from '@mui/icons-material';

const ConfigPanel = ({ token }) => {
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    fetch('/api/config', {
      headers: { 'Authorization': `Bearer ${token}` }
    })
      .then(res => res.json())
      .then(data => {
        setConfig(data);
        setLoading(false);
      });
  }, [token]);

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch('/api/config/update', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(config)
      });
      const data = await res.json();
      setMessage({ type: 'success', text: data.message });
    } catch (e) {
      setMessage({ type: 'error', text: '保存失败' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <CircularProgress />;

  return (
    <Paper sx={{ p: 3, borderRadius: 2 }}>
      <Typography variant="h6" gutterBottom>系统配置</Typography>
      <Box sx={{ mt: 2 }}>
        <Grid container spacing={3}>
          <Grid item xs={12} md={6}>
            <FormControl fullWidth>
              <InputLabel>交易模式</InputLabel>
              <Select
                value={config.trading.mode}
                label="交易模式"
                onChange={(e) => setConfig({
                  ...config, 
                  trading: { ...config.trading, mode: e.target.value }
                })}
              >
                <MenuItem value="fixed">固定比例 (Fixed)</MenuItem>
                <MenuItem value="equal">等权益比例 (Equal)</MenuItem>
              </Select>
            </FormControl>
          </Grid>
          
          <Grid item xs={12} md={6}>
            <TextField
              fullWidth
              label="固定跟单比例 (Fixed Ratio)"
              type="number"
              value={config.trading.fixedRatio}
              onChange={(e) => setConfig({
                ...config, 
                trading: { ...config.trading, fixedRatio: parseFloat(e.target.value) }
              })}
            />
          </Grid>

          <Grid item xs={12}>
             <Typography variant="subtitle2" color="text.secondary" gutterBottom>
               注意：敏感配置（如 API Key）请通过配置文件或环境变量修改，修改后需重启服务。
             </Typography>
          </Grid>

          <Grid item xs={12}>
            {message && <Alert severity={message.type} sx={{ mb: 2 }}>{message.text}</Alert>}
            <Button 
              variant="contained" 
              startIcon={saving ? <CircularProgress size={20} color="inherit" /> : <Save />}
              onClick={handleSave}
              disabled={saving}
            >
              保存设置
            </Button>
          </Grid>
        </Grid>
      </Box>
    </Paper>
  );
};

export default ConfigPanel;
