import React from 'react';
import { ThemeProvider, CssBaseline, Container, Grid, Box, Typography, CircularProgress } from '@mui/material';
import { TrendingUp, Speed, AccountBalance, CheckCircle } from '@mui/icons-material';

import theme from './theme/theme';
import { useWebSocket } from './hooks/useWebSocket';

import Header from './components/Header';
import StatCard from './components/StatCard';
import PositionsList from './components/PositionsList';
import OrderMappings from './components/OrderMappings';
import FollowedUsers from './components/FollowedUsers';
import LogsPanel from './components/LogsPanel';
import EquityChart from './components/EquityChart';
import TradeHistory from './components/TradeHistory';

function App() {
  const { snapshot, logs, connected, lastUpdate } = useWebSocket();

  if (!snapshot) {
    return (
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', flexDirection: 'column', bgcolor: 'background.default', p: 3 }}>
          <CircularProgress size={60} thickness={4} />
          <Typography variant="h6" sx={{ mt: 3, color: 'text.secondary' }}>HypeFollow 系统连接中...</Typography>
          <Typography variant="body2" sx={{ mt: 1, color: 'text.secondary', textAlign: 'center' }}>
            如果长时间停留在此页面，请尝试强制刷新 (Ctrl+F5) 或检查后端日志。
          </Typography>
        </Box>
      </ThemeProvider>
    );
  }

  const { stats, accounts, drifts, mappings, config, history } = snapshot;

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box sx={{ minHeight: '100vh', pb: 4, bgcolor: 'background.default' }}>
        <Header 
            connected={connected} 
            lastUpdate={lastUpdate} 
            emergencyStop={config.emergencyStop} 
        />

        <Container maxWidth="xl" sx={{ mt: 3 }}>
          {/* Top Stats Row */}
          <Grid container spacing={2} sx={{ mb: 3 }}>
            <Grid item xs={6} sm={6} md={3}>
              <StatCard title="总订单数" value={stats.totalOrders} icon={<TrendingUp />} color="primary" />
            </Grid>
            <Grid item xs={6} sm={6} md={3}>
              <StatCard title="总成交数" value={stats.totalFills} icon={<Speed />} color="info" />
            </Grid>
            <Grid item xs={6} sm={6} md={3}>
              <StatCard title="币安权益" value={`$${accounts.binance.equity.toFixed(2)}`} icon={<AccountBalance />} color="warning" />
            </Grid>
            <Grid item xs={6} sm={6} md={3}>
              <StatCard 
                title="系统运行时间" 
                value={`${Math.floor(stats.uptime / 3600)}小时 ${Math.floor((stats.uptime % 3600) / 60)}分`} 
                icon={<CheckCircle />} 
                color="secondary" 
              />
            </Grid>
          </Grid>

          <Grid container spacing={3}>
            {/* Main Content Area */}
            <Grid item xs={12} lg={8}>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <EquityChart data={history?.equity || []} />
                <PositionsList positions={accounts.binance.positions} drifts={drifts} />
                <Grid container spacing={3}>
                  <Grid item xs={12} md={6}>
                    <OrderMappings mappings={mappings} />
                  </Grid>
                  <Grid item xs={12} md={6}>
                    <TradeHistory trades={history?.trades || []} />
                  </Grid>
                </Grid>
              </Box>
            </Grid>

            {/* Sidebar Area */}
            <Grid item xs={12} lg={4}>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <FollowedUsers accounts={accounts} mode={config.mode} />
                <LogsPanel logs={logs} />
              </Box>
            </Grid>
          </Grid>
        </Container>
      </Box>
    </ThemeProvider>
  );
}

export default App;
