import React, { useState, useEffect } from 'react';
import { 
  Paper, Typography, Box, TextField, Button, Grid, 
  MenuItem, Select, FormControl, InputLabel, Alert,
  CircularProgress, Table, TableBody, TableCell, TableContainer, 
  TableHead, TableRow, IconButton, Chip, Dialog,
  DialogTitle, DialogContent, DialogContentText, DialogActions
} from '@mui/material';
import { Send, Delete, Refresh } from '@mui/icons-material';

const ManualTradePanel = ({ token, supportedCoins = [] }) => {
  // Order Form State
  const [order, setOrder] = useState({
    symbol: '',
    side: 'BUY',
    type: 'LIMIT',
    price: '',
    quantity: ''
  });
  const [executing, setExecuting] = useState(false);
  const [formMsg, setFormMsg] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Open Orders State
  const [openOrders, setOpenOrders] = useState([]);
  const [loadingOrders, setLoadingOrders] = useState(false);

  const fetchOpenOrders = async () => {
    setLoadingOrders(true);
    try {
      const res = await fetch('/api/trade/open-orders', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (Array.isArray(data)) {
        setOpenOrders(data);
      }
    } catch (e) {
      console.error('Failed to fetch open orders', e);
    } finally {
      setLoadingOrders(false);
    }
  };

  useEffect(() => {
    fetchOpenOrders();
    const timer = setInterval(fetchOpenOrders, 30000); // Auto refresh every 30s
    return () => clearInterval(timer);
  }, [token]);

  const handlePlaceOrder = async () => {
    setConfirmOpen(false);
    setExecuting(true);
    setFormMsg(null);
    try {
      const res = await fetch('/api/trade/manual', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(order)
      });
      const data = await res.json();
      if (data.success) {
        setFormMsg({ type: 'success', text: `订单已提交: ${data.order.orderId}` });
        setOrder({ ...order, price: '', quantity: '' });
        fetchOpenOrders();
      } else {
        setFormMsg({ type: 'error', text: data.error });
      }
    } catch (e) {
      setFormMsg({ type: 'error', text: '网络请求失败' });
    } finally {
      setExecuting(false);
    }
  };

  const handleCancelOrder = async (symbol, orderId) => {
    try {
      const res = await fetch('/api/trade/cancel', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ symbol, orderId })
      });
      const data = await res.json();
      if (data.success) {
        fetchOpenOrders();
      }
    } catch (e) {
      console.error('Failed to cancel order', e);
    }
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {/* 1. 下单表单 */}
      <Paper sx={{ p: 3, borderRadius: 2 }}>
        <Typography variant="h6" gutterBottom>手动委托下单</Typography>
        <Box sx={{ mt: 2 }}>
          <Grid container spacing={2} alignItems="center">
            <Grid item xs={12} sm={3}>
              <FormControl fullWidth size="small">
                <InputLabel>币种</InputLabel>
                <Select
                  value={order.symbol}
                  label="币种"
                  onChange={(e) => setOrder({ ...order, symbol: e.target.value })}
                >
                  {supportedCoins.map(coin => (
                    <MenuItem key={coin} value={`${coin}USDT`}>{coin}USDT</MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Grid>
            <Grid item xs={6} sm={2}>
              <FormControl fullWidth size="small">
                <InputLabel>方向</InputLabel>
                <Select
                  value={order.side}
                  label="方向"
                  onChange={(e) => setOrder({ ...order, side: e.target.value })}
                >
                  <MenuItem value="BUY" sx={{ color: 'success.main' }}>买入 / 做多</MenuItem>
                  <MenuItem value="SELL" sx={{ color: 'error.main' }}>卖出 / 做空</MenuItem>
                </Select>
              </FormControl>
            </Grid>
            <Grid item xs={6} sm={2}>
              <FormControl fullWidth size="small">
                <InputLabel>类型</InputLabel>
                <Select
                  value={order.type}
                  label="类型"
                  onChange={(e) => setOrder({ ...order, type: e.target.value })}
                >
                  <MenuItem value="LIMIT">限价委托</MenuItem>
                  <MenuItem value="MARKET">市价委托</MenuItem>
                </Select>
              </FormControl>
            </Grid>
            <Grid item xs={6} sm={2}>
              <TextField
                fullWidth
                size="small"
                label="价格"
                disabled={order.type === 'MARKET'}
                value={order.price}
                onChange={(e) => setOrder({ ...order, price: e.target.value })}
              />
            </Grid>
            <Grid item xs={6} sm={2}>
              <TextField
                fullWidth
                size="small"
                label="数量"
                value={order.quantity}
                onChange={(e) => setOrder({ ...order, quantity: e.target.value })}
              />
            </Grid>
            <Grid item xs={12} sm={1}>
              <Button 
                variant="contained" 
                fullWidth
                color={order.side === 'BUY' ? 'success' : 'error'}
                onClick={() => setConfirmOpen(true)}
                disabled={executing || !order.symbol || !order.quantity || (order.type === 'LIMIT' && !order.price)}
              >
                {executing ? <CircularProgress size={24} color="inherit" /> : <Send />}
              </Button>
            </Grid>
          </Grid>
          {formMsg && <Alert severity={formMsg.type} sx={{ mt: 2 }} onClose={() => setFormMsg(null)}>{formMsg.text}</Alert>}
        </Box>
      </Paper>

      {/* 2. 挂单列表 */}
      <Paper sx={{ borderRadius: 2, overflow: 'hidden' }}>
        <Box sx={{ p: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid', borderColor: 'divider' }}>
          <Typography variant="h6">当前活跃挂单</Typography>
          <IconButton size="small" onClick={fetchOpenOrders} disabled={loadingOrders}>
            <Refresh fontSize="small" className={loadingOrders ? 'spin-animation' : ''} />
          </IconButton>
        </Box>
        <TableContainer sx={{ maxHeight: 300 }}>
          <Table stickyHeader size="small">
            <TableHead>
              <TableRow>
                <TableCell>币种</TableCell>
                <TableCell>方向</TableCell>
                <TableCell align="right">价格</TableCell>
                <TableCell align="right">数量</TableCell>
                <TableCell align="right">已成交</TableCell>
                <TableCell align="center">操作</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {openOrders.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} align="center" sx={{ py: 3, color: 'text.secondary' }}>暂无挂单</TableCell>
                </TableRow>
              ) : (
                openOrders.map((o) => (
                  <TableRow key={o.orderId} hover>
                    <TableCell sx={{ fontWeight: 'bold' }}>{o.symbol}</TableCell>
                    <TableCell>
                      <Chip 
                        size="small" 
                        label={o.side === 'BUY' ? '做多' : '做空'} 
                        color={o.side === 'BUY' ? 'success' : 'error'} 
                        variant="outlined" 
                      />
                    </TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{parseFloat(o.price).toFixed(2)}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{parseFloat(o.origQty).toFixed(3)}</TableCell>
                    <TableCell align="right" sx={{ fontFamily: 'monospace' }}>{parseFloat(o.executedQty).toFixed(3)}</TableCell>
                    <TableCell align="center">
                      <IconButton size="small" color="error" onClick={() => handleCancelOrder(o.symbol, o.orderId)}>
                        <Delete fontSize="small" />
                      </IconButton>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      {/* 二次确认 Dialog */}
      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}>
        <DialogTitle>确认下单</DialogTitle>
        <DialogContent>
          <DialogContentText>
            您即将执行以下操作，请确认：
            <Box sx={{ mt: 2, p: 2, bgcolor: 'action.hover', borderRadius: 1 }}>
              <Typography variant="body2"><b>币种:</b> {order.symbol}</Typography>
              <Typography variant="body2"><b>方向:</b> {order.side === 'BUY' ? '买入/做多' : '卖出/做空'}</Typography>
              <Typography variant="body2"><b>类型:</b> {order.type === 'LIMIT' ? '限价' : '市价'}</Typography>
              {order.type === 'LIMIT' && <Typography variant="body2"><b>价格:</b> {order.price}</Typography>}
              <Typography variant="body2"><b>数量:</b> {order.quantity}</Typography>
            </Box>
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>取消</Button>
          <Button onClick={handlePlaceOrder} color={order.side === 'BUY' ? 'success' : 'error'} variant="contained">
            确认提交
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default ManualTradePanel;
