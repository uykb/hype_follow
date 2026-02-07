import React from 'react';
import { AppBar, Toolbar, Typography, Box, Chip, Button, IconButton, useTheme, useMediaQuery } from '@mui/material';
import { 
  FiberManualRecord as StatusIcon, 
  Error as ErrorIcon, 
  CheckCircle as CheckCircleIcon,
  Menu as MenuIcon 
} from '@mui/icons-material';

const Header = ({ connected, lastUpdate, emergencyStop, onEmergencyToggle, children }) => {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

  return (
    <AppBar position="sticky" color="default" elevation={0}>
      <Toolbar>
        <Typography variant="h6" component="div" sx={{ flexGrow: 1, display: 'flex', alignItems: 'center', fontWeight: 'bold', color: 'primary.main' }}>
          HypeFollow
          <Chip 
            icon={<StatusIcon sx={{ fontSize: '10px !important' }} />} 
            label={connected ? "在线" : "离线"} 
            color={connected ? "success" : "error"} 
            size="small" 
            variant="outlined"
            sx={{ ml: 2, height: 20, fontSize: '0.7rem', borderColor: connected ? 'success.main' : 'error.main' }} 
          />
        </Typography>

        {!isMobile && (
           <Typography variant="caption" sx={{ mr: 2, color: 'text.secondary' }}>
            最后更新: {lastUpdate ? lastUpdate.toLocaleTimeString() : '--:--:--'}
          </Typography>
        )}

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Button 
            color={emergencyStop ? "error" : "success"} 
            variant="contained" 
            size="small"
            startIcon={<ErrorIcon />}
            sx={{ fontWeight: 'bold' }}
            disabled
          >
            {emergencyStop ? "已停止" : "运行中"}
          </Button>
          {children}
        </Box>
      </Toolbar>
    </AppBar>
  );
};

export default Header;
