import React, { useState, useEffect, useMemo } from 'react';
import { 
  Box, 
  Card, 
  CardContent, 
  Grid, 
  Typography, 
  Chip,
  Tooltip,
  IconButton,
  Collapse
} from '@mui/material';
import {
  Memory as MemoryIcon,
  Storage as StorageIcon,
  NetworkCheck as NetworkIcon,
  Speed as SpeedIcon,
  DeviceThermostat as TempIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  Language as LanguageIcon
} from '@mui/icons-material';
import GaugeChart, { BarGauge } from './GaugeChart';

// Color palette inspired by kula
const colors = {
  blue: '#3b82f6',
  cyan: '#06b6d4',
  green: '#10b981',
  yellow: '#f59e0b',
  orange: '#f97316',
  red: '#ef4444',
  purple: '#8b5cf6',
  pink: '#ec4899',
  teal: '#14b8a6'
};

/**
 * Format bytes to human readable
 */
const formatBytes = (bytes) => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

/**
 * Format Mbps
 */
const formatMbps = (mbps) => {
  if (mbps < 1) return `${(mbps * 1000).toFixed(0)} Kbps`;
  return `${mbps.toFixed(2)} Mbps`;
};

/**
 * System Monitor Panel - Displays real-time system metrics
 * Inspired by kula (https://github.com/c0m4r/kula)
 */
const SystemMonitor = ({ systemData }) => {
  const [expanded, setExpanded] = useState(true);

  // Default empty state
  const data = systemData || {
    cpu: { usage: 0, temp: null, cores: 1 },
    memory: { usedPercent: 0, total: 0, used: 0, available: 0, swap: { usedPercent: 0 } },
    load: { load1: 0, load5: 0, load15: 0 },
    network: { interfaces: [] },
    disk: { disks: [], filesystems: [] },
    uptime: { seconds: 0, formatted: '0m' },
    processes: { running: 0, blocked: 0 },
    publicIP: null
  };

  const { cpu, memory, load, network, disk, uptime, processes, publicIP } = data;

  // Calculate total network throughput
  const networkStats = useMemo(() => {
    if (!network?.interfaces) return { rxMbps: 0, txMbps: 0 };
    return network.interfaces.reduce((acc, iface) => ({
      rxMbps: acc.rxMbps + (iface.rxMbps || 0),
      txMbps: acc.txMbps + (iface.txMbps || 0)
    }), { rxMbps: 0, txMbps: 0 });
  }, [network]);

  // Calculate total disk I/O
  const diskStats = useMemo(() => {
    if (!disk?.disks) return { readMbps: 0, writeMbps: 0 };
    return disk.disks.reduce((acc, d) => ({
      readMbps: acc.readMbps + (d.readMbps || 0),
      writeMbps: acc.writeMbps + (d.writeMbps || 0)
    }), { readMbps: 0, writeMbps: 0 });
  }, [disk]);

  return (
    <Card sx={{ mb: 2 }}>
      <CardContent sx={{ p: 2 }}>
        {/* Header */}
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <SpeedIcon color="primary" />
            <Typography variant="h6" fontWeight="bold">
              系统监控
            </Typography>
            <Chip 
              label={`运行时间: ${uptime?.formatted || 'N/A'}`} 
              size="small" 
              variant="outlined"
              sx={{ ml: 1 }}
            />
            {publicIP && publicIP !== 'N/A' && (
              <Tooltip title="公网IP地址">
                <Chip 
                  icon={<LanguageIcon sx={{ fontSize: '14px !important' }} />}
                  label={publicIP} 
                  size="small" 
                  color="info"
                  variant="outlined"
                  sx={{ ml: 0.5 }}
                />
              </Tooltip>
            )}
          </Box>
          <IconButton onClick={() => setExpanded(!expanded)} size="small">
            {expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
          </IconButton>
        </Box>

        <Collapse in={expanded}>
          <Grid container spacing={2}>
            {/* CPU Section */}
            <Grid item xs={12} sm={6} md={3}>
              <Box sx={{ 
                p: 2, 
                borderRadius: 2, 
                bgcolor: 'background.default',
                height: '100%'
              }}>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                  CPU
                </Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                  <GaugeChart 
                    value={cpu?.usage || 0} 
                    max={100} 
                    size={80}
                    strokeWidth={8}
                    label="使用率"
                  />
                  <Box>
                    <Typography variant="h5" fontWeight="bold">
                      {(cpu?.usage || 0).toFixed(1)}%
                    </Typography>
                    {cpu?.temp && (
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.5 }}>
                        <TempIcon sx={{ fontSize: 16, color: cpu.temp > 80 ? colors.red : colors.green }} />
                        <Typography 
                          variant="caption"
                          sx={{ color: cpu.temp > 80 ? colors.red : 'text.secondary' }}
                        >
                          {cpu.temp.toFixed(1)}°C
                        </Typography>
                      </Box>
                    )}
                    <Typography variant="caption" color="text.secondary">
                      {cpu?.cores || 1} 核心
                    </Typography>
                  </Box>
                </Box>
              </Box>
            </Grid>

            {/* Memory Section */}
            <Grid item xs={12} sm={6} md={3}>
              <Box sx={{ 
                p: 2, 
                borderRadius: 2, 
                bgcolor: 'background.default',
                height: '100%'
              }}>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                  内存
                </Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                  <GaugeChart 
                    value={memory?.usedPercent || 0} 
                    max={100} 
                    size={80}
                    strokeWidth={8}
                    colors={[colors.cyan, colors.blue, colors.purple]}
                    label="RAM"
                  />
                  <Box>
                    <Typography variant="h5" fontWeight="bold">
                      {(memory?.usedPercent || 0).toFixed(1)}%
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {formatBytes(memory?.used || 0)} / {formatBytes(memory?.total || 0)}
                    </Typography>
                    {memory?.swap?.usedPercent > 0 && (
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                        Swap: {(memory.swap.usedPercent).toFixed(1)}%
                      </Typography>
                    )}
                  </Box>
                </Box>
              </Box>
            </Grid>

            {/* Load Average Section */}
            <Grid item xs={12} sm={6} md={3}>
              <Box sx={{ 
                p: 2, 
                borderRadius: 2, 
                bgcolor: 'background.default',
                height: '100%'
              }}>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                  系统负载
                </Typography>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Typography variant="body2">1 分钟</Typography>
                    <Typography variant="h6" fontWeight="bold">
                      {(load?.load1 || 0).toFixed(2)}
                    </Typography>
                  </Box>
                  <BarGauge 
                    value={load?.load1 || 0} 
                    max={(cpu?.cores || 1) * 2} 
                    showValue={false}
                    height={6}
                  />
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Typography variant="body2">5 分钟</Typography>
                    <Typography variant="body1">
                      {(load?.load5 || 0).toFixed(2)}
                    </Typography>
                  </Box>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Typography variant="body2">15 分钟</Typography>
                    <Typography variant="body1">
                      {(load?.load15 || 0).toFixed(2)}
                    </Typography>
                  </Box>
                </Box>
              </Box>
            </Grid>

            {/* Network Section */}
            <Grid item xs={12} sm={6} md={3}>
              <Box sx={{ 
                p: 2, 
                borderRadius: 2, 
                bgcolor: 'background.default',
                height: '100%'
              }}>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                  网络
                </Typography>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                  <Box>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                      <Typography variant="caption" color="text.secondary">下载</Typography>
                      <Typography variant="body2" fontWeight="bold" sx={{ color: colors.cyan }}>
                        {formatMbps(networkStats.rxMbps)}
                      </Typography>
                    </Box>
                    <BarGauge 
                      value={networkStats.rxMbps} 
                      max={100} 
                      showValue={false}
                      height={4}
                      colors={[colors.cyan, colors.blue]}
                    />
                  </Box>
                  <Box>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                      <Typography variant="caption" color="text.secondary">上传</Typography>
                      <Typography variant="body2" fontWeight="bold" sx={{ color: colors.pink }}>
                        {formatMbps(networkStats.txMbps)}
                      </Typography>
                    </Box>
                    <BarGauge 
                      value={networkStats.txMbps} 
                      max={100} 
                      showValue={false}
                      height={4}
                      colors={[colors.pink, colors.purple]}
                    />
                  </Box>
                </Box>
              </Box>
            </Grid>

            {/* Disk I/O Section */}
            <Grid item xs={12} sm={6}>
              <Box sx={{ 
                p: 2, 
                borderRadius: 2, 
                bgcolor: 'background.default'
              }}>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                  磁盘 I/O
                </Typography>
                <Grid container spacing={2}>
                  <Grid item xs={6}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <StorageIcon sx={{ color: colors.green }} />
                      <Box>
                        <Typography variant="caption" color="text.secondary">读取</Typography>
                        <Typography variant="body1" fontWeight="bold">
                          {formatMbps(diskStats.readMbps)}
                        </Typography>
                      </Box>
                    </Box>
                  </Grid>
                  <Grid item xs={6}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <StorageIcon sx={{ color: colors.orange }} />
                      <Box>
                        <Typography variant="caption" color="text.secondary">写入</Typography>
                        <Typography variant="body1" fontWeight="bold">
                          {formatMbps(diskStats.writeMbps)}
                        </Typography>
                      </Box>
                    </Box>
                  </Grid>
                </Grid>
                
                {/* Filesystems */}
                {disk?.filesystems?.length > 0 && (
                  <Box sx={{ mt: 2 }}>
                    <Typography variant="caption" color="text.secondary" gutterBottom sx={{ display: 'block' }}>
                      文件系统
                    </Typography>
                    {disk.filesystems.slice(0, 3).map((fs, idx) => (
                      <Box key={idx} sx={{ mb: 1 }}>
                        <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                          <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>
                            {fs.mount}
                          </Typography>
                          <Typography variant="caption">
                            {fs.usedPercent.toFixed(1)}%
                          </Typography>
                        </Box>
                        <BarGauge 
                          value={fs.usedPercent} 
                          max={100} 
                          showValue={false}
                          height={4}
                        />
                      </Box>
                    ))}
                  </Box>
                )}
              </Box>
            </Grid>

            {/* Processes Section */}
            <Grid item xs={12} sm={6}>
              <Box sx={{ 
                p: 2, 
                borderRadius: 2, 
                bgcolor: 'background.default'
              }}>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                  进程状态
                </Typography>
                <Box sx={{ display: 'flex', gap: 2 }}>
                  <Box>
                    <Typography variant="caption" color="text.secondary">运行中</Typography>
                    <Typography variant="h6" fontWeight="bold" sx={{ color: colors.green }}>
                      {processes?.running || 0}
                    </Typography>
                  </Box>
                  <Box>
                    <Typography variant="caption" color="text.secondary">阻塞</Typography>
                    <Typography variant="h6" fontWeight="bold" sx={{ color: processes?.blocked > 0 ? colors.red : 'text.primary' }}>
                      {processes?.blocked || 0}
                    </Typography>
                  </Box>
                </Box>
              </Box>
            </Grid>
          </Grid>
        </Collapse>
      </CardContent>
    </Card>
  );
};

export default SystemMonitor;