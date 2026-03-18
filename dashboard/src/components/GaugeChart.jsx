import React from 'react';
import { Box, Typography } from '@mui/material';

/**
 * SVG Gauge Chart component inspired by kula
 * Displays a circular gauge with animated fill
 */
const GaugeChart = ({ 
  value, 
  max = 100, 
  label, 
  unit = '%',
  size = 120,
  strokeWidth = 8,
  colors = ['#10b981', '#f59e0b', '#ef4444'], // green -> yellow -> red
  showValue = true,
  fontSize = '0.875rem'
}) => {
  const percentage = Math.min((value / max) * 100, 100);
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percentage / 100) * circumference;
  
  // Calculate color based on percentage
  const getColor = () => {
    if (percentage < 50) return colors[0];
    if (percentage < 80) return colors[1];
    return colors[2];
  };

  const color = getColor();
  const center = size / 2;

  return (
    <Box sx={{ 
      display: 'flex', 
      flexDirection: 'column', 
      alignItems: 'center',
      position: 'relative'
    }}>
      <svg 
        width={size} 
        height={size} 
        viewBox={`0 0 ${size} ${size}`}
        style={{ transform: 'rotate(-90deg)' }}
      >
        {/* Background circle */}
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="rgba(255, 255, 255, 0.1)"
          strokeWidth={strokeWidth}
        />
        {/* Progress circle */}
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{
            transition: 'stroke-dashoffset 0.3s ease-out, stroke 0.3s ease-out'
          }}
        />
      </svg>
      
      {/* Center value */}
      {showValue && (
        <Box sx={{ 
          position: 'absolute', 
          top: '50%', 
          left: '50%', 
          transform: 'translate(-50%, -50%)',
          textAlign: 'center'
        }}>
          <Typography 
            variant="body2" 
            sx={{ 
              fontWeight: 'bold', 
              fontSize,
              color: 'text.primary'
            }}
          >
            {value.toFixed(1)}{unit}
          </Typography>
        </Box>
      )}
      
      {/* Label */}
      {label && (
        <Typography 
          variant="caption" 
          sx={{ 
            mt: 0.5, 
            color: 'text.secondary',
            fontSize: '0.75rem'
          }}
        >
          {label}
        </Typography>
      )}
    </Box>
  );
};

/**
 * Bar Gauge component for horizontal progress bars
 */
export const BarGauge = ({ 
  value, 
  max = 100, 
  label,
  colors = ['#10b981', '#f59e0b', '#ef4444'],
  height = 8,
  showValue = true,
  unit = '%'
}) => {
  const percentage = Math.min((value / max) * 100, 100);
  
  const getColor = () => {
    if (percentage < 50) return colors[0];
    if (percentage < 80) return colors[1];
    return colors[2];
  };

  return (
    <Box sx={{ width: '100%' }}>
      {label && (
        <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
          <Typography variant="caption" color="text.secondary">
            {label}
          </Typography>
          {showValue && (
            <Typography variant="caption" color="text.secondary">
              {value.toFixed(1)}{unit}
            </Typography>
          )}
        </Box>
      )}
      <Box 
        sx={{ 
          width: '100%', 
          height, 
          bgcolor: 'rgba(255, 255, 255, 0.1)',
          borderRadius: 1,
          overflow: 'hidden'
        }}
      >
        <Box
          sx={{
            width: `${percentage}%`,
            height: '100%',
            bgcolor: getColor(),
            borderRadius: 1,
            transition: 'width 0.3s ease-out, background-color 0.3s ease-out'
          }}
        />
      </Box>
    </Box>
  );
};

/**
 * Mini stat card with gauge
 */
export const MiniGaugeCard = ({ title, value, max = 100, unit = '%', icon, color = 'primary' }) => {
  return (
    <Box 
      sx={{ 
        p: 1.5, 
        borderRadius: 2, 
        bgcolor: 'background.paper',
        border: 1,
        borderColor: 'divider',
        display: 'flex',
        alignItems: 'center',
        gap: 1.5
      }}
    >
      <GaugeChart 
        value={value} 
        max={max} 
        unit={unit}
        size={60}
        strokeWidth={6}
        showValue
        fontSize="0.75rem"
      />
      <Box>
        <Typography variant="caption" color="text.secondary">
          {title}
        </Typography>
        <Typography variant="h6" fontWeight="bold">
          {value.toFixed(1)}{unit}
        </Typography>
      </Box>
    </Box>
  );
};

export default GaugeChart;